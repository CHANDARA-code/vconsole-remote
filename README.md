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
- 🎨 **Ant Design 5 & React Dashboard**: Warm, low-glare interface in paired light and dark themes — terracotta accent on paper/charcoal surfaces, Inter & Kantumruy Pro typography, and a 12px card / 8px control rounding scale. Responsive from 390px phones to wide desktops; the mode is remembered per browser and shared across tabs.
- 🚀 **Ultra-Lightweight Single Binary**: Embedded web client via Go's `embed.FS` with zero database dependencies and an RSS footprint under **15 MB**.
- 🛠️ **Full DevTools Capabilities**:
  - **Console**: Live streaming, level filtering (Log/Info/Warn/Error/Debug), search, and expandable argument inspector.
  - **Network**: Request list, status badges, and expandable headers, request payloads, and on-demand response body viewer.
  - **Storage**: Real-time view of `localStorage`, `sessionStorage`, and cookies with copyable entries.
  - **DOM Tree Inspector**: Collapsible, interactive DOM hierarchy explorer.
  - **Screen Snapshot**: One-click visual capture of the mobile screen.
  - **Interactive REPL**: Execute JavaScript expressions directly in the mobile context with keyboard history navigation (disabled by default; opt in with `security.allowRemoteEval`).
- 🔐 **Safe to Expose Publicly**: One-tap device approval, single-developer room lockout, per-IP brute-force blocking, configurable credential masking, dual session timers, and zero persistence. See [Security](#security).

---

## Architecture

```
┌────────────────────────────────────────┐         ┌────────────────────────────────────────┐
│          Mobile Device / Mini-App      │         │         Go (Golang) Single Binary      │
│  ┌──────────────────────────────────┐  │         │  ┌──────────────────────────────────┐  │
│  │ vConsole Floating HUD on Device  │  │         │  │ In-Memory Room Broker            │  │
│  │ - Shows 6-digit PIN & QR Code    │  │         │  │ - PIN + room key + rate limiting │  │
│  │ - 1-Tap [Allow] / [Reject] gate  │  │         │  │ - Holds dev until owner approves │  │
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
import VConsoleRemote from "vconsole-remote";

const vConsole = new VConsoleRemote({
  server: "wss://debug.yourcompany.com", // or ws://192.168.1.50:8080
  theme: "dark",
  autoConnect: true,

  security: {
    // Redact credentials before they leave the device (default: true)
    maskSensitiveData: true,

    // Headers replaced with [REDACTED]; the auth scheme is preserved,
    // so `Authorization: Bearer <jwt>` becomes `Bearer [REDACTED]`
    sensitiveHeaders: ["authorization", "cookie", "set-cookie", "x-api-key"],

    // JSON / form keys replaced with ******** at any nesting depth
    sensitiveBodyKeys: ["password", "secret", "credit_card", "cvv", "ssn"],

    // Let the dashboard run JavaScript on this device (default: false)
    allowRemoteEval: false,
  },
});
```

Every `security` field is optional. Omit the block entirely and you get masking on
and remote evaluation off — see [Client-side data masking](#2-client-side-data-masking)
for the full default key list and exactly what each setting changes.

#### Via CDN

```html
<script src="https://cdn.jsdelivr.net/npm/vconsole-remote/dist/vconsole-remote.min.js"></script>
<script>
  const vConsole = new window.VConsoleRemote({
    server: "wss://debug.yourcompany.com",
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

The bundled [`docker-compose.yml`](docker-compose.yml) ships with the production
security posture already set (device approval, origin pinning, proxy-aware rate
limiting, session caps, read-only root filesystem):

```bash
docker-compose up -d
```

Adjust `ALLOWED_ORIGINS` to your own hostname before deploying. Every setting is
documented in [`.env.example`](.env.example).

---

## Security

A debug session exposes console output, network traffic, storage, the DOM, and
screenshots of a real device. On a public host, a 6-digit PIN is not enough on its
own: an attacker can try every PIN in the space. The design below assumes the PIN
will eventually be guessed and makes that guess useless.

### 1. Pairing: the device owner is the gate

```
Developer enters PIN ──▶ server holds the socket, streams nothing
                             │
                             ▼
                   Device shows the prompt:
                   ⚠️  Incoming Debug Connection
                   Chrome on macOS (IP: 110.23.xx.xx)
                   wants to view your logs.
                   [ Reject ]          [ Allow ]
                             │
            ┌────────────────┴────────────────┐
         Allow                             Reject
            │                                 │
   room_connected,                    auth_rejected,
   traffic begins                     socket closed
```

- **Nothing is forwarded to a developer before approval.** The socket stays bound
  to no room, so device output has nowhere to go. Verified by
  `TestDeviceApprovalGrantsAccess` and the end-to-end check that a log emitted
  during the pending window never reaches the waiting developer.
- **Unanswered prompts expire** after `AUTH_APPROVAL_TIMEOUT` (default 60s) and
  release the room.
- **Single-developer occupancy**: a room admits exactly one developer. A second
  one is refused with `403 room_busy` before the WebSocket is even upgraded, and
  the slot frees the moment the first leaves.
- **Room key (second factor)**: every room is issued a 64-bit `crypto/rand`
  secret. The QR code encodes it as `/#/room/<PIN>?key=<KEY>`, and the dashboard
  forwards it when pairing. A wrong key is refused with `403 invalid_key`
  (compared in constant time). Set `REQUIRE_ROOM_KEY=true` to make the key
  mandatory, so a PIN alone cannot even reach the prompt.
- **Commands are bound to the authorized room only.** A developer socket routes
  by the PIN it was admitted for, never by a PIN named in a message payload.

### 2. Client-side data masking

Masking runs on the device, before anything is transmitted, and is applied at the
single point every captured request funnels through — so the SDK's own in-memory
cache never holds an unredacted credential either.

| Input | Transmitted with `maskSensitiveData: true` |
| --- | --- |
| `Authorization: Bearer eyJhbGci...` | `Authorization: Bearer [REDACTED]` |
| `Cookie: session=xyz987` | `Cookie: [REDACTED]` |
| `{"user":"alex","password":"hunter2"}` | `{"user":"alex","password":"********"}` |
| `POST /login?api_key=sk_live_1` | `POST /login?api_key=********` |
| `document.cookie` in the Storage tab | cookie names kept, every value `********` |

Defaults (each list is replaced wholesale when you supply your own):

- `sensitiveHeaders`: `authorization`, `cookie`, `set-cookie`, `x-api-key`,
  `token`, `x-auth-token`
- `sensitiveBodyKeys`: `password`, `passwd`, `secret`, `credit_card`,
  `card_number`, `cvv`, `ssn`, `pin`, `token`, `access_token`, `refresh_token`,
  `auth_token`, `id_token`, `api_key`, `apikey`, `authorization`, `session_id`,
  `sessionid`

Key matching is **exact and case-insensitive**, applied at any nesting depth in
JSON bodies and to form-encoded payloads and query strings. Set
`maskSensitiveData: false` when you are debugging your own auth flow on a device
you control and need to see the real values.

`allowRemoteEval` is **false by default**: the dashboard REPL is answered with an
explanatory error instead of executing, so a paired developer cannot run arbitrary
JavaScript on the device unless the app opted in.

### 3. Brute-force protection

Failed pairing attempts are counted per client IP in a sliding window. Five
failures inside a minute block that IP for ten minutes, and a blocked IP is turned
away with `429` and a `Retry-After` header **before** the WebSocket upgrade, so
attempts cost the server almost nothing. A successful pairing clears the counter,
so a developer who mistypes a PIN is not punished afterwards. A room that is
merely busy does not count as a failed guess.

Proxy headers (`CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`) are honoured
**only** when `TRUST_PROXY=true`. Left off, an attacker could forge a fresh
identity per request and walk straight through the limiter.

### 4. Session lifetime and zero persistence

Two independent timers, both enforced by a background reaper that notifies each
peer with `session_expired` before closing the sockets:

- `ROOM_MAX_DURATION` (default `8h`) — a hard cap from device connection, applied
  even to an actively used room.
- `ROOM_IDLE_TIMEOUT` (default `30m`) — quiet rooms are destroyed early.

Rooms live in a single `map[string]*Room` in RAM. There is no database, no cache,
and no disk writes: when a room ends it is deleted from the map and the memory is
released to the garbage collector. Nothing survives a restart, and there is no
historical data to breach. Access logs record the request **path** only — logging
the full URI would persist room PINs and keys to stdout — and PINs in application
logs are truncated (`482***`).

### 5. Network hardening

- Every response carries `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy`, and a
  `Permissions-Policy` denying camera, microphone, and geolocation.
- `ALLOWED_ORIGINS` pins which origins may open a dashboard connection. Device
  connections are deliberately exempt: mobile apps connect from `capacitor://`,
  `file://`, and other arbitrary schemes.
- `MAX_ROOMS` (default 10000) bounds memory against room-exhaustion attempts.
- `GET /healthz` reports aggregate counters only and never exposes a PIN.
- Put the server behind TLS. Behind Cloudflare you additionally get TLS 1.3
  termination, DDoS absorption, Bot Fight Mode, and origin IP masking — set
  `TRUST_PROXY=true` so the rate limiter sees real client addresses.

### Deployment checklist

| Setting | Local development | Public deployment |
| --- | --- | --- |
| `REQUIRE_DEVICE_APPROVAL` | `true` | `true` — never disable |
| `TRUST_PROXY` | `false` | `true` **only** behind a proxy you control |
| `ALLOWED_ORIGINS` | empty | your dashboard hostname |
| `REQUIRE_ROOM_KEY` | `false` | `true` for stricter pairing |
| `security.allowRemoteEval` | opt in as needed | leave `false` |
| TLS | optional | required (`wss://`) |

`REQUIRE_DEVICE_APPROVAL=false` exists for local development and the integration
test suite. With it off, anyone who guesses a PIN gets full access; the server
prints a warning at boot when it is disabled.

### Reporting a vulnerability

Please open a private security advisory rather than a public issue.

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
│   ├── main.go             # Go server, router & pre-upgrade admission checks
│   ├── room.go             # In-memory room broker, approval handshake, reaper
│   ├── security.go         # Config, rate limiter, client IP & origin policy
│   ├── safeconn.go         # Concurrency-safe Gorilla WebSocket wrapper
│   ├── room_test.go        # Server concurrency & lifecycle tests
│   └── security_test.go    # Approval gate, brute-force, occupancy & expiry tests
├── test/
│   ├── helpers.js          # Hermetic E2E test harness
│   ├── run-all.js          # Master 4-tier test runner
│   ├── tier1-feature.test.js
│   ├── tier2-boundary.test.js
│   ├── tier3-combination.test.js
│   └── tier4-scenarios.test.js
├── .env.example            # Documented server configuration reference
├── Dockerfile              # Production multi-stage Docker build
└── docker-compose.yml      # Production compose with the hardened defaults
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
