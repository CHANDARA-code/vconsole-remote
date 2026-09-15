# Security Policy

vConsole Remote brokers live console output, network traffic, storage and
screenshots from real user devices. A weakness here exposes other people's data,
not just the operator's, so security reports get priority over feature work.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub Security Advisories:

> [Report a vulnerability](https://github.com/chandara-code/vconsole-remote/security/advisories/new)

That creates a private thread visible only to you and the maintainers.

Please include, as far as you can:

- What an attacker gains — read another room's traffic, run code on a device,
  deny service, unmask a credential.
- The version or commit you tested, and the server configuration (particularly
  `REQUIRE_DEVICE_APPROVAL`, `REQUIRE_ROOM_KEY` and `TRUST_PROXY`).
- Steps to reproduce. A failing test against `server/` or a short script is
  ideal, but a clear description is enough.

### What to expect

| | |
| --- | --- |
| First response | within 3 business days |
| Assessment and severity | within 7 days |
| Fix for a confirmed high-severity issue | as fast as we can, released as a patch version |

We will credit you in the advisory and the changelog unless you'd rather stay
anonymous. We won't take legal action against good-faith research that follows
this policy.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | ✅ |
| < 1.0 | ❌ |

Fixes land on the latest minor release. There are no long-term support branches
yet.

## Scope

**In scope** — anything that breaks one of the guarantees the project makes:

- Reaching a room's traffic without the device owner approving the session.
- Escaping the single-developer occupancy lock, or hijacking a paired session.
- Bypassing the per-IP brute-force limiter (including via forged proxy headers).
- Recovering a credential the client-side masking is supposed to redact.
- Running JavaScript on a device with `security.allowRemoteEval` left `false`.
- Reading another room's data, or data that should have been purged on
  disconnect or expiry.
- Remote code execution, or crashing the broker from an unauthenticated socket.

**Out of scope** — these are documented trade-offs, not defects:

- Anything that requires the device owner to approve the attacker's session.
  Approval is the trust boundary; a developer you admit sees your traffic.
- Running with `REQUIRE_DEVICE_APPROVAL=false`. That flag exists for local
  development and the test suite, the server warns about it at boot, and the
  documentation says not to use it publicly.
- Guessing a 6-digit PIN in an unbounded number of attempts against a server
  that has disabled rate limiting.
- Trusting forged `X-Forwarded-For` when `TRUST_PROXY=true` is set without an
  actual proxy in front. That configuration is documented as unsafe.
- Sensitive data that the operator chose to expose with
  `security.maskSensitiveData: false`.
- Missing hardening on a deployment served over plain `ws://` rather than
  `wss://`. Transport security is the operator's responsibility.

If you're unsure which side of the line something falls on, report it. We'd
rather triage a non-issue than miss a real one.

## Operator responsibilities

The threat model assumes the operator follows the deployment checklist in the
[README](README.md#deployment-checklist):

- Serve over TLS (`wss://`).
- Leave `REQUIRE_DEVICE_APPROVAL=true`.
- Set `ALLOWED_ORIGINS` to your dashboard's hostname.
- Enable `TRUST_PROXY` only behind a proxy you control.

A deployment that ignores these is outside the model, and issues arising purely
from that configuration are treated as documentation bugs rather than
vulnerabilities.

## Design notes for reviewers

Useful starting points if you're auditing the project:

- `server/room.go` — the pairing handshake, the pending-approval slot, and room
  lifecycle. The approval gate is the primary control.
- `server/security.go` — configuration, the per-IP rate limiter, client-IP
  resolution and origin policy.
- `server/main.go` — pre-upgrade admission checks, which run before a WebSocket
  is ever established.
- `packages/vconsole-remote/src/index.js` — client-side masking, applied before
  transmission, and the remote-evaluation gate.
- `server/security_test.go` — the properties above, written as tests.

Rooms live only in memory (`map[string]*Room`); there is no database and no disk
persistence, so there is no at-rest store to attack.
