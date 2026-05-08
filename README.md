1. Enable SSH over USB

```sh
sudo apt update
sudo apt install rpi-usb-gadget
sudo rpi-usb-gadget on
```

2. Enable SPI

```sh
sudo raspi-config
# Follow the menu to enable SPI interface
sudo reboot
```

2. Install packagea

```sh
sudo apt install i2c-tools mpg123
```

3. Test audio pipeline

```sh
aplay -l  # list audio devices
speaker-test -D plughw:2,0 -c 2 -t wav # 2,0 means card 2, subdevice 0, change these based on your setup
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
