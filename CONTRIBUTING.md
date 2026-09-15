# Contributing to vConsole Remote

Thank you for your interest in contributing to **vConsole Remote**! 🎉

We welcome contributions of all kinds: bug reports, documentation enhancements, feature proposals, and pull requests. This document outlines our development process and guidelines to help you get started.

---

## Code of Conduct

All contributors and maintainers are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Please report unacceptable behavior to the project maintainers.

---

## Found a security problem?

**Do not open a public issue or pull request for a vulnerability.** A public
patch is a disclosure: it tells everyone how to attack deployments that have not
updated yet. Report it privately through [GitHub Security Advisories](https://github.com/chandara-code/vconsole-remote/security/advisories/new)
instead. [SECURITY.md](SECURITY.md) explains what's in scope and what to expect.

---

## Project Architecture

`vconsole-remote` consists of three core components:

1. **Client SDK (`packages/vconsole-remote`)**:
   - Lightweight JavaScript SDK extending Tencent's [vConsole](https://github.com/tencent/vconsole).
   - Injects a "Remote" tab displaying a 6-digit PIN and QR code for pairing.
   - Streams console logs and network request metadata over WebSocket.
   - Responds to on-demand reverse pull requests (response bodies, storage, DOM tree, screen capture).
   - Bundled with Rollup into UMD and ESM distributions.

2. **Backend Broker Server (`server/`)**:
   - Ultra-lightweight Go (Golang) server (< 15MB RAM footprint).
   - In-memory ephemeral room management (no database required).
   - High-performance, concurrent-safe WebSocket message routing between device and developer browser.
   - Embeds the web dashboard via Go's `embed.FS` for single-binary deployment.
   - Key files: `room.go` (pairing handshake, approval gate, room lifecycle),
     `security.go` (configuration, rate limiter, client-IP and origin policy),
     `main.go` (routing and pre-upgrade admission checks), `safeconn.go`
     (concurrency-safe WebSocket wrapper).

3. **Web Dashboard (`server/assets/index.html`)**:
   - Modern, responsive debugging interface built with ReactJS and Ant Design.
   - Chrome DevTools-style panels: Console, Network, Storage, DOM Inspector, Screen Snapshot, and interactive JavaScript REPL.
   - Dynamic Light / Dark mode themes matching modern design standards.

---

## Getting Started & Development Setup

### Prerequisites

Ensure you have the following installed on your system:

- **Node.js**: `v20.0.0+` (Recommended: `v22+` or `v24+` for native WebSocket test runner)
- **npm**: `v10.0.0+`
- **Go**: `1.21+` (Recommended: `1.22+`)
- **Docker** (optional, for containerized testing)

### Clone the Repository

```bash
git clone https://github.com/chandara-code/vconsole-remote.git
cd vconsole-remote
```

### Install Dependencies

```bash
# Install root dependencies
npm install

# Install client SDK dependencies
cd packages/vconsole-remote
npm install
cd ../..
```

---

## Build Commands

You can build components individually or using the root scripts:

```bash
# Build Client SDK (outputs to packages/vconsole-remote/dist/)
npm run build:client

# Build Go Server binary (outputs to server/vconsole-remote)
npm run build:server

# Build all components
npm run build
```

---

## Running the Development Server

Start the Go server locally:

```bash
cd server
go run .
```

By default, the server listens on `http://localhost:8080`. Open this URL in your desktop browser to access the dashboard.

To configure a custom port:

```bash
PORT=9000 go run .
```

---

## Running Tests

`vconsole-remote` features a comprehensive 4-Tier test suite and unit tests for both client and server:

```bash
# Run all tests (Client unit tests + Server tests + 4-Tier E2E suite)
npm run test:all

# Run individual test suites:
npm run test:client    # Client SDK unit tests (packages/vconsole-remote)
npm run test:server    # Server unit tests (server/)
npm test               # 4-Tier E2E test suite (test/run-all.js)

# The server suite is also worth running under the race detector, which is
# what CI does. The approval handshake is concurrent code.
cd server && go test -race ./...
```

`server/security_test.go` covers the properties that make a public deployment
safe: the approval gate, brute-force blocking, single-developer occupancy, room
key validation, session expiry and origin pinning. If you touch pairing or the
limiter, expect to add to it.

> The E2E harness starts the server with a deliberately high `PIN_ATTEMPT_LIMIT`,
> because every client in the suite shares the loopback address and would
> otherwise trip the real 5-per-minute budget partway through the run. The
> limiter's production default is asserted in `server/security_test.go`.

### 4-Tier E2E Test Breakdown

- **Tier 1 (Feature Coverage)**: Validates PIN generation, pairing, console streaming, and all on-demand pull protocols.
- **Tier 2 (Boundary Cases)**: Malformed PINs, payload size stress, disconnect resilience, malformed packets.
- **Tier 3 (Cross-Feature Combinations)**: High-concurrency traffic, multi-room isolation, simultaneous pull operations.
- **Tier 4 (Real-World Scenarios)**: Full lifecycle debugging flow, <50ms latency SLA, <15MB server RAM constraint.

---

## Working on security-sensitive code

Some parts of this project carry invariants that the whole threat model rests
on. Changes there are welcome, but they need to keep these properties true:

| Invariant | Where it lives | Test |
| --- | --- | --- |
| No room traffic reaches a developer before the device approves | `server/room.go` | `TestDeviceApprovalGrantsAccess` |
| A room admits exactly one developer at a time | `server/room.go` | `TestSingleDeveloperOccupancy` |
| A socket can only reach the room it was admitted for, never one named in a payload | `server/room.go` | `TestUnpairedDeveloperCannotReachRoom` |
| Failed pairing attempts are bounded per IP, and proxy headers can't forge a new identity | `server/security.go` | `TestBruteForcePinAttemptsAreBlocked`, `TestClientIPTrustsProxyHeadersOnlyWhenConfigured` |
| Credentials are redacted before they leave the device | `packages/vconsole-remote/src/index.js` | SDK masking tests |
| Remote evaluation is off unless the app opts in | `packages/vconsole-remote/src/index.js` | `exec_js is refused when allowRemoteEval is false` |
| PINs and room keys never reach logs | `server/main.go`, `server/room.go` | `TestMaskingHelpers` |

A good way to check a test actually has teeth: break the implementation on
purpose and confirm the test fails, then put it back. A security test that
passes against broken code is worse than no test.

If a change has to relax one of these, say so explicitly in the pull request
description and explain the reasoning — that's a discussion worth having in the
open, not something to slip through.

---

## What the CI has to pass

Every pull request runs:

- `gofmt` (formatting is enforced, not suggested), `go vet`, and
  `go test -race -cover`
- `govulncheck` against the Go dependency tree
- Client SDK build and unit tests
- The 4-tier E2E suite against a real server binary
- A Docker image build plus a `/healthz` smoke test

Run `npm run test:all` before pushing and most of this is already settled.

---

## Where help is most welcome

- **Framework integrations** — first-class setup for React Native WebView,
  Capacitor, Taro, or the WeChat/Alipay mini-program runtimes.
- **Dashboard panels** — a timeline/waterfall view for network requests, or
  log persistence across reconnects.
- **Accessibility** — keyboard navigation and screen-reader passes over the
  dashboard.
- **Internationalisation** — the UI is English-only today.
- **Deployment recipes** — Kubernetes manifests, Fly.io, Railway, or a Helm
  chart.
- **Documentation** — if something confused you while reading this, that's a
  bug worth reporting.

Issues labelled `good first issue` are scoped to be approachable without deep
knowledge of the pairing protocol.

---

## Submitting a Pull Request

1. **Fork the repository** on GitHub.
2. **Create a topic branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Write clean, documented code**:
   - Ensure code conforms to Go conventions (`go fmt`, `go vet`).
   - Ensure JavaScript adheres to modern ES2022+ standards.
4. **Add tests** for any new features, edge cases, or bug fixes.
5. **Run the entire test suite**:
   ```bash
   npm run test:all
   ```
   All tests must pass before submitting.
6. **Commit your changes**:
   Use clear, descriptive commit messages following Conventional Commits (e.g. `feat: add storage filter`, `fix: resolve websocket reconnect race condition`).
7. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```
8. **Open a Pull Request** against the `main` branch of this repository.

---

## Questions or Need Help?

- **Bug or feature idea** — open an [issue](https://github.com/chandara-code/vconsole-remote/issues).
- **Security problem** — use a [private advisory](https://github.com/chandara-code/vconsole-remote/security/advisories/new), not an issue.
- **Anything else** — start a [discussion](https://github.com/chandara-code/vconsole-remote/discussions).

Further reading: [docs/](docs/) for test architecture and the release process,
[SECURITY.md](SECURITY.md) for the threat model, and the
[README](README.md#security) for the security design and deployment checklist.

Happy debugging!
