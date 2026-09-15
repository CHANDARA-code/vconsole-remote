# Contributing to vConsole Remote

Thank you for your interest in contributing to **vConsole Remote**! 🎉

We welcome contributions of all kinds: bug reports, documentation enhancements, feature proposals, and pull requests. This document outlines our development process and guidelines to help you get started.

---

## Code of Conduct

All contributors and maintainers are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Please report unacceptable behavior to the project maintainers.

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
git clone https://github.com/your-username/vconsole-remote.git
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
```

### 4-Tier E2E Test Breakdown

- **Tier 1 (Feature Coverage)**: Validates PIN generation, pairing, console streaming, and all on-demand pull protocols.
- **Tier 2 (Boundary Cases)**: Malformed PINs, payload size stress, disconnect resilience, malformed packets.
- **Tier 3 (Cross-Feature Combinations)**: High-concurrency traffic, multi-room isolation, simultaneous pull operations.
- **Tier 4 (Real-World Scenarios)**: Full lifecycle debugging flow, <50ms latency SLA, <15MB server RAM constraint.

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

Feel free to open an issue or start a discussion on GitHub. Happy coding!
