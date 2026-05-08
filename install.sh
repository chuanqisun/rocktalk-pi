# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash

# Install node
nvm install 24

#  setup node dependencies
npm init -y
npm install spi-device rxjs @clack/prompts

# register systemd service
# TODO