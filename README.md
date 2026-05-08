0. Create respberry pi image

Use Raspberry Pi Imager to flash the latest Raspberry Pi OS Lite (64-bit) to your microSD card.

- Enable WIFI to use MLDEV (or any basic username/password WIFI)
- Enable [Raspberry Pi Connect](https://www.raspberrypi.com/software/connect/) during the installation

1. Enable SSH over USB

- [Full documentation for reference](https://www.raspberrypi.com/news/usb-gadget-mode-in-raspberry-pi-os-ssh-over-usb/)
- After initial boot, use Raspberry Pi Connect to open a terminal over the WIFI. Then run the following commands to enable SSH over USB

```sh
sudo apt update
sudo apt install rpi-usb-gadget
sudo rpi-usb-gadget on
sudo reboot
```

After this step, you can switch to use USB-C cable for local programming. In your host computer, connect to raspberry pi using the following command.

```sh
ssh <username>@<hostname>.local
```

2. Enable SPI

```sh
sudo raspi-config
# Follow the menu to enable SPI interface
sudo reboot
```

2. Install packages

```sh
sudo apt install mpg123
```

3. Test hardware

```sh
aplay -l  # list audio devices
speaker-test -D plughw:2,0 -c 2 -t wav # do you hear sound? "2,0" means card 2, device 0, change these based on your setup
ls /dev/spidev* # is rfid reader connected? if successful, you should see something like /dev/spidev0.0 and /dev/spidev0.1
```

4. Install nvm

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash

# Need to logout, login again
nvm install 24
```

5. Clone repo

```sh
sudo apt install git
git clone https://github.com/chuanqisun/rocktalk-pi.git
```

6. Install dependencies

```sh
cd rocktalk-pi

#  setup node dependencies
npm init -y
npm install spi-device rxjs @clack/prompts
```

6. Register systemd service

```sh
sudo cp rocktalk.service /etc/systemd/system/

# stop and disable the default service if it exists
sudo systemctl daemon-reload
sudo systemctl enable rocktalk.service
sudo systemctl start rocktalk.service
```
