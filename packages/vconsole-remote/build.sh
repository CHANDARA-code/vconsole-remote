#!/bin/bash

# Build script for vConsole Remote client SDK

echo "Building vConsole Remote client SDK..."

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Build using rollup
echo "Building with Rollup..."
npx rollup -i src/index.js -o dist/vconsole-remote.js -f umd -n VConsoleRemote
npx rollup -i src/index.js -o dist/vconsole-remote.esm.js -f es
npx rollup -i src/index.js -o dist/vconsole-remote.min.js -f umd -n VConsoleRemote --environment=production

echo "Build completed successfully!"
echo "Files created in dist/ directory:"
ls -la dist/