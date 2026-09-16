# vConsole Remote

[![CI Pipeline](https://github.com/chandara-code/vconsole-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/chandara-code/vconsole-remote/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/vconsole-remote?logo=npm&color=CB3837)](https://www.npmjs.com/package/vconsole-remote)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go Version](https://img.shields.io/badge/Go-1.25+-00ADD8?logo=go)](https://golang.org)
[![Node Version](https://img.shields.io/badge/Node-20%2B-339933?logo=node.js)](https://nodejs.org)
[![Ant Design](https://img.shields.io/badge/UI-Ant%20Design%205-1677FF?logo=antdesign)](https://ant.design)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-C15F3C.svg)](CONTRIBUTING.md)

A lightweight, production-grade remote debugging tool built on top of [vConsole](https://github.com/tencent/vconsole).

Inspect mobile web apps, PWAs, and mini-apps live from any desktop browser with an interactive Chrome DevTools-style dashboard powered by **ReactJS** and **Ant Design**.

> **Just want to debug something?** Point the SDK at the hosted broker —
> `server: "wss://debug.leavchandara.com"` — and open
> <https://debug.leavchandara.com> on your desktop. No server to deploy, no
> account. See [Option A](#option-a--use-the-hosted-broker-nothing-to-deploy)
> for what it does and does not guarantee.

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

Three ways to load the SDK. They ship identical code — pick by how you want it
delivered:

| | Install | Version follows | Best for |
|---|---|---|---|
| **From the broker** | none | the broker you debug against | fastest start, guaranteed protocol match |
| **npm** | `npm install vconsole-remote` | your lockfile | bundled apps |
| **CDN** | none | the version you pin | a `<script>` tag without npm |

#### From the broker (no install)

Every broker serves the SDK at `/sdk.js`, compiled into the same binary that
runs the WebSocket hub. Because both come from one build, the SDK can never
speak a protocol the broker does not — the drift a pinned CDN copy develops
after a broker upgrade is impossible here:

```html
<script src="https://debug.leavchandara.com/sdk.js"></script>
<script>
  const vConsole = new window.VConsoleRemote({
    server: "wss://debug.leavchandara.com",
  });
</script>
```

Self-hosting? Serve it from your own broker — `https://your-broker/sdk.js` —
and the same guarantee holds. The response carries an `ETag` and a one-hour
`Cache-Control`, so repeat loads revalidate cheaply instead of re-downloading.

#### Via npm

```bash
npm install vconsole-remote
```

```javascript
import VConsoleRemote from "vconsole-remote";

const vConsole = new VConsoleRemote({
  // Public hosted broker — nothing to deploy. Self-hosting? Point this at your
  // own origin instead: wss://debug.yourcompany.com, or ws://192.168.1.50:8080.
  server: "wss://debug.leavchandara.com",
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

jsDelivr and unpkg both serve the published npm package:

```html
<script src="https://cdn.jsdelivr.net/npm/vconsole-remote@1.0.0/dist/vconsole-remote.min.js"></script>
<script>
  const vConsole = new window.VConsoleRemote({
    server: "wss://debug.leavchandara.com",
  });
</script>
```

Pin the version. An unpinned URL follows `latest`, so a future publish silently
changes what ships to your users' phones — and unlike the `/sdk.js` route, a CDN
copy has no way to stay in step with the broker you point it at.

`dist/vconsole-remote.min.js` is the minified UMD build and the one to use in
production; `dist/vconsole-remote.js` is the same bundle unminified, and
`dist/vconsole-remote.esm.js` is the ES module entry that bundlers pick up
through the `module` field. `vconsole` and `qrcode` are bundled in, so a single
tag is self-sufficient — there are no peer dependencies to add.

---

### 2. Pick a Broker

The broker is the only piece that has to be reachable by both your phone and your
desktop. You have two options, and the SDK snippet above is the only thing that
changes between them.

#### Option A — Use the hosted broker (nothing to deploy)

A public instance runs at **`https://debug.leavchandara.com`**. Point the SDK at
it and you can debug a device in under a minute, with no server, no container and
no TLS certificate of your own:

```javascript
const vConsole = new VConsoleRemote({
  server: "wss://debug.leavchandara.com",
});
```

Then:

1. Load your page on the phone. The floating HUD shows a **6-digit PIN** and a QR code.
2. On your desktop, open **<https://debug.leavchandara.com>** and enter that PIN
   (or scan the QR, which carries the PIN and the room key together).
3. The phone raises an **Allow / Deny** prompt naming the requesting browser. Tap
   **Allow** — until you do, the dashboard receives nothing at all.

That is the whole flow. What you should know about the hosted instance before you
point a real device at it:

| | |
|---|---|
| **Who can see your data** | Only a dashboard that you approve on the device, for the life of that session. |
| **What is stored** | Nothing. Rooms live in memory only — no database, no disk, no log of URLs (the access log records the path, never the PIN or key). |
| **Session limits** | 8h hard cap, destroyed after 30m idle, one developer per room. |
| **Brute force** | 5 failed PIN attempts per IP per minute, then a 10m block. |
| **Masking** | Credentials are redacted **on the device**, before anything is sent — see [Client-side data masking](#2-client-side-data-masking). |
| **Remote eval** | Off unless you opt in with `security.allowRemoteEval: true`. |
| **Guarantees** | None. It is a convenience instance with no uptime commitment, and it can restart at any time — which drops live sessions, since nothing is persisted. |

It is a good fit for debugging a staging build, reproducing a bug on a borrowed
handset, or trying the tool out. Treat it the way you would any third-party
service: the masking defaults are on for a reason, and if your logs carry data
that must not leave your infrastructure, use Option B.

#### Option B — Self-host

Run your own broker when you need an uptime guarantee, a private network, or data
that must not transit someone else's host. Every deployment path below produces a
server identical to the hosted one.

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
cp .env.example .env    # then set ALLOWED_ORIGINS to your dashboard hostname
docker compose up -d
```

Every setting is documented in [`.env.example`](.env.example). Two of them are
read by Compose rather than the server, and they are the ones that decide how the
broker is exposed:

| Variable | Default | Use |
| --- | --- | --- |
| `BIND_ADDR` | `0.0.0.0` | Set to `127.0.0.1` when a reverse proxy terminates TLS, so the only route in is through that proxy. |
| `HOST_PORT` | `8080` | Host port the container publishes on. |

#### Behind a reverse proxy

The broker is a WebSocket hub, so the `/ws` location needs a real `Upgrade` hop
and a read timeout longer than `ROOM_MAX_DURATION` — otherwise the proxy, not the
server, decides when a debug session ends:

```nginx
location = /ws {
    proxy_pass http://127.0.0.1:8080/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;  # map $http_upgrade -> upgrade/close
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 9h;   # must outlast ROOM_MAX_DURATION
}
```

Set `TRUST_PROXY=true` at the same time, so the brute-force limiter counts the
real client address instead of blocking every user behind the proxy at once. Turn
it on **only** when a proxy you control is genuinely in front: with it on and
nothing in front, anyone can forge `X-Forwarded-For` and walk past the limiter.

#### Release automation (npm + CDN)

[`release.yml`](.github/workflows/release.yml) owns the npm and CDN paths.
Trigger it from **Actions → Release → Run workflow** with a version, or by
pushing a `v*.*.*` tag. It preflights the credential and the version (npm
versions are immutable, so a duplicate is caught before anything runs),
verifies the bundles, publishes with provenance, attaches server binaries built
*with the SDK embedded*, then confirms npm, jsDelivr and unpkg actually serve
the result. [`docs/RELEASING.md`](docs/RELEASING.md) has the full sequence.

The `/sdk.js` path is deliberately not part of this: it ships with every deploy
to `main`, so it is never waiting on a release.

#### Continuous deployment

[`.github/workflows/deploy-vps.yml`](.github/workflows/deploy-vps.yml) redeploys
on every push to `main` (including the merge commit from a PR) using a
self-hosted runner labelled `vconsole`. It runs
[`scripts/deploy.sh`](scripts/deploy.sh), which syncs the live checkout, builds
the image *before* touching the running container, restarts it, and then verifies
both the loopback health endpoint and the public URL — failing the job if either
does not answer. [`scripts/setup-runner.sh`](scripts/setup-runner.sh) registers
the runner on a fresh box.

Rooms are in-memory only, so a deploy drops live debug sessions by design; there
is no state to migrate.

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

Please use a [private security advisory](https://github.com/chandara-code/vconsole-remote/security/advisories/new)
rather than a public issue — a public patch tells attackers how to hit
deployments that have not updated yet. [SECURITY.md](SECURITY.md) covers what's
in scope, what's a documented trade-off, and what response times to expect.

---
## Development & Contributing

Contributions are welcome. Start with the [Contributing Guide](CONTRIBUTING.md) —
it covers the development setup, how to run each test suite, the security
invariants that changes need to preserve, and where help is most useful. Please
also read the [Code of Conduct](CODE_OF_CONDUCT.md).

Found a security problem? Use a [private advisory](https://github.com/chandara-code/vconsole-remote/security/advisories/new),
not a public issue or PR. See [SECURITY.md](SECURITY.md).

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
├── docs/
│   ├── TEST_INFRA.md       # Test architecture & philosophy
│   ├── RELEASING.md        # Release runbook (npm, tags, binaries)
│   └── README.md           # Index, incl. historical design documents
├── .env.example            # Documented server configuration reference
├── SECURITY.md             # Threat model, scope & disclosure policy
├── CHANGELOG.md            # Keep a Changelog / SemVer history
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
