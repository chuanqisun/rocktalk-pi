1. Enable SPI

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
