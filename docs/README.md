# Documentation

Reference material that doesn't belong in the top-level README.

## Current

| Document | What it covers |
| --- | --- |
| [TEST_INFRA.md](TEST_INFRA.md) | Test architecture: the four tiers, the harness, and how the E2E suite drives a real server binary. |
| [RELEASING.md](RELEASING.md) | How to cut a release — version bump, tag, npm publish, binaries. |

For the security model, configuration reference and deployment checklist, see
the [Security section of the README](../README.md#security), [`.env.example`](../.env.example)
and [SECURITY.md](../SECURITY.md).

## Historical

These are snapshots from earlier in the project's development. They are kept
because they record *why* certain decisions were made, but they describe an
older code layout (`server/src/main.go`, which no longer exists) and their
findings have since been addressed. **Do not read them as current state.**

| Document | What it was |
| --- | --- |
| [PROJECT.md](PROJECT.md) | A code review and security audit of an early revision. Every issue it flags — PIN entropy, WebSocket concurrency, brute-force exposure, origin checking, remote code execution, dashboard XSS — has since been fixed; see the table below. |
| [SUMMARY.md](SUMMARY.md) | An implementation summary written when the project scaffolding first landed. |
| [TEST_READY.md](TEST_READY.md) | A dated test-readiness report (2026-09-04). Superseded by CI, which runs the same suites on every pull request. |
| [test-implementation.js](test-implementation.js) | A scaffold-era script that checked the file layout existed. Superseded by the real test suites. |

### How the old audit findings were resolved

| Audit finding | Resolution |
| --- | --- |
| PIN generation & entropy | `crypto/rand` with bounded collision retry — `server/room.go` |
| WebSocket concurrency safety | `SafeConn` mutex wrapper — `server/safeconn.go` |
| PIN brute-force & auth model (CVSS 9.8) | On-device approval gate, per-IP rate limiting, single-developer occupancy, optional room key — `server/room.go`, `server/security.go` |
| WebSocket origin / hijacking (CVSS 8.8) | `ALLOWED_ORIGINS` pinning for dashboard connections — `server/security.go` |
| Remote code execution via `exec_js` (CVSS 9.8) | Disabled by default; `security.allowRemoteEval` must be explicitly enabled by the app — `packages/vconsole-remote/src/index.js` |
| Dashboard XSS (CVSS 7.5) | No `dangerouslySetInnerHTML` or `innerHTML` anywhere; React escapes interpolated values and the SDK builds DOM with `textContent` |
| Static binary & `embed.FS` | Dashboard embedded and served from the binary — `server/main.go` |
| Build verification | `gofmt`, `go vet`, `go test -race`, `govulncheck`, SDK build and a Docker image smoke test all run in CI |

Each of these is covered by a test in `server/security_test.go` or
`packages/vconsole-remote/test/`.
