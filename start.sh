#!/bin/bash
# Load nvm environment
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Use a specific version or the default
nvm use 24

# Start your app
cd /home/rocktalk/rocktalk-pi
exec npm start
