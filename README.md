# vConsole Remote

[![CI Pipeline](https://github.com/your-username/vconsole-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/your-username/vconsole-remote/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go Version](https://img.shields.io/badge/Go-1.21+-00ADD8?logo=go)](https://golang.org)
[![Node Version](https://img.shields.io/badge/Node-20%2B-339933?logo=node.js)](https://nodejs.org)
[![Ant Design](https://img.shields.io/badge/UI-Ant%20Design%205-1677FF?logo=antdesign)](https://ant.design)

A lightweight, production-grade remote debugging tool built on top of [vConsole](https://github.com/tencent/vconsole).

Inspect mobile web apps, PWAs, and mini-apps live from any desktop browser with an interactive Chrome DevTools-style dashboard powered by **ReactJS** and **Ant Design**.

---

## Highlights & Features

- 📱 **Mobile Debugging**: Single line of code to generate an on-device floating HUD with a 6-digit PIN and QR code.
- ⚡ **Zero Battery & Network Waste**: Streams lightweight logs and network metadata automatically; heavy payloads (response bodies, DOM tree, screenshots, storage) are pulled **strictly on-demand**.
- 🎨 **Ant Design 5 & React Dashboard**: Beautiful, enterprise-grade responsive interface with dark & light theme support, Inter & Kantumruy Pro typography, and 16px/12px component rounding.
- 🚀 **Ultra-Lightweight Single Binary**: Embedded web client via Go's `embed.FS` with zero database dependencies and an RSS footprint under **15 MB**.
- 🛠️ **Full DevTools Capabilities**:
  - **Console**: Live streaming, level filtering (Log/Info/Warn/Error/Debug), search, and expandable argument inspector.
  - **Network**: Request list, status badges, and expandable headers, request payloads, and on-demand response body viewer.
  - **Storage**: Real-time view of `localStorage`, `sessionStorage`, and cookies with copyable entries.
  - **DOM Tree Inspector**: Collapsible, interactive DOM hierarchy explorer.
  - **Screen Snapshot**: One-click visual capture of the mobile screen.
  - **Interactive REPL**: Execute JavaScript expressions directly in the mobile context with keyboard history navigation.

---

## Architecture

```
┌────────────────────────────────────────┐         ┌────────────────────────────────────────┐
│          Mobile Device / Mini-App      │         │         Go (Golang) Single Binary      │
│  ┌──────────────────────────────────┐  │         │  ┌──────────────────────────────────┐  │
│  │ vConsole Floating HUD on Device  │  │         │  │ In-Memory Room Broker            │  │
│  │ - Shows 6-digit PIN & QR Code    │  │         │  │ - Matches 6-digit PINs           │  │
│  └──────────────────┬───────────────┘  │         │  │ - Zero DB / Pure RAM (<15MB)     │  │
│  ┌──────────────────▼───────────────┐  │ WebSocket│  └──────────────────┬───────────────┘  │
│  │ `vconsole-remote` SDK Engine     ├───────────────┤ ┌──────────────────▼───────────────┐  │
│  │ - Streams logs, network metadata │  │ (wss://) │ │ Embedded React + Ant Design UI   │  │
│  │ - On-demand reverse pull handler │  │         │ │ - Chrome DevTools-style Dashboard│  │
│  └──────────────────────────────────┘  │         │ │ - Served via Go `embed.FS`        │  │
└────────────────────────────────────────┘         └─────────────────┬──────────────────────┘
                                                                     │ HTTP / WebSocket
                                                                     ▼
                                                   ┌────────────────────────────────────────┐
                                                   │       Developer Desktop Browser        │
                                                   │  Console • Network • Storage • REPL    │
                                                   │  DOM Tree Inspector • Screen Snapshot  │
                                                   └────────────────────────────────────────┘
```

---

## Quick Start

### 1. Client SDK Integration

#### Via npm

```bash
npm install vconsole-remote
```

```javascript
import VConsoleRemote from 'vconsole-remote';

const vConsole = new VConsoleRemote({
  server: 'wss://debug.yourcompany.com', // or ws://192.168.1.50:8080
  theme: 'dark',
  autoConnect: true,
});
```

#### Via CDN

```html
<script src="https://cdn.jsdelivr.net/npm/vconsole-remote/dist/vconsole-remote.min.js"></script>
<script>
  const vConsole = new window.VConsoleRemote({
    server: 'wss://debug.yourcompany.com'
  });
</script>
```

---

### 2. Server Deployment

#### Running Locally with Go

```bash
cd server
go run .
# Server starts at http://localhost:8080
```

#### Running with Docker

```bash
docker build -t vconsole-remote .
docker run -p 8080:8080 vconsole-remote
```

#### Running with Docker Compose

```yaml
version: '3.8'
services:
  vconsole-remote:
    build: .
    container_name: vconsole-remote
    restart: always
    ports:
      - "8080:8080"
```

```bash
docker-compose up -d
```

---

## Development & Contributing

We welcome contributions from developers worldwide! Please review our [Contributing Guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md).

### Project Layout

```
vconsole-remote/
├── packages/
│   └── vconsole-remote/    # Client SDK (TypeScript / Rollup / vConsole plugin)
├── server/
│   ├── assets/             # Web Dashboard (ReactJS + Ant Design UI)
│   ├── main.go             # Go server & router entrypoint
│   ├── room.go             # In-memory room broker & state management
│   ├── safeconn.go         # Concurrency-safe Gorilla WebSocket wrapper
│   └── room_test.go        # Server concurrency & lifecycle tests
├── test/
│   ├── helpers.js          # Hermetic E2E test harness
│   ├── run-all.js          # Master 4-tier test runner
│   ├── tier1-feature.test.js
│   ├── tier2-boundary.test.js
│   ├── tier3-combination.test.js
│   └── tier4-scenarios.test.js
├── Dockerfile              # Production multi-stage Docker build
└── docker-compose.yml
```

### Running Tests

```bash
# Run all tests (Client + Server + 4-Tier E2E)
npm run test:all

# Or run separately:
npm run test:client    # Client SDK unit tests
npm run test:server    # Go server unit tests
npm test               # 4-Tier E2E test suite
```

---

## License

This project is open source and available under the [MIT License](LICENSE).