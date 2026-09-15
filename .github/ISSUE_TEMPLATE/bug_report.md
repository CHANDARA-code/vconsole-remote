---
name: Bug report
about: Create a report to help us improve vConsole Remote
title: "[BUG] "
labels: bug
assignees: ""
---

**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:

1. Initialize client with `...`
2. Start server with `...`
3. Connect developer browser to `...`
4. See error

**Expected behavior**
A clear and concise description of what you expected to happen.

**Environment (please complete the following information):**

- OS: [e.g. macOS, Ubuntu, Windows]
- Browser / Mobile Device: [e.g. Chrome 124, iOS Safari 17.4, WeChat Mini Program]
- Node.js version: [e.g. 20.12.0, 22.0.0]
- Go version: [e.g. 1.21, 1.22]
- vConsole Remote version: [e.g. 1.0.0]
- How the server is deployed: [e.g. local `go run .`, Docker, behind Cloudflare]

**Server configuration**
Pairing behaviour depends heavily on these, so please include them if the issue
involves connecting, disconnecting, or data you did or didn't expect to see:

- `REQUIRE_DEVICE_APPROVAL`: [default `true`]
- `REQUIRE_ROOM_KEY`: [default `false`]
- `TRUST_PROXY`: [default `false`]
- `ALLOWED_ORIGINS`: [default empty]
- SDK `security` options, if you set any: [e.g. `maskSensitiveData: false`]

**Additional context**
Add any other context, console logs, or screenshots about the problem here.

> Please redact room PINs, room keys and any real credentials before pasting
> logs. If the problem *is* a security weakness, close this and use a
> [private advisory](https://github.com/chandara-code/vconsole-remote/security/advisories/new)
> instead.
