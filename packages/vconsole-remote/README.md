# vConsole Remote Client SDK

A lightweight, production-grade remote debugging tool built on top of [vConsole](https://github.com/tencent/vconsole).

## Installation

### npm
```bash
npm install vconsole-remote
```

### CDN
```html
<script src="https://cdn.jsdelivr.net/npm/vconsole-remote/dist/vconsole-remote.min.js"></script>
```

## Usage

### With npm
```javascript
import VConsoleRemote from 'vconsole-remote';

const vConsole = new VConsoleRemote({
  server: 'wss://debug.yourcompany.com', // or local IP: ws://192.168.1.50:8080
  theme: 'dark',
  autoConnect: true,
});
```

### With CDN
```html
<script src="https://cdn.jsdelivr.net/npm/vconsole-remote/dist/vconsole-remote.min.js"></script>
<script>
  const vConsole = new window.VConsoleRemote({
    server: 'wss://debug.yourcompany.com'
  });
</script>
```

## Features

- **Floating HUD**: Displays a 6-digit PIN and QR code for pairing
- **Real-time Logs**: Shows console logs from the device
- **Network Inspection**: Displays network requests with timing information
- **On-demand Pull**: Heavy data is only pulled when requested by developer
- **JavaScript REPL**: Execute JavaScript expressions directly on the device

## API

### Constructor Options
- `server`: WebSocket server URL (default: `ws://localhost:8080`)
- `theme`: UI theme (`dark` or `light`) 
- `autoConnect`: Automatically connect to server on initialization (default: `true`)

### Methods
- `sendLog(level, message)`: Send log data to the server
- `sendNetworkRequest(request)`: Send network request data to the server
- `pullNetworkBody(requestId)`: Pull full network body for a request
- `pullStorage()`: Pull storage data from device
- `pullDomTree()`: Pull DOM tree from device
- `pullScreenshot()`: Pull screenshot from device
- `executeJS(code)`: Execute JavaScript on the device

## License

MIT