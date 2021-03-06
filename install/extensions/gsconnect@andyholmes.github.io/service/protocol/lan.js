'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Core = imports.service.protocol.core;


/**
 * TCP Port Constants
 */
const DEFAULT_PORT = 1716;
const TRANSFER_MIN = 1739;
const TRANSFER_MAX = 1764;


/**
 * One-time check for Linux/FreeBSD socket options
 */
var _LINUX_SOCKETS = false;

try {
    // This should throw on FreeBSD
    // https://github.com/freebsd/freebsd/blob/master/sys/netinet/tcp.h#L159
    new Gio.Socket({
        family: Gio.SocketFamily.IPV4,
        protocol: Gio.SocketProtocol.TCP,
        type: Gio.SocketType.STREAM
    }).get_option(6, 5);

    // Otherwise we can use Linux socket options
    _LINUX_SOCKETS = true;
} catch (e) {
    _LINUX_SOCKETS = false;
}


/**
 * Lan.ChannelService consists of two parts.
 *
 * The TCP Listener listens on a port and constructs a Channel object from the
 * incoming Gio.TcpConnection.
 *
 * The UDP Listener listens on a port for incoming JSON identity packets which
 * include the TCP port for connections, while the IP address is taken from the
 * UDP packet itself. We respond to incoming packets by opening a TCP connection
 * and broadcast outgoing packets to 255.255.255.255.
 */
var ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectLanChannelService',
    Implements: [Core.ChannelService],
    Properties: {
        'name': GObject.ParamSpec.override('name', Core.ChannelService),
        'port': GObject.ParamSpec.uint(
            'port',
            'Port',
            'The port used by the service',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            0,  GLib.MAXUINT16,
            DEFAULT_PORT
        )
    }
}, class LanChannelService extends GObject.Object {

    _init(params) {
        super._init(params);

        // Track hosts we identify to directly, allowing them to ignore the
        // discoverable state of the service.
        this._allowed = new Set();

        //
        this._tcp = null;
        this._udp4 = null;
        this._udp6 = null;

        // Monitor network status
        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkAvailable = false;
        this._networkChangedId = 0;

        // Ensure a certificate exists
        this._initCertificate();
    }

    get certificate() {
        return this._certificate;
    }

    get channels() {
        if (this._channels === undefined) {
            this._channels = new Map();
        }

        return this._channels;
    }

    get name() {
        return 'lan';
    }

    get port() {
        if (this._port === undefined) {
            this._port = DEFAULT_PORT;
        }

        return this._port;
    }

    set port(port) {
        if (this.port !== port) {
            this._port = port;
            this.notify('port');
        }
    }

    _onNetworkChanged(monitor, network_available) {
        if (this._networkAvailable !== network_available) {
            this._networkAvailable = network_available;
            this.broadcast();
        }
    }

    _initCertificate() {
        let certPath = GLib.build_filenamev([
            gsconnect.configdir,
            'certificate.pem'
        ]);
        let keyPath = GLib.build_filenamev([
            gsconnect.configdir,
            'private.pem'
        ]);

        // Ensure a certificate exists with our id as the common name
        this._certificate = Gio.TlsCertificate.new_for_paths(
            certPath,
            keyPath,
            this.service.id
        );

        // If the service id doesn't match the common name, this is probably a
        // certificate from an earlier version and we need to set it now
        if (this.service.settings.get_string('id') !== this._certificate.common_name) {
            this.service.settings.set_string('id', this._certificate.common_name);
        }
    }

    _initTcpListener() {
        this._tcp = new Gio.SocketService();
        this._tcp.add_inet_port(this.port, null);

        this._tcp.connect('incoming', this._onIncomingChannel.bind(this));
    }

    async _onIncomingChannel(listener, connection) {
        try {
            let host = connection.get_remote_address().address.to_string();

            // Decide whether we should try to accept this connection
            if (!this._allowed.has(host) && !this.service.discoverable) {
                connection.close_async(0, null, null);
                return;
            }

            // Create a channel
            let channel = new Channel({
                backend: this,
                certificate: this.certificate,
                host: host,
                port: DEFAULT_PORT
            });

            // Accept the connection
            await channel.accept(connection);
            channel.identity.body.tcpHost = channel.host;
            channel.identity.body.tcpPort = DEFAULT_PORT;

            this.channel(channel);
        } catch (e) {
            debug(e);
        }
    }

    _initUdpListener() {
        // Default broadcast address
        this._udp_address = Gio.InetSocketAddress.new_from_string(
            '255.255.255.255',
            this.port
        );

        try {
            this._udp6 = new Gio.Socket({
                family: Gio.SocketFamily.IPV6,
                type: Gio.SocketType.DATAGRAM,
                protocol: Gio.SocketProtocol.UDP,
                broadcast: true
            });
            this._udp6.init(null);

            // Bind the socket
            let inetAddr = Gio.InetAddress.new_any(Gio.SocketFamily.IPV6);
            let sockAddr = Gio.InetSocketAddress.new(inetAddr, this.port);
            this._udp6.bind(sockAddr, false);

            // Input stream
            this._udp6_stream = new Gio.DataInputStream({
                base_stream: new Gio.UnixInputStream({
                    fd: this._udp6.fd,
                    close_fd: false
                })
            });

            // Watch socket for incoming packets
            this._udp6_source = this._udp6.create_source(GLib.IOCondition.IN, null);
            this._udp6_source.set_callback(this._onIncomingIdentity.bind(this, this._udp6));
            this._udp6_source.attach(null);
        } catch (e) {
            this._udp6 = null;
        }

        // Our IPv6 socket also supports IPv4; we're all done
        if (this._udp6 && this._udp6.speaks_ipv4()) {
            this._udp4 = null;
            return;
        }

        try {
            this._udp4 = new Gio.Socket({
                family: Gio.SocketFamily.IPV4,
                type: Gio.SocketType.DATAGRAM,
                protocol: Gio.SocketProtocol.UDP,
                broadcast: true
            });
            this._udp4.init(null);

            // Bind the socket
            let inetAddr = Gio.InetAddress.new_any(Gio.SocketFamily.IPV4);
            let sockAddr = Gio.InetSocketAddress.new(inetAddr, this.port);
            this._udp4.bind(sockAddr, false);

            // Input stream
            this._udp4_stream = new Gio.DataInputStream({
                base_stream: new Gio.UnixInputStream({
                    fd: this._udp4.fd,
                    close_fd: false
                })
            });

            // Watch input socket for incoming packets
            this._udp4_source = this._udp4.create_source(GLib.IOCondition.IN, null);
            this._udp4_source.set_callback(this._onIncomingIdentity.bind(this, this._udp4));
            this._udp4_source.attach(null);
        } catch (e) {
            this._udp4 = null;

            // We failed to get either an IPv4 or IPv6 socket to bind
            if (this._udp6 === null) {
                e.name = 'LanError';
                throw e;
            }
        }
    }

    _onIncomingIdentity(socket) {
        let host, data, packet;

        // Try to peek the remote address
        try {
            host = socket.receive_message(
                [],
                Gio.SocketMsgFlags.PEEK,
                null
            )[1].address.to_string();
        } catch (e) {
            logError(e);
        }

        // Whether or not we peeked the address, we need to read the packet
        try {
            if (socket === this._udp6) {
                data = this._udp6_stream.read_line_utf8(null)[0];
            } else {
                data = this._udp4_stream.read_line_utf8(null)[0];
            }

            // Only process the packet if we succeeded in peeking the address
            if (host !== undefined) {
                packet = new Core.Packet(data);
                packet.body.tcpHost = host;
                this._onIdentity(packet);
            }
        } catch (e) {
            logError(e);
        }

        return GLib.SOURCE_CONTINUE;
    }

    async _onIdentity(packet) {
        try {
            // Bail if the deviceId is missing
            if (!packet.body.hasOwnProperty('deviceId')) {
                debug(`${packet.body.deviceName}: missing deviceId`);
                return;
            }

            // Silently ignore our own broadcasts
            if (packet.body.deviceId === this.service.identity.body.deviceId) {
                return;
            }

            debug(packet);

            // Create a new channel
            let channel = new Channel({
                backend: this,
                certificate: this.certificate,
                host: packet.body.tcpHost,
                port: packet.body.tcpPort,
                identity: packet
            });

            // Check if channel is already open with this address
            if (this.channels.has(channel.address)) {
                return;
            } else {
                this.channels.set(channel.address, channel);
            }

            // Open a TCP connection
            let connection = await new Promise((resolve, reject) => {
                let address = Gio.InetSocketAddress.new_from_string(
                    packet.body.tcpHost,
                    packet.body.tcpPort
                );
                let client = new Gio.SocketClient({enable_proxy: false});

                client.connect_async(address, null, (client, res) => {
                    try {
                        resolve(client.connect_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            // Connect the channel and attach it to the device on success
            await channel.open(connection);

            this.channel(channel);
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Broadcast an identity packet
     *
     * If @address is not %null it may specify an IPv4 or IPv6 address to send
     * the identity packet directly to, otherwise it will be broadcast to the
     * default address, 255.255.255.255.
     *
     * @param {string} [address] - An optional target IPv4 or IPv6 address
     */
    broadcast(address = null) {
        try {
            if (!this._networkAvailable) {
                return;
            }

            // Try to parse strings as <host>:<port>
            if (typeof address === 'string') {
                let [host, port] = address.split(':');
                port = parseInt(port) || DEFAULT_PORT;
                address = Gio.InetSocketAddress.new_from_string(host, port);
            }

            // If we succeed, remember this host
            if (address instanceof Gio.InetSocketAddress) {
                this._allowed.add(address.address.to_string());

            // Broadcast to the network if no address is specified
            } else {
                debug('Broadcasting to LAN');
                address = this._udp_address;
            }

            // Set the tcpPort before broadcasting
            this.service.identity.body.tcpPort = this.port;

            if (this._udp6 !== null) {
                this._udp6.send_to(address, `${this.service.identity}`, null);
            }

            if (this._udp4 !== null) {
                this._udp4.send_to(address, `${this.service.identity}`, null);
            }
        } catch (e) {
            debug(e, address);
        } finally {
            this.service.identity.body.tcpPort = undefined;
        }
    }

    start() {
        // Start TCP/UDP listeners
        if (this._udp4 === null && this._udp6 === null) {
            this._initUdpListener();
        }

        if (this._tcp === null) {
            this._initTcpListener();
        }

        // Monitor network changes
        if (this._networkChangedId === 0) {
            this._networkAvailable = this._networkMonitor.network_available;
            this._networkChangedId = this._networkMonitor.connect(
                'network-changed',
                this._onNetworkChanged.bind(this)
            );
        }
    }

    stop() {
        if (this._networkChangedId) {
            this._networkMonitor.disconnect(this._networkChangedId);
            this._networkChangedId = 0;
            this._networkAvailable = false;
        }

        if (this._tcp !== null) {
            this._tcp.stop();
            this._tcp.close();
            this._tcp = null;
        }

        if (this._udp6 !== null) {
            this._udp6_source.destroy();
            this._udp6_stream.close(null);
            this._udp6.close();
            this._udp6 = null;
        }

        if (this._udp4 !== null) {
            this._udp4_source.destroy();
            this._udp4_stream.close(null);
            this._udp4.close();
            this._udp4 = null;
        }
    }

    destroy() {
        try {
            this.stop();
        } catch (e) {
            debug(e);
        }
    }
});


/**
 * Lan Channel
 *
 * This class essentially just extends Core.Channel to set TCP socket options
 * and negotiate TLS encrypted connections.
 */
var Channel = GObject.registerClass({
    GTypeName: 'GSConnectLanChannel',
    Implements: [Core.Channel]
}, class LanChannel extends GObject.Object {

    _init(params) {
        super._init();
        Object.assign(this, params);
    }

    get address() {
        return `lan://${this.host}:${this.port}`;
    }

    get certificate() {
        return this._certificate || null;
    }

    set certificate(certificate) {
        this._certificate = certificate;
    }

    get peer_certificate() {
        if (this._connection instanceof Gio.TlsConnection) {
            return this._connection.get_peer_certificate();
        }

        return null;
    }

    get host() {
        if (this._host === undefined) {
            this._host = null;
        }

        return this._host;
    }

    set host(host) {
        this._host = host;
    }

    get port() {
        if (this._port === undefined) {
            if (this.identity && this.identity.body.tcpPort) {
                this._port = this.identity.body.tcpPort;
            } else {
                return DEFAULT_PORT;
            }
        }

        return this._port;
    }

    set port(port) {
        this._port = port;
    }

    _initSocket(connection) {
        connection.socket.set_keepalive(true);

        if (_LINUX_SOCKETS) {
            connection.socket.set_option(6, 4, 10); // TCP_KEEPIDLE
            connection.socket.set_option(6, 5, 5);  // TCP_KEEPINTVL
            connection.socket.set_option(6, 6, 3);  // TCP_KEEPCNT
        } else {
            connection.socket.set_option(6, 256, 10); // TCP_KEEPIDLE
            connection.socket.set_option(6, 512, 5);  // TCP_KEEPINTVL
            connection.socket.set_option(6, 1024, 3); // TCP_KEEPCNT
        }

        return connection;
    }

    /**
     * Handshake Gio.TlsConnection
     */
    _handshake(connection) {
        return new Promise((resolve, reject) => {
            connection.validation_flags = Gio.TlsCertificateFlags.EXPIRED;
            connection.authentication_mode = Gio.TlsAuthenticationMode.REQUIRED;

            connection.handshake_async(
                GLib.PRIORITY_DEFAULT,
                this.cancellable,
                (connection, res) => {
                    try {
                        resolve(connection.handshake_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    async _authenticate(connection) {
        // Standard TLS Handshake
        await this._handshake(connection);

        // Try to find a certificate for this deviceId
        let cert_pem;

        if (this.device) {
            cert_pem = this.device.settings.get_string('certificate-pem');
        } else {
            let id = this.identity.body.deviceId;
            let settings = new Gio.Settings({
                settings_schema: gsconnect.gschema.lookup(
                    'org.gnome.Shell.Extensions.GSConnect.Device',
                    true
                ),
                path: `/org/gnome/shell/extensions/gsconnect/device/${id}/`
            });
            cert_pem = settings.get_string('certificate-pem');
        }

        // If we have a certificate for this deviceId, we can verify it
        if (cert_pem !== '') {
            let certificate = Gio.TlsCertificate.new_from_pem(cert_pem, -1);
            let valid = certificate.is_same(connection.peer_certificate);

            // This is a fraudulent certificate; notify the user
            if (!valid) {
                let error = new Error();
                error.name = 'AuthenticationError';
                error.deviceName = this.identity.body.deviceName;
                error.deviceHost = connection.base_io_stream.get_remote_address().address.to_string();
                this.service.notify_error(error);

                throw error;
            }
        }

        return connection;
    }

    /**
     * Wrap the connection in Gio.TlsClientConnection and initiate handshake
     *
     * @param {Gio.TcpConnection} connection - The unauthenticated connection
     * @return {Gio.TlsServerConnection} - The authenticated connection
     */
    _clientEncryption(connection) {
        connection = Gio.TlsClientConnection.new(
            connection,
            connection.socket.remote_address
        );
        connection.set_certificate(this.certificate);

        return this._authenticate(connection);
    }

    /**
     * Wrap the connection in Gio.TlsServerConnection and initiate handshake
     *
     * @param {Gio.TcpConnection} connection - The unauthenticated connection
     * @return {Gio.TlsServerConnection} - The authenticated connection
     */
    _serverEncryption(connection) {
        connection = Gio.TlsServerConnection.new(connection, this.certificate);

        // We're the server so we trust-on-first-use and verify after
        let _id = connection.connect('accept-certificate', (connection) => {
            connection.disconnect(_id);
            return true;
        });

        return this._authenticate(connection);
    }

    /**
     * Read the identity packet from the new connection
     *
     * @param {Gio.SocketConnection} connection - An unencrypted socket
     * @return {Gio.SocketConnection} - The connection after success
     */
    _receiveIdent(connection) {
        return new Promise((resolve, reject) => {
            let stream = new Gio.DataInputStream({
                base_stream: connection.input_stream,
                close_base_stream: false
            });

            stream.read_line_async(
                GLib.PRIORITY_DEFAULT,
                this.cancellable,
                (stream, res) => {
                    try {
                        let data = stream.read_line_finish_utf8(res)[0];
                        stream.close(null);

                        // Store the identity as an object property
                        this.identity = new Core.Packet(data);

                        // Reject connections without a deviceId
                        if (!this.identity.body.deviceId) {
                            throw new Error('missing deviceId');
                        }

                        resolve(connection);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * Write our identity packet to the new connection
     *
     * @param {Gio.SocketConnection} connection - An unencrypted socket
     * @return {Gio.SocketConnection} - The connection after success
     */
    _sendIdent(connection) {
        return new Promise((resolve, reject) => {
            this.service.identity.body.tcpPort = this.backend.port;

            connection.output_stream.write_all_async(
                `${this.service.identity}`,
                GLib.PRIORITY_DEFAULT,
                this.cancellable,
                (stream, res) => {
                    try {
                        this.service.identity.body.tcpPort = undefined;

                        stream.write_all_finish(res);
                        resolve(connection);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * Negotiate an incoming connection
     *
     * @param {Gio.TcpConnection} connection - The incoming connection
     */
    async accept(connection) {
        try {
            debug(`${this.address} (${this.uuid})`);
            this.backend.channels.set(this.address, this);

            this._connection = this._initSocket(connection);
            this._connection = await this._receiveIdent(this._connection);
            this._connection = await this._clientEncryption(this._connection);
        } catch (e) {
            this.close();
            return Promise.reject(e);
        }
    }

    /**
     * Negotiate an outgoing connection
     *
     * @param {Gio.SocketConnection} connection - The remote connection
     */
    async open(connection) {
        try {
            debug(`${this.address} (${this.uuid})`);
            this.backend.channels.set(this.address, this);

            this._connection = this._initSocket(connection);
            this._connection = await this._sendIdent(this._connection);
            this._connection = await this._serverEncryption(this._connection);
        } catch (e) {
            this.close();
            return Promise.reject(e);
        }
    }

    /**
     * Close all streams associated with this channel, silencing any errors
     */
    close() {
        if (this._closed === undefined) {
            debug(`${this.address} (${this.uuid})`);

            this._closed = true;
            this.backend.channels.delete(this.address);

            // Cancel any queued operations
            this.cancellable.cancel();

            // Close any streams
            let streams = [
                this.input_stream,
                this.output_stream,
                this._connection
            ];

            for (let stream of streams) {
                try {
                    stream.close_async(0, null, null);
                } catch (e) {
                    // Silence errors
                }
            }
        }
    }

    /**
     * Attach to @device as the default channel used for packet exchange.
     *
     * @param {Device.Device} device - The device to attach to
     */
    attach(device) {
        try {
            // Detach any existing channel and avoid an unnecessary disconnect
            if (device._channel && device._channel !== this) {
                debug(`${device._channel.address} (${device._channel.uuid}) => ${this.address} (${this.uuid})`);

                let channel = device._channel;
                channel.cancellable.disconnect(channel._id);
                channel.close();
            }

            // Attach the new channel and parse it's identity
            device._channel = this;
            this._id = this.cancellable.connect(device._setDisconnected.bind(device));
            device._handleIdentity(this.identity);

            // Setup streams for packet exchange
            this.input_stream = new Gio.DataInputStream({
                base_stream: this._connection.input_stream
            });

            this.output_queue = [];
            this.output_stream = this._connection.output_stream;

            // Start listening for packets
            this.receive(device);
            device._setConnected();
        } catch (e) {
            logError(e);
            this.close();
        }
    }

    createTransfer(params) {
        params = Object.assign(params, {
            backend: this.backend,
            certificate: this.certificate,
            host: this.host
        });

        return new Transfer(params);
    }
});


/**
 * Lan Transfer
 */
var Transfer = GObject.registerClass({
    GTypeName: 'GSConnectLanTransfer'
}, class Transfer extends Channel {

    /**
     * @param {object} params - Transfer parameters
     * @param {Device.Device} params.device - The device that owns this transfer
     * @param {Gio.InputStream} params.input_stream - The input stream (read)
     * @param {Gio.OutputStream} params.output_stream - The output stream (write)
     * @param {number} params.size - The size of the transfer in bytes
     */
    _init(params) {
        super._init(params);

        // The device tracks transfers it owns so they can be closed from the
        // notification action.
        this.device._transfers.set(this.uuid, this);
    }

    /**
     * Override to untrack the transfer UUID
     */
    close() {
        this.device._transfers.delete(this.uuid);
        super.close();
    }

    /**
     * Connect to @port and read from the remote output stream into the local
     * input stream.
     *
     * When finished the channel and local input stream will be closed whether
     * or not the transfer succeeds.
     *
     * @return {boolean} - %true on success or %false on fail
     */
    async download() {
        let result = false;

        try {
            this._connection = await new Promise((resolve, reject) => {
                // Connect
                let client = new Gio.SocketClient({enable_proxy: false});

                // Use the address from GSettings with @port
                let address = Gio.InetSocketAddress.new_from_string(
                    this.host,
                    this.port
                );

                client.connect_async(address, null, (client, res) => {
                    try {
                        resolve(client.connect_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            this._connection = await this._initSocket(this._connection);
            this._connection = await this._clientEncryption(this._connection);
            this.input_stream = this._connection.get_input_stream();

            // Start the transfer
            result = await this.transfer();
        } catch (e) {
            logError(e, this.device.name);
        } finally {
            this.close();
        }

        return result;
    }

    /**
     * Start listening on the first available port for an incoming connection,
     * then send @packet with the payload transfer info. When the connection is
     * accepted write to the remote input stream from the local output stream.
     *
     * When finished the channel and local output stream will be closed whether
     * or not the transfer succeeds.
     *
     * @param {Core.Packet} packet - The packet describing the transfer
     * @return {boolean} - %true on success or %false on fail
     */
    async upload(packet) {
        let port = TRANSFER_MIN;
        let result = false;

        try {
            // Start listening on the first available port between 1739-1764
            let listener = new Gio.SocketListener();

            while (port <= TRANSFER_MAX) {
                try {
                    listener.add_inet_port(port, null);
                    this._port = port;
                    break;
                } catch (e) {
                    if (port < TRANSFER_MAX) {
                        port++;
                        continue;
                    } else {
                        throw e;
                    }
                }
            }

            // Await the incoming connection
            let connection = new Promise((resolve, reject) => {
                listener.accept_async(
                    this.cancellable,
                    (listener, res, source_object) => {
                        try {
                            resolve(listener.accept_finish(res)[0]);
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            // Notify the device we're ready
            packet.body.payloadHash = this.checksum;
            packet.payloadSize = this.size;
            packet.payloadTransferInfo = {port: port};
            this.device.sendPacket(packet);

            // Accept the connection and configure the channel
            this._connection = await connection;
            this._connection = await this._initSocket(this._connection);
            this._connection = await this._serverEncryption(this._connection);
            this.output_stream = this._connection.get_output_stream();

            // Start the transfer
            result = await this.transfer();
        } catch (e) {
            logError(e, this.device.name);
        } finally {
            this.close();
        }

        return result;
    }
});

