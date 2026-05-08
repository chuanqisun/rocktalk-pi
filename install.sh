#!/bin/bash

# Install nvm
NODE_BIN_URL="https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz"

# Install node prebuild binary to /usr/bin/node
curl -L $NODE_BIN_URL -o node.tar.xz
sudo tar -xf node.tar.xz --strip-components=1 -C /usr/bin/ --no-same-owner --no-same-permissions
rm node.tar.xz

#  setup node dependencies
npm init -y
npm install spi-device rxjs @clack/prompts esbuild

# register systemd service
# TODO