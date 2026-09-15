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

  security: {
    maskSensitiveData: true,   // redact credentials before sending (default)
    allowRemoteEval: false,    // block the dashboard REPL (default)
  },
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
- **JavaScript REPL**: Execute JavaScript expressions directly on the device (opt-in)
- **1-Tap Authorization**: An incoming debug session is blocked until the device owner taps Allow
- **Data Masking**: Credentials are redacted on the device, before anything is transmitted

## Security

### Device approval

When a developer enters your PIN, the server holds their connection and this SDK
shows a full-screen prompt naming the browser, OS, and partially-masked IP
requesting access. Nothing is streamed until you tap **Allow**; tapping
**Reject** severs the connection. Unanswered prompts expire (60s by default).

### Data masking

With `maskSensitiveData: true` (the default), values are redacted on the device
before transmission — including in this SDK's own in-memory request cache:

| Input | Transmitted |
| --- | --- |
| `Authorization: Bearer eyJhbGci...` | `Authorization: Bearer [REDACTED]` |
| `Cookie: session=xyz987` | `Cookie: [REDACTED]` |
| `{"user":"alex","password":"hunter2"}` | `{"user":"alex","password":"********"}` |
| `POST /login?api_key=sk_live_1` | `POST /login?api_key=********` |
| Cookies in the Storage tab | names kept, values `********` |

Matching is exact and case-insensitive, applied at any depth in JSON bodies and
to form-encoded payloads and query strings. Supplying `sensitiveHeaders` or
`sensitiveBodyKeys` replaces the built-in list rather than extending it. Set
`maskSensitiveData: false` when debugging your own auth flow on a device you
control.

### Remote evaluation

`allowRemoteEval` is `false` by default: the dashboard REPL receives an
explanatory error instead of executing, so a paired developer cannot run
arbitrary JavaScript on the device unless your app opts in.

## API

### Constructor Options
- `server`: WebSocket server URL (default: `ws://localhost:8080`)
- `theme`: UI theme (`dark` or `light`) 
- `autoConnect`: Automatically connect to server on initialization (default: `true`)
- `security.maskSensitiveData`: Redact credentials before transmission (default: `true`)
- `security.sensitiveHeaders`: Header names to redact — replaces the default list
- `security.sensitiveBodyKeys`: JSON/form/query keys to redact — replaces the default list
- `security.allowRemoteEval`: Allow the dashboard to execute JavaScript here (default: `false`)

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