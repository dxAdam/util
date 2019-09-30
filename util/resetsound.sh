# my set up has multiple audio output devices and this is an easy way to reset to the desired default device.

# Find the desired device in the list generated by
#    pactl list short sinks

# Mine gives
#   0	alsa_output.pci-0000_1c_00.1.hdmi-stereo-extra2	module-alsa-card.c	s16le 2ch 44100Hz	RUNNING
#   1	alsa_output.usb-SteelSeries_SteelSeries_Siberia_800-00.analog-mono	module-alsa-card.c	s16le 1ch 44100Hz	SUSPENDED
#   2	alsa_output.pci-0000_1e_00.3.iec958-stereo	module-alsa-card.c	s16le 2ch 44100Hz	SUSPENDED

# Now set the desired device as default with
pactl set-default-sink 0

# To make this permanent change the line '#set-default-sink output' to
#   'set-default-sink output 0' in /etc/pulse/default.pa
sudo sed -i -- 's/#set-default-sink output/set-default-sink output 0/g' /etc/pulse/default.pa

# Now I like to set the volume low with 
pacmd set-sink-volume 0 15000 # 0 is the device number from the list above and 15000 is volume level out of 512000


# finally I like to assign this script to a keyboard shortcut such as Ctrl+Shift+S in the ubuntu keyboard shortcuts
