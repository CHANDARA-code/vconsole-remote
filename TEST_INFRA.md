# vConsole Remote — Test Infrastructure Specification (TEST_INFRA.md)
# UI/UX Modernization & Device-Aware Debugging Track

## 1. Overview & Testing Philosophy

`vConsole Remote` provides real-time, browser-based remote debugging for mobile web applications running Tencent vConsole through an ultra-lightweight, zero-build embedded Go WebSocket broker and a zero-build desktop web dashboard.

This document defines the **Test Infrastructure & Quality Assurance Specification** for the UI/UX Modernization & Device-Aware Debugging Track (inspired by PageSpy DevTools design principles).

### Core Testing Principles

1. **Opaque-Box Requirement-Driven Verification**:
   Tests evaluate the system strictly through observable inputs, outputs, wire-level WebSocket JSON contracts, HTTP interfaces, and DOM state structures. Tests do not rely on private internal object states, ensuring refactorings and architecture modernizations preserve behavioral fidelity.

2. **Deterministic Independence & Isolation**:
   Every test case provisions its own isolated communication session (unique 6-digit room PIN), manages simulated device and developer peers, cleans up connections upon completion, and executes deterministically regardless of execution order or concurrency.

3. **Zero External Test Framework Dependencies**:
   The test runner leverages Node.js native runtime capabilities (`globalThis.WebSocket`, `performance.now()`, `child_process`, `crypto`, and Node test assertions), ensuring fast execution (< 5 seconds for full suite) with zero third-party npm package overhead or version drift.

4. **Dual Execution Engine (Live Go Binary & Reference Broker)**:
   Tests can execute against the production compiled Go server binary (`server/vconsole-remote`) measuring real OS process RSS memory and TCP socket performance, or against a built-in hermetic reference broker.

5. **4-Tier Testing Methodology**:
   - **Tier 1 — Category-Partition**: Isolates each functional capability into equivalence classes and exercises primary happy paths.
   - **Tier 2 — Boundary Value Analysis (BVA)**: Probes extremes, zero/null values, missing browser APIs, offline transitions, special characters, and boundary payload sizes.
   - **Tier 3 — Pairwise & Cross-Feature Interactions**: Evaluates concurrent operations, interleaved protocols, and multi-feature pipelines (e.g., REPL commands triggering network/console events).
   - **Tier 4 — Realistic Workload Simulation**: Replays complete end-to-end mobile debugging sessions combining device telemetry, latency heartbeats, console logging, network inspection, and REPL interactions under strict latency and memory constraints.

---

## 2. Modernization Feature Inventory Coverage

The UI/UX Modernization track introduces 6 major capability areas. The testing infrastructure provides exhaustive coverage across each area:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                    UI/UX Modernization Feature Inventory                         │
├───────────────────────┬──────────────────────────────────────────────────────────┤
│ Feature Area          │ Functional Capabilities Covered                          │
├───────────────────────┼──────────────────────────────────────────────────────────┤
│ 1. Device Telemetry   │ • Deep device environment collection                     │
│    Collection & Schema│ • OS, browser engine, screen, viewport, DPR, connection  │
│                       │ • Battery status (level, charging, support detection)    │
│                       │ • Browser features matrix (WebGL, WebRTC, storage, etc.) │
│                       │ • Multi-tier triggers: connect, resize (250ms debounced) │
├───────────────────────┼──────────────────────────────────────────────────────────┤
│ 2. Latency Ping/Pong  │ • End-to-end heartbeat protocol                          │
│    Protocol           │ • `device_ping` -> Go Broker -> Device -> `device_pong`  │
│                       │ • Timestamp round-trip latency calculation               │
│                       │ • Latency threshold assertion (< 50ms SLA)               │
├───────────────────────┼──────────────────────────────────────────────────────────┤
│ 3. Network Split-View │ • Responsive master-detail two-pane layout               │
│    & Sub-Tabs         │ • Request list on left, inspection panel on right        │
│                       │ • Sub-tab 1: Headers (General, Request, Response)        │
│                       │ • Sub-tab 2: Payload (Query String Params, Request Body) │
│                       │ • Sub-tab 3: Response (Body preview, Copy, Pull on-demand)│
│                       │ • Keyboard navigation: Escape (close), Arrows (navigate) │
├───────────────────────┼──────────────────────────────────────────────────────────┤
│ 4. Top Bar Telemetry  │ • Device OS pill (e.g. "iOS 17.4", "Android 14")         │
│    Pills              │ • Screen resolution pill (e.g. "393×852 @3x")            │
│                       │ • Network type pill (e.g. "4G (10Mbps)", "WiFi")         │
│                       │ • Real-time latency pill (e.g. "Ping: 18ms")             │
│                       │ • Responsive visibility (`.hide-on-mobile`)              │
├───────────────────────┼──────────────────────────────────────────────────────────┤
│ 5. System Information │ • Dedicated `key: "system"` tab in dashboard             │
│    Panel & Refresh    │ • 6-card responsive grid: OS, Display, Network, Battery, │
│                       │   Features Matrix, Hardware Sensors                      │
│                       │ • On-demand `pull_device_info` refresh action            │
├───────────────────────┼──────────────────────────────────────────────────────────┤
│ 6. Console Ergonomics │ • Docked monospace bottom command prompt (#console-repl) │
│    & Bottom REPL      │ • Enter key execution via `exec_js`                      │
│                       │ • Caret-aware ArrowUp / ArrowDown history navigation     │
│                       │ • Colored log level badges (Errors, Warnings, Info counts)│
│                       │ • In-stream command (`>`) and result (`<`) display       │
└───────────────────────┴──────────────────────────────────────────────────────────┘
```

---

## 3. 4-Tier Test Architecture Breakdown

### Tier 1: Feature Coverage (Category-Partition)
- **Objective**: Verify isolated happy-path execution of every new protocol message and UI data contract.
- **Coverage Areas**:
  1. *Telemetry Push*: Device automatically emits `device_telemetry` frame upon developer connection; validates all required fields (`os`, `browser`, `screen`, `viewport`, `network`, `battery`, `hardware`, `features`, `timestamp`).
  2. *Telemetry Resize Trigger*: Device emits updated telemetry upon viewport dimension changes.
  3. *Latency Ping/Pong*: Developer dispatches `device_ping` with high-resolution epoch timestamp; device immediately responds with `device_pong` echoing the exact timestamp; developer computes `Date.now() - timestamp`.
  4. *On-Demand System Pull*: Developer dispatches `pull_device_info`; device generates and returns fresh `device_telemetry` payload.
  5. *Network Split-View Data Structure*: Verifies structure containing General HTTP status, URL, Method, Request/Response Headers, parsed Query String parameters, Request Body payload, and Response Body.
  6. *Console REPL Streaming*: Developer dispatches `exec_js`; device returns `exec_js_result`; output lines formatted into stream items with chronological timestamps.
  7. *Console Log Level Badges*: Aggregates log streams and computes exact counts for `error`, `warn`, and `info` badges with instant filter toggles.

### Tier 2: Boundary & Corner Cases (Boundary Value Analysis)
- **Objective**: Stress edge conditions, defensive fallbacks, missing APIs, and anomalous payloads.
- **Coverage Areas**:
  1. *Missing Battery API Fallback*: Emulates WebKit/Safari where `navigator.getBattery` is `undefined`; ensures client reports `supported: false`, `level: null`, `charging: null` without throwing runtime errors.
  2. *Missing Network Information API*: Emulates browsers where `navigator.connection` is missing; falls back gracefully to `navigator.onLine` (`online: true/false`, `effectiveType: "unknown"`, `downlink: null`, `rtt: null`).
  3. *Zero & Edge Battery States*: Validates 0% depleted battery (`level: 0.0`), 100% full battery (`level: 1.0`), and charging state transitions.
  4. *Special Characters in REPL Commands*:
     - Multi-byte Unicode, emojis, and non-Latin scripts (e.g. `console.log("🚀 调试测试 123")`, Khmer, Arabic).
     - Multiline scripts containing raw `\n`, `\r\n`, tabs, and escaped backslashes.
     - Single quotes, double quotes, nested template literals, and unbalanced syntax errors (`{ invalid: [ }`).
     - Runtime exceptions (`throw new Error("Simulated Crash")`) properly returning `isError: true` with error stack traces.
  5. *Empty & Extreme Network Payloads*:
     - Zero-byte / empty request body and response body (`""`, `null`, `{}`).
     - Oversized request/response bodies (>100KB JSON, base64 data) ensuring transport stability without buffer corruption.
     - Complex query strings with multiple repeated keys (`?tag=a&tag=b&filter=true`), URI encoded characters, and empty values.

### Tier 3: Cross-Feature Interactions (Pairwise Combinations)
- **Objective**: Validate behavior when multiple modernization features interact concurrently.
- **Coverage Areas**:
  1. *REPL Execution Triggering Network & Console Events*: Evaluates an `exec_js` script that performs a `fetch()` request and logs to `console.error`; verifies the developer client receives all three resulting frames (`exec_js_result`, `network_request`, `log`) without message interleaving corruption.
  2. *Telemetry Pull During Active Network Inspection*: Developer dispatches `pull_device_info` while high-frequency network requests are streaming; verifies neither stream drops or corrupts payloads.
  3. *Continuous Latency Heartbeats During Heavy Log Stream*: Simulates 50+ rapid console logs while latency ping/pong cycles continue concurrently; verifies latency remains < 50ms SLA.
  4. *Orientation/Resize Telemetry Debouncing*: Rapidly triggers resize events within 100ms; verifies client debounces to prevent socket saturation.

### Tier 4: Real-World Workload Simulation
- **Objective**: Execute end-to-end user journeys mirroring production mobile web debugging.
- **Coverage Areas**:
  1. *Full Modernized Remote Debugging Lifecycle*:
     - Step 1: Mobile device initiates session and receives 6-digit PIN.
     - Step 2: Developer pairs using PIN.
     - Step 3: Device streams initial telemetry; top bar pills update (OS, Screen, Network, Latency).
     - Step 4: Developer triggers latency ping and verifies sub-50ms roundtrip.
     - Step 5: Mobile device generates multi-level logs (log, info, warn, error); developer asserts badge counts update (e.g., Errors: 1, Warns: 2, Info: 3).
     - Step 6: Mobile app triggers REST API call with query params and JSON payload; developer inspects master-detail split view (Headers tab, Payload tab, Response tab).
     - Step 7: Developer executes REPL command to inspect mobile app state (`document.title`, `window.innerWidth`).
     - Step 8: Developer triggers "Refresh System Info" and verifies all 6 cards in System tab reflect latest device state.
     - Step 9: Clean session teardown, socket closing, and assertion of Go server process RSS memory (< 15MB).

---

## 4. Interface Contracts & Protocol Wire Schemas

### 4.1 Device Telemetry (`device_telemetry`)
- **Direction**: Device -> Broker -> Developer
- **Triggers**: Developer connection (`dev_connected`), debounced resize/orientation (250ms), or on-demand `pull_device_info`.
- **Wire Schema**:
```json
{
  "type": "device_telemetry",
  "data": {
    "os": {
      "name": "iOS",
      "version": "17.4"
    },
    "browser": {
      "name": "Safari",
      "version": "17.4",
      "engine": "WebKit"
    },
    "screen": {
      "width": 393,
      "height": 852,
      "dpr": 3,
      "colorDepth": 24
    },
    "viewport": {
      "width": 393,
      "height": 750
    },
    "network": {
      "effectiveType": "4g",
      "downlink": 10,
      "rtt": 50,
      "online": true
    },
    "battery": {
      "supported": false,
      "level": null,
      "charging": null
    },
    "hardware": {
      "concurrency": 6,
      "memory": null,
      "platform": "iPhone"
    },
    "features": {
      "webgl": true,
      "webrtc": true,
      "indexedDB": true,
      "serviceWorker": true,
      "localStorage": true,
      "sessionStorage": true,
      "cookie": true,
      "websocket": true
    },
    "timestamp": 1726473600000
  }
}
```

### 4.2 On-Demand System Info Pull (`pull_device_info`)
- **Direction**: Developer -> Broker -> Device
- **Payload**:
```json
{
  "type": "pull_device_info"
}
```
- **Response**: Device returns `device_telemetry` schema above.

### 4.3 Latency Heartbeat Protocol (`device_ping` / `device_pong`)
- **Ping (Developer -> Broker -> Device)**:
```json
{
  "type": "device_ping",
  "timestamp": 1726473600000
}
```
- **Pong (Device -> Broker -> Developer)**:
```json
{
  "type": "device_pong",
  "timestamp": 1726473600000
}
```
- **Latency Formula**: `latencyMs = Date.now() - msg.timestamp`. Must be strictly `< 50.0 ms`.

### 4.4 Network Master-Detail Model (`network_request` & `network_body_data`)
- **Request Metadata Wire Schema**:
```json
{
  "type": "network_request",
  "request": {
    "id": "req-1726473600001",
    "method": "POST",
    "url": "https://api.example.com/v1/checkout?promo=SUMMER26&step=2",
    "status": 200,
    "duration": 42,
    "headers": {
      "Accept": "application/json",
      "Content-Type": "application/json; charset=utf-8",
      "Authorization": "Bearer tok_***"
    },
    "responseHeaders": {
      "Content-Type": "application/json",
      "X-Request-Id": "req-edge-99"
    },
    "queryParams": {
      "promo": "SUMMER26",
      "step": "2"
    },
    "requestBody": "{\"cartId\": 491, \"paymentMethod\": \"apple_pay\"}",
    "timestamp": 1726473600001
  }
}
```
- **On-Demand Response Body Pull**:
```json
{
  "type": "pull_network_body",
  "requestId": "req-1726473600001"
}
```
- **Response Body Reply**:
```json
{
  "type": "network_body_data",
  "requestId": "req-1726473600001",
  "body": "{\"orderId\": \"ORD-98721\", \"status\": \"CONFIRMED\"}"
}
```

---

## 5. Performance & Resource SLAs

| Metric | Threshold | Testing Method |
|---|---|---|
| **E2E Latency (Ping/Pong)** | `< 50.0 ms` | Measured via `device_ping` -> `device_pong` roundtrip over WebSocket broker |
| **Console Log Push Latency** | `< 50.0 ms` | High-resolution timestamp differential (`performance.now()`) from push to receive |
| **Server Process RSS Memory** | `< 15.00 MB` | Sampled via `ps -o rss= -p <PID>` during active peak WebSocket traffic |
| **Modernization Test Suite Time** | `< 10.0 s` | Total wall-clock time for 4 tiers and ~40 tests |
| **Pass Rate Threshold** | `100.0%` | Zero failed assertions permitted for production release gate |

---

## 6. Test Suite Execution Guide

### Running the Modernization E2E Test Suite

```bash
# Run the UI/UX Modernization E2E test suite standalone
node test/modernization-e2e.test.js

# Run full project automated test pipeline
npm test

# Run client SDK tests
npm run test:client

# Run Go server unit tests
npm run test:server
```
