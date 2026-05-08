#!/bin/bash

# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash

# Install node
nvm install 24

# Copy node binary to /usr/local/bin for systemd service access
NODE_PATH=$(which node)
sudo ln -s $NODE_PATH /usr/local/bin/node

#  setup node dependencies
npm init -y
npm install spi-device rxjs @clack/prompts esbuild

# register systemd service
# TODO