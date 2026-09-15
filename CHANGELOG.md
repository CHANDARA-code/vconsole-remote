# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The server and the client SDK share a version number and are released together.

## [Unreleased]

## [1.0.0] — 2026-09-16

First public release.

### Added

**Pairing security** — a 6-digit PIN is guessable, so the device owner is the gate.

- On-device approval: a developer connection is held in a pending slot and
  receives nothing until the device answers with `approved: true`. Unanswered
  prompts expire after `AUTH_APPROVAL_TIMEOUT` (default 60s).
- Single-developer occupancy per room; a second is refused `403 room_busy`
  before the WebSocket upgrade.
- A 64-bit `crypto/rand` room key per room, carried in the QR pairing URL and
  compared in constant time. `REQUIRE_ROOM_KEY` makes it mandatory.
- Per-IP brute-force limiting: 5 failed attempts per minute, then a 10-minute
  block answered with `429` and `Retry-After` before the upgrade.
- Proxy headers (`CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`) honoured
  only when `TRUST_PROXY` is enabled, so they cannot be forged to reset the
  limiter.
- `ALLOWED_ORIGINS` pinning for dashboard connections; device connections are
  exempt because mobile apps connect from arbitrary schemes.

**Data privacy**

- Client-side masking, on by default: sensitive headers, JSON and form body
  keys at any depth, query-string credentials, and cookie values in the storage
  snapshot. Applied before transmission and at the single point every captured
  request funnels through, so the SDK's own cache never holds a raw credential.
- `security.allowRemoteEval` defaults to `false`; the dashboard REPL is answered
  with an explanatory error rather than executing.

**Session lifetime**

- `ROOM_MAX_DURATION` (8h) hard cap and `ROOM_IDLE_TIMEOUT` (30m), enforced by a
  background reaper that notifies both peers with `session_expired` before
  closing sockets.
- `MAX_ROOMS` bounds memory against room-exhaustion attempts.
- Rooms remain entirely in memory; no database, no disk persistence.

**Operations**

- `GET /healthz` reporting aggregate counters only.
- Baseline security headers on every response.
- Configuration via environment variables, documented in `.env.example`.
- `docker-compose.yml` ships the production posture: approval on, origin
  pinning, read-only root filesystem, `no-new-privileges`, healthcheck.

**Interface**

- Warm light and dark themes with a terracotta accent, built on Ant Design 5
  tokens; the mode persists per browser and syncs across tabs.
- Responsive from 390px phones to wide desktops: collapsing header, scrollable
  tabs, tables that scroll in their own container, bottom-sheet drawers.

### Fixed

- **Unauthenticated command routing.** A developer socket that had not paired
  could send `{"type":"exec_js","pin":"<any>"}` and the server forwarded it to
  that room. Routing now uses only the PIN a socket was admitted for, never one
  named in a message payload.
- **Room PINs and keys written to logs.** The access log recorded the full
  request URI. It now records the path only, and application logs truncate PINs
  to `482***`.
- **Dashboard never mounted.** A literal `</script>` inside the inline Babel
  block terminated the element per the HTML tokenizer, truncating the app at
  roughly half its length so `ReactDOM.render` never reached the browser.
- **Theme toggle had no effect.** The dashboard and the root component each held
  their own mode state, synced only through the `storage` event, which does not
  fire in the tab that wrote it, so `ConfigProvider` kept the previous theme.
- **Pairing card unreachable on phones.** Centring an overflowing child with
  `align-items: center` pushed its top out of scroll range; 213px of the card,
  including its heading, could not be scrolled to at 390px.
- **Tab deep links ignored.** `#/room/<pin>/network` always opened Console
  because the hash was rewritten with the not-yet-applied active tab.
- **CI did not check formatting.** The step named "Verify Go Formatting & Vet"
  ran only `go vet`.
- **Dead Docker build stage.** The image built the client SDK in a separate
  stage and then never copied it, since the dashboard is embedded in the Go
  binary and the SDK ships over npm.
- **Bogus npm dependencies.** `server/package.json` declared dependencies on a
  package named `go`, which would install an unrelated package for anyone
  running `npm install` in that directory.

[Unreleased]: https://github.com/chandara-code/vconsole-remote/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/chandara-code/vconsole-remote/releases/tag/v1.0.0
