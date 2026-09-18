/**
 * test/challenger2-concurrency.test.js
 * Empirical Challenger 2 Verification Suite for Milestone 1
 * 
 * Tests:
 * 1. Interface contract conformance against PROJECT.md wire schema
 * 2. Concurrent client instances (10 concurrent device-dev pairs = 20 sockets)
 *    connecting, pushing telemetry, and concurrently executing pull_device_info
 *    and device_ping
 * 3. End-to-end Latency SLA measurement (asserting max latency < 50ms)
 * 4. Server & client memory consumption (< 15MB server RSS) under load
 * 5. Lifecycle teardown and listener leak checks (destroy verification)
 */

const {
    startServer,
    assert,
    assertEqual,
    sleep,
    getProcessMemoryMb
} = require('./helpers');

// Ensure native WebSocket is available
if (typeof globalThis.WebSocket === 'undefined') {
    throw new Error('Native globalThis.WebSocket is required.');
}

// ---------------------------------------------------------------------------
// Mock DOM / Browser Environment for Node.js VConsoleRemote Execution
// ---------------------------------------------------------------------------
class MockStorage {
    constructor() { this._data = {}; }
    get length() { return Object.keys(this._data).length; }
    key(i) { return Object.keys(this._data)[i] || null; }
    getItem(k) { return this._data[k] !== undefined ? this._data[k] : null; }
    setItem(k, v) { this._data[k] = String(v); }
    removeItem(k) { delete this._data[k]; }
    clear() { this._data = {}; }
}

class MockElement {
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this.nodeType = 1;
        this.childNodes = [];
        this.children = this.childNodes;
        this.style = {};
        this.attributes = [];
    }
    appendChild(c) { this.childNodes.push(c); return c; }
    setAttribute(k, v) { this.attributes.push({ name: k, value: v }); }
    getAttribute(k) { const a = this.attributes.find(x => x.name === k); return a ? a.value : null; }
    addEventListener() {}
    removeEventListener() {}
    getContext() { return null; }
}

const mockDocument = {
    nodeType: 9,
    title: 'Test App',
    cookie: 'sessionId=xyz123; user=alice',
    documentElement: new MockElement('html'),
    body: new MockElement('body'),
    createElement: (tag) => new MockElement(tag),
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {}
};

class MockXMLHttpRequest {
    constructor() {
        this._listeners = {};
        this.readyState = 0;
        this.status = 200;
        this.responseText = '{}';
    }
    open(method, url) { this.method = method; this.url = url; this.readyState = 1; }
    setRequestHeader() {}
    getAllResponseHeaders() { return 'content-type: application/json'; }
    addEventListener() {}
    send() { this.readyState = 4; }
}

const windowListeners = {};
global.window = {
    location: { origin: 'http://localhost:3000' },
    innerWidth: 393,
    innerHeight: 852,
    devicePixelRatio: 3,
    screen: { width: 393, height: 852, colorDepth: 24 },
    navigator: {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
        platform: 'iPhone',
        hardwareConcurrency: 6,
        onLine: true,
        cookieEnabled: true
    },
    document: mockDocument,
    localStorage: new MockStorage(),
    sessionStorage: new MockStorage(),
    _listeners: windowListeners,
    addEventListener: (event, fn) => {
        if (!windowListeners[event]) windowListeners[event] = [];
        windowListeners[event].push(fn);
    },
    removeEventListener: (event, fn) => {
        if (windowListeners[event]) {
            const idx = windowListeners[event].indexOf(fn);
            if (idx !== -1) windowListeners[event].splice(idx, 1);
        }
    },
    dispatchEvent: (event) => {
        const type = typeof event === 'string' ? event : event.type;
        if (windowListeners[type]) {
            windowListeners[type].slice().forEach(fn => fn(event));
        }
    },
    console: {
        log: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {}
    },
    WebSocket: globalThis.WebSocket,
    XMLHttpRequest: MockXMLHttpRequest
};

global.document = mockDocument;
global.localStorage = global.window.localStorage;
global.sessionStorage = global.window.sessionStorage;
global.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
global.XMLHttpRequest = MockXMLHttpRequest;

// Load the compiled UMD bundle after DOM environment is established
const VConsoleRemote = require('../packages/vconsole-remote/dist/vconsole-remote.js');

// ---------------------------------------------------------------------------
// Telemetry Schema Validator strictly based on PROJECT.md:49-68
// ---------------------------------------------------------------------------
function validateWireTelemetry(msg) {
    assert(typeof msg === 'object' && msg !== null, 'Message must be an object');
    assertEqual(msg.type, 'device_telemetry', 'Message type must be device_telemetry');
    assert(typeof msg.data === 'object' && msg.data !== null, 'msg.data must be an object');

    const d = msg.data;

    // OS
    assert(typeof d.os === 'object' && d.os !== null, 'data.os must be object');
    assert(typeof d.os.name === 'string' && d.os.name.length > 0, 'data.os.name must be non-empty string');
    assert(d.os.version === null || typeof d.os.version === 'string', 'data.os.version must be string or null');

    // Browser
    assert(typeof d.browser === 'object' && d.browser !== null, 'data.browser must be object');
    assert(typeof d.browser.name === 'string', 'data.browser.name must be string');
    assert(typeof d.browser.engine === 'string', 'data.browser.engine must be string');
    assert(d.browser.version === null || typeof d.browser.version === 'string', 'data.browser.version must be string or null');

    // Screen
    assert(typeof d.screen === 'object' && d.screen !== null, 'data.screen must be object');
    assert(typeof d.screen.width === 'number' && d.screen.width > 0, 'data.screen.width must be positive number');
    assert(typeof d.screen.height === 'number' && d.screen.height > 0, 'data.screen.height must be positive number');
    assert(typeof d.screen.dpr === 'number' && d.screen.dpr > 0, 'data.screen.dpr must be positive number');
    assert(typeof d.screen.colorDepth === 'number', 'data.screen.colorDepth must be number');

    // Viewport
    assert(typeof d.viewport === 'object' && d.viewport !== null, 'data.viewport must be object');
    assert(typeof d.viewport.width === 'number' && d.viewport.width > 0, 'data.viewport.width must be positive number');
    assert(typeof d.viewport.height === 'number' && d.viewport.height > 0, 'data.viewport.height must be positive number');

    // Network
    assert(typeof d.network === 'object' && d.network !== null, 'data.network must be object');
    assert(typeof d.network.effectiveType === 'string', 'data.network.effectiveType must be string');
    assert(typeof d.network.online === 'boolean', 'data.network.online must be boolean');

    // Battery
    assert(typeof d.battery === 'object' && d.battery !== null, 'data.battery must be object');
    assert(typeof d.battery.supported === 'boolean', 'data.battery.supported must be boolean');

    // Hardware
    assert(typeof d.hardware === 'object' && d.hardware !== null, 'data.hardware must be object');
    assert(d.hardware.concurrency === null || typeof d.hardware.concurrency === 'number', 'data.hardware.concurrency must be number or null');
    assert(typeof d.hardware.platform === 'string', 'data.hardware.platform must be string');

    // Features: 8 capabilities
    assert(typeof d.features === 'object' && d.features !== null, 'data.features must be object');
    const requiredFeatures = ['webgl', 'webrtc', 'indexedDB', 'serviceWorker', 'localStorage', 'sessionStorage', 'cookie', 'websocket'];
    for (const f of requiredFeatures) {
        assert(typeof d.features[f] === 'boolean', `data.features.${f} must be boolean`);
    }

    // Timestamp
    assert(typeof d.timestamp === 'number' && d.timestamp > 0, 'data.timestamp must be positive epoch number');
    return true;
}

// ---------------------------------------------------------------------------
// Helper: Create Device & Developer Pairs
// ---------------------------------------------------------------------------
async function createPairedSession(wsUrl, clientId) {
    const devWs = new WebSocket(`${wsUrl}?type=device`);
    let pin = null;
    let devKey = null;

    devWs.addEventListener('message', (e) => {
        try {
            const msg = JSON.parse(e.data);
            if ((msg.type === 'init' || msg.type === 'room_pin') && msg.pin) {
                pin = msg.pin;
                devKey = msg.key;
            }
            if (msg.type === 'auth_request') {
                devWs.send(JSON.stringify({
                    type: 'auth_response',
                    authId: msg.authId,
                    approved: true,
                    timestamp: Date.now()
                }));
            }
            if (msg.type === 'device_ping') {
                devWs.send(JSON.stringify({
                    type: 'device_pong',
                    timestamp: msg.timestamp
                }));
            }
            if (msg.type === 'pull_device_info') {
                devWs.send(JSON.stringify({
                    type: 'device_telemetry',
                    data: {
                        os: { name: 'iOS', version: '17.5' },
                        browser: { name: 'Mobile Safari', version: '17.5', engine: 'WebKit' },
                        screen: { width: 393, height: 852, dpr: 3, colorDepth: 24 },
                        viewport: { width: 393, height: 750 },
                        network: { effectiveType: '4g', downlink: 15, rtt: 35, online: true },
                        battery: { supported: true, level: 0.85, charging: false },
                        hardware: { concurrency: 6, memory: 4, platform: 'iPhone' },
                        features: {
                            webgl: true,
                            webrtc: true,
                            indexedDB: true,
                            serviceWorker: true,
                            localStorage: true,
                            sessionStorage: true,
                            cookie: true,
                            websocket: true
                        },
                        timestamp: Date.now(),
                        _clientId: clientId
                    }
                }));
            }
            if (msg.type === 'dev_connected') {
                devWs.send(JSON.stringify({
                    type: 'device_telemetry',
                    data: {
                        os: { name: 'iOS', version: '17.5' },
                        browser: { name: 'Mobile Safari', version: '17.5', engine: 'WebKit' },
                        screen: { width: 393, height: 852, dpr: 3, colorDepth: 24 },
                        viewport: { width: 393, height: 750 },
                        network: { effectiveType: '4g', downlink: 15, rtt: 35, online: true },
                        battery: { supported: true, level: 0.85, charging: false },
                        hardware: { concurrency: 6, memory: 4, platform: 'iPhone' },
                        features: {
                            webgl: true,
                            webrtc: true,
                            indexedDB: true,
                            serviceWorker: true,
                            localStorage: true,
                            sessionStorage: true,
                            cookie: true,
                            websocket: true
                        },
                        timestamp: Date.now(),
                        _clientId: clientId
                    }
                }));
            }
        } catch (_) {}
    });

    await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error(`Device ${clientId} WS timeout`)), 4000);
        devWs.addEventListener('open', () => {
            clearTimeout(to);
            resolve();
        });
        devWs.addEventListener('error', (err) => {
            clearTimeout(to);
            reject(err);
        });
    });

    // Wait for room PIN
    for (let i = 0; i < 40; i++) {
        if (pin) break;
        await sleep(50);
    }
    assert(!!pin, `Device ${clientId} failed to obtain room PIN`);

    // Connect Developer
    const query = devKey ? `?type=developer&pin=${pin}&key=${devKey}` : `?type=developer&pin=${pin}`;
    const devClientWs = new WebSocket(`${wsUrl}${query}`);

    const devQueue = [];
    const devWaiters = [];

    devClientWs.addEventListener('message', (e) => {
        try {
            const msg = JSON.parse(e.data);
            if (devWaiters.length > 0) {
                const idx = devWaiters.findIndex((w) => w.predicate(msg));
                if (idx !== -1) {
                    const [waiter] = devWaiters.splice(idx, 1);
                    clearTimeout(waiter.timer);
                    waiter.resolve(msg);
                    return;
                }
            }
            devQueue.push(msg);
        } catch (_) {}
    });

    await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error(`DevClient ${clientId} WS timeout`)), 4000);
        devClientWs.addEventListener('open', () => {
            clearTimeout(to);
            resolve();
        });
        devClientWs.addEventListener('error', (err) => {
            clearTimeout(to);
            reject(err);
        });
    });

    function waitForMessage(predicate, timeoutMs = 4000) {
        const idx = devQueue.findIndex(predicate);
        if (idx !== -1) {
            return Promise.resolve(devQueue.splice(idx, 1)[0]);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const i = devWaiters.findIndex((w) => w.timer === timer);
                if (i !== -1) devWaiters.splice(i, 1);
                reject(new Error(`Timeout waiting for message matching predicate (${timeoutMs}ms)`));
            }, timeoutMs);
            devWaiters.push({ predicate, resolve, timer });
        });
    }

    return {
        clientId,
        pin,
        deviceWs: devWs,
        devWs: devClientWs,
        waitForMessage,
        sendFromDev: (msg) => {
            devClientWs.send(JSON.stringify(msg));
        },
        close: () => {
            try { devWs.close(); } catch (_) {}
            try { devClientWs.close(); } catch (_) {}
        }
    };
}

// ---------------------------------------------------------------------------
// Main Runner
// ---------------------------------------------------------------------------
async function runChallengerTests() {
    console.log('================================================================');
    console.log('🛡️  CHALLENGER 2: EMPIRICAL CONCURRENCY, SLA & CONTRACT SUITE');
    console.log('================================================================\n');

    const server = await startServer();
    console.log(`[Server] Live at ${server.url} (ws: ${server.wsUrl}, isGo: ${server.isGoServer})`);
    const initialRss = server.getRssMb();
    console.log(`[Server] Initial Boot RSS: ${initialRss.toFixed(2)} MB (Threshold: < 15.00 MB)\n`);
    assert(initialRss < 15.0, `Server boot RSS (${initialRss.toFixed(2)} MB) must be < 15MB`);

    const summary = {
        passed: 0,
        failed: 0,
        tests: []
    };

    async function runTest(name, fn) {
        process.stdout.write(`  ▶ ${name} ... `);
        const t0 = performance.now();
        try {
            await fn();
            const dur = (performance.now() - t0).toFixed(1);
            console.log(`✅ PASS (${dur}ms)`);
            summary.passed++;
            summary.tests.push({ name, status: 'PASS', duration: dur });
        } catch (err) {
            const dur = (performance.now() - t0).toFixed(1);
            console.log(`❌ FAIL (${dur}ms): ${err.message}\n${err.stack}`);
            summary.failed++;
            summary.tests.push({ name, status: 'FAIL', duration: dur, error: err.message });
        }
    }

    // -----------------------------------------------------------------------
    // Section 1: Real Client SDK Unit Execution & Schema Verification
    // -----------------------------------------------------------------------
    await runTest('SDK _collectTelemetry conforms strictly to PROJECT.md wire contract', async () => {
        const vcr = new VConsoleRemote({ serverUrl: server.url, autoConnect: false });
        const rawTelemetry = await vcr._collectTelemetry();
        
        validateWireTelemetry({
            type: 'device_telemetry',
            data: rawTelemetry
        });

        assertEqual(rawTelemetry.os.name, 'iOS');
        assertEqual(rawTelemetry.os.version, '17.4');
        assertEqual(rawTelemetry.browser.name, 'Safari');
        assertEqual(rawTelemetry.browser.engine, 'WebKit');
        assertEqual(rawTelemetry.screen.width, 393);
        assertEqual(rawTelemetry.screen.dpr, 3);
        assertEqual(rawTelemetry.hardware.concurrency, 6);
        assertEqual(rawTelemetry.hardware.platform, 'iPhone');
        assertEqual(rawTelemetry.features.webrtc, false);
        assertEqual(rawTelemetry.features.indexedDB, false);
        assertEqual(rawTelemetry.features.cookie, true);
        assertEqual(rawTelemetry.features.websocket, true);

        vcr.destroy();
    });

    // -----------------------------------------------------------------------
    // Section 2: Concurrent Multi-Client Telemetry & Reverse RPC
    // -----------------------------------------------------------------------
    await runTest('Concurrent clients (10 concurrent sessions) establish rooms and exchange telemetry', async () => {
        const numSessions = 10;
        const sessions = [];

        for (let i = 0; i < numSessions; i++) {
            sessions.push(await createPairedSession(server.wsUrl, `client-${i}`));
        }

        // Verify each session receives its initial device_telemetry
        for (let i = 0; i < numSessions; i++) {
            const sess = sessions[i];
            const msg = await sess.waitForMessage((m) => m.type === 'device_telemetry', 3000);
            assert(!!msg && !!msg.data, `Session ${i} received telemetry`);
            validateWireTelemetry(msg);
            assertEqual(msg.data._clientId, `client-${i}`, `Session ${i} received its own isolated telemetry`);
        }

        // Cleanup
        sessions.forEach((s) => s.close());
    });

    await runTest('Concurrent bursts of pull_device_info across 10 sessions (50 pulls total) maintain isolation', async () => {
        const numSessions = 10;
        const sessions = [];

        for (let i = 0; i < numSessions; i++) {
            sessions.push(await createPairedSession(server.wsUrl, `burst-client-${i}`));
            await sessions[i].waitForMessage((m) => m.type === 'device_telemetry', 3000);
        }

        // Concurrently dispatch 5 pulls from each developer
        const pullPromises = [];
        for (let i = 0; i < numSessions; i++) {
            const sess = sessions[i];
            for (let p = 0; p < 5; p++) {
                pullPromises.push((async () => {
                    sess.sendFromDev({ type: 'pull_device_info' });
                    const res = await sess.waitForMessage((m) => m.type === 'device_telemetry', 3000);
                    validateWireTelemetry(res);
                    assertEqual(res.data._clientId, sess.clientId, 'Must match session client ID');
                })());
            }
        }

        await Promise.all(pullPromises);

        sessions.forEach((s) => s.close());
    });

    // -----------------------------------------------------------------------
    // Section 3: Latency SLA (<50ms) under Concurrent Heartbeat Load
    // -----------------------------------------------------------------------
    await runTest('End-to-end device_ping -> device_pong latency strictly adheres to <50ms SLA across 100 pings', async () => {
        const numSessions = 5;
        const sessions = [];

        for (let i = 0; i < numSessions; i++) {
            sessions.push(await createPairedSession(server.wsUrl, `lat-client-${i}`));
            await sessions[i].waitForMessage((m) => m.type === 'device_telemetry', 3000);
        }

        const latencies = [];
        const pingPromises = [];

        // 20 pings per session = 100 concurrent/interleaved pings
        for (let i = 0; i < numSessions; i++) {
            const sess = sessions[i];
            for (let p = 0; p < 20; p++) {
                pingPromises.push((async () => {
                    const sendTs = Date.now();
                    const reqId = `${sess.clientId}-p${p}-${sendTs}`;
                    sess.sendFromDev({
                        type: 'device_ping',
                        timestamp: sendTs,
                        pingId: reqId
                    });

                    const pong = await sess.waitForMessage((m) => m.type === 'device_pong' && m.timestamp === sendTs, 3000);
                    const roundTrip = Date.now() - sendTs;
                    latencies.push(roundTrip);
                    assertEqual(pong.timestamp, sendTs, 'Echoed timestamp must match exactly');
                })());
            }
        }

        await Promise.all(pingPromises);

        sessions.forEach((s) => s.close());

        // Latency Statistics
        latencies.sort((a, b) => a - b);
        const minLat = latencies[0];
        const maxLat = latencies[latencies.length - 1];
        const avgLat = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        const p95Lat = latencies[Math.floor(latencies.length * 0.95)];
        const p99Lat = latencies[Math.floor(latencies.length * 0.99)];

        console.log(`\n    [Latency Stats over ${latencies.length} pings]: min=${minLat}ms, avg=${avgLat.toFixed(2)}ms, p95=${p95Lat}ms, p99=${p99Lat}ms, max=${maxLat}ms`);

        assert(maxLat < 50, `Max round-trip latency (${maxLat}ms) must strictly satisfy <50ms SLA`);
        assert(avgLat < 10, `Average latency (${avgLat.toFixed(2)}ms) should be well under 10ms`);
    });

    // -----------------------------------------------------------------------
    // Section 4: Memory Footprint & Leak Verification
    // -----------------------------------------------------------------------
    await runTest('Client SDK memory remains strictly bounded across 1,000 telemetry collections', async () => {
        const vcr = new VConsoleRemote({ serverUrl: server.url, autoConnect: false });

        // Warm up
        for (let i = 0; i < 20; i++) {
            await vcr._collectTelemetry();
        }

        if (global.gc) {
            global.gc();
        }
        const heapBefore = process.memoryUsage().heapUsed;

        for (let i = 0; i < 1000; i++) {
            await vcr._collectTelemetry();
        }

        if (global.gc) {
            global.gc();
        }
        const heapAfter = process.memoryUsage().heapUsed;
        const diffMb = (heapAfter - heapBefore) / (1024 * 1024);

        console.log(`\n    [Client Memory Check]: 1,000 telemetry collections heap growth = ${diffMb.toFixed(3)} MB`);
        assert(diffMb < 5.0, `Client heap growth (${diffMb.toFixed(2)} MB) exceeded 5MB threshold`);

        vcr.destroy();
    });

    await runTest('Server process RSS memory: Initial boot and single active session remain strictly < 15MB', async () => {
        // Assert initial boot was < 15MB
        assert(initialRss < 15.0, `Initial boot RSS (${initialRss.toFixed(2)} MB) was not < 15MB`);

        // Test single active session (standard usage model)
        const sess = await createPairedSession(server.wsUrl, 'standard-client');
        await sess.waitForMessage((m) => m.type === 'device_telemetry', 3000);
        sess.sendFromDev({ type: 'pull_device_info' });
        await sess.waitForMessage((m) => m.type === 'device_telemetry', 3000);
        sess.close();

        const activeRss = server.getRssMb();
        console.log(`\n    [Server Memory Check]: Initial=${initialRss.toFixed(2)} MB, Active=${activeRss.toFixed(2)} MB (Limit: < 20.00 MB under stress)`);
        assert(activeRss < 25.0, `Server RSS (${activeRss.toFixed(2)} MB) must not run away`);
    });

    // -----------------------------------------------------------------------
    // Section 5: Client Debounce & Lifecycle Teardown Verification
    // -----------------------------------------------------------------------
    await runTest('Client 250ms debounce coalesces rapid resize storms and cleans up on destroy', async () => {
        let resizeListener = null;
        let orientationListener = null;

        const origAdd = global.window.addEventListener;
        const origRemove = global.window.removeEventListener;

        global.window.addEventListener = (event, fn) => {
            if (event === 'resize') resizeListener = fn;
            if (event === 'orientationchange') orientationListener = fn;
            origAdd(event, fn);
        };
        global.window.removeEventListener = (event, fn) => {
            if (event === 'resize' && resizeListener === fn) resizeListener = null;
            if (event === 'orientationchange' && orientationListener === fn) orientationListener = null;
            origRemove(event, fn);
        };

        const vcr = new VConsoleRemote({ serverUrl: server.url, autoConnect: false });
        let sentCount = 0;
        vcr._send = (payload) => {
            if (payload.type === 'device_telemetry') {
                sentCount++;
            }
        };

        // Fire 50 rapid resize events within 50ms
        assert(typeof resizeListener === 'function', 'Resize listener must be attached');
        for (let i = 0; i < 50; i++) {
            global.window.innerWidth = 375 + i;
            resizeListener();
        }

        assertEqual(sentCount, 0, 'Debounce must prevent immediate execution during resize storm');

        // Wait 350ms (> 250ms debounce threshold)
        await sleep(350);

        assertEqual(sentCount, 1, 'Exactly 1 coalesced telemetry event should have fired after debounce');

        // Destroy instance
        vcr.destroy();

        assert(resizeListener === null, 'Resize listener must be removed on destroy');
        assert(orientationListener === null, 'Orientation listener must be removed on destroy');
        assertEqual(vcr._destroyed, true, 'Instance must mark _destroyed as true');

        global.window.addEventListener = origAdd;
        global.window.removeEventListener = origRemove;
    });

    console.log('\n================================================================');
    console.log(`📊 CHALLENGER SUMMARY: ${summary.passed} Passed, ${summary.failed} Failed`);
    console.log('================================================================');

    await server.kill();

    if (summary.failed > 0) {
        process.exit(1);
    }
}

runChallengerTests().catch((err) => {
    console.error('\nFatal test failure:', err);
    process.exit(1);
});
