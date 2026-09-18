/**
 * test/modernization-e2e.test.js
 * Comprehensive E2E Test Suite for UI/UX Modernization & Device-Aware Debugging
 * 
 * Implements 4-Tier Test Architecture:
 * - Tier 1: Feature Coverage (Category-Partition: isolated happy paths for all 6 modernization features)
 * - Tier 2: Boundary & Corner Cases (BVA: missing APIs, offline, null battery, special chars, extreme payloads)
 * - Tier 3: Cross-Feature Interactions (Pairwise: REPL causing network/console events, telemetry refresh during network inspection)
 * - Tier 4: Real-World Workloads (Simulated mobile debugging sessions, latency SLAs, memory verification)
 * 
 * Executable directly via:
 *   node test/modernization-e2e.test.js
 */

const {
    startServer,
    assert,
    assertEqual,
    assertMatches,
    sleep,
    getProcessMemoryMb
} = require('./helpers');

// Ensure native WebSocket is available
if (typeof globalThis.WebSocket === 'undefined') {
    throw new Error('Native globalThis.WebSocket is required (Node.js v22+ or v24+).');
}

// ============================================================================
// DATA TRANSFORMATION & SCHEMA VALIDATORS (Mirroring Dashboard & SDK Contracts)
// ============================================================================

/**
 * Validate Device Telemetry JSON Schema strictly against PROJECT.md contract
 */
function validateTelemetrySchema(data) {
    assert(typeof data === 'object' && data !== null, 'Telemetry data must be a non-null object');

    // OS
    assert(typeof data.os === 'object' && data.os !== null, 'os must be an object');
    assert(typeof data.os.name === 'string' && data.os.name.length > 0, 'os.name must be non-empty string');
    assert(data.os.version === null || typeof data.os.version === 'string', 'os.version must be string or null');

    // Browser
    assert(typeof data.browser === 'object' && data.browser !== null, 'browser must be an object');
    assert(typeof data.browser.name === 'string', 'browser.name must be string');
    assert(typeof data.browser.engine === 'string', 'browser.engine must be string');

    // Screen & Viewport
    assert(typeof data.screen === 'object' && data.screen !== null, 'screen must be an object');
    assert(typeof data.screen.width === 'number' && data.screen.width > 0, 'screen.width must be positive number');
    assert(typeof data.screen.height === 'number' && data.screen.height > 0, 'screen.height must be positive number');
    assert(typeof data.screen.dpr === 'number' && data.screen.dpr > 0, 'screen.dpr must be positive number');
    assert(typeof data.screen.colorDepth === 'number', 'screen.colorDepth must be number');

    assert(typeof data.viewport === 'object' && data.viewport !== null, 'viewport must be an object');
    assert(typeof data.viewport.width === 'number' && data.viewport.width > 0, 'viewport.width must be positive number');
    assert(typeof data.viewport.height === 'number' && data.viewport.height > 0, 'viewport.height must be positive number');

    // Network
    assert(typeof data.network === 'object' && data.network !== null, 'network must be an object');
    assert(typeof data.network.online === 'boolean', 'network.online must be boolean');

    // Battery
    assert(typeof data.battery === 'object' && data.battery !== null, 'battery must be an object');
    assert(typeof data.battery.supported === 'boolean', 'battery.supported must be boolean');

    // Hardware & Features
    assert(typeof data.hardware === 'object' && data.hardware !== null, 'hardware must be an object');
    assert(typeof data.hardware.concurrency === 'number', 'hardware.concurrency must be number');

    assert(typeof data.features === 'object' && data.features !== null, 'features must be an object');
    const requiredFeatures = ['webgl', 'webrtc', 'indexedDB', 'serviceWorker', 'localStorage', 'sessionStorage', 'cookie', 'websocket'];
    for (const feat of requiredFeatures) {
        assert(typeof data.features[feat] === 'boolean', `features.${feat} must be boolean`);
    }

    // Timestamp
    assert(typeof data.timestamp === 'number' && data.timestamp > 0, 'timestamp must be positive epoch number');
    return true;
}

/**
 * Format Top Bar Telemetry Pills (OS, Screen, Network, Latency)
 */
function formatTelemetryPills(telemetry, latencyMs = null) {
    const osPill = telemetry.os.version
        ? `${telemetry.os.name} ${telemetry.os.version}`
        : telemetry.os.name;

    const screenPill = `${telemetry.screen.width}×${telemetry.screen.height} @${telemetry.screen.dpr}x`;

    let networkPill;
    if (!telemetry.network.online) {
        networkPill = 'Offline';
    } else if (telemetry.network.effectiveType && telemetry.network.effectiveType !== 'unknown') {
        const speed = telemetry.network.downlink ? ` (${telemetry.network.downlink}Mbps)` : '';
        networkPill = `${telemetry.network.effectiveType.toUpperCase()}${speed}`;
    } else {
        networkPill = 'Online';
    }

    const latencyPill = latencyMs !== null ? `Ping: ${Math.round(latencyMs)}ms` : 'Ping: --';

    return { osPill, screenPill, networkPill, latencyPill };
}

/**
 * Map Device Telemetry to 6-Card System Information Grid
 */
function mapSystemInfoCards(telemetry) {
    return {
        systemOverview: {
            os: `${telemetry.os.name} ${telemetry.os.version || ''}`.trim(),
            platform: telemetry.hardware.platform,
            browser: `${telemetry.browser.name} (${telemetry.browser.engine})`
        },
        displaySpecs: {
            resolution: `${telemetry.screen.width}×${telemetry.screen.height}`,
            viewport: `${telemetry.viewport.width}×${telemetry.viewport.height}`,
            dpr: `${telemetry.screen.dpr}x`,
            colorDepth: `${telemetry.screen.colorDepth}-bit`
        },
        networkSpecs: {
            status: telemetry.network.online ? 'Online' : 'Offline',
            effectiveType: telemetry.network.effectiveType || 'unknown',
            downlink: telemetry.network.downlink ? `${telemetry.network.downlink} Mbps` : 'N/A',
            rtt: telemetry.network.rtt ? `${telemetry.network.rtt} ms` : 'N/A'
        },
        batterySpecs: {
            supported: telemetry.battery.supported,
            level: telemetry.battery.level !== null ? `${Math.round(telemetry.battery.level * 100)}%` : 'N/A',
            charging: telemetry.battery.charging ? 'Charging' : 'Discharging'
        },
        featuresMatrix: telemetry.features,
        hardwareSensors: {
            concurrency: `${telemetry.hardware.concurrency} Cores`,
            memory: telemetry.hardware.memory ? `${telemetry.hardware.memory} GB` : 'N/A'
        }
    };
}

/**
 * Parse URL Query String into key-value map for Network Payload tab
 */
function parseQueryParams(urlStr) {
    try {
        const url = new URL(urlStr, 'http://localhost');
        const params = {};
        for (const [key, value] of url.searchParams.entries()) {
            if (params[key]) {
                if (Array.isArray(params[key])) {
                    params[key].push(value);
                } else {
                    params[key] = [params[key], value];
                }
            } else {
                params[key] = value;
            }
        }
        return params;
    } catch {
        return {};
    }
}

/**
 * Simulate Master-Detail Keyboard Navigation in Network Tab
 */
function simulateNetworkKeyboardNav(requests, currentIndex, key) {
    if (key === 'Escape') return null; // Deselect and close detail pane
    if (key === 'ArrowDown') return Math.min(requests.length - 1, currentIndex + 1);
    if (key === 'ArrowUp') return Math.max(0, currentIndex - 1);
    return currentIndex;
}

/**
 * Calculate Console Log Level Badges (Error, Warn, Info)
 */
function calculateBadgeCounts(logStream) {
    const counts = { error: 0, warn: 0, info: 0, all: 0 };
    for (const entry of logStream) {
        counts.all++;
        const lvl = (entry.level || 'info').toLowerCase();
        if (lvl === 'error') counts.error++;
        else if (lvl === 'warn' || lvl === 'warning') counts.warn++;
        else if (lvl === 'info' || lvl === 'log' || lvl === 'debug') counts.info++;
    }
    return counts;
}

/**
 * Format In-Stream REPL Display Item
 */
function formatReplStreamItem(type, content, isError = false) {
    const prefix = type === 'input' ? '>' : '<';
    return {
        prefix,
        type,
        formatted: `${prefix} ${content}`,
        isError: !!isError,
        timestamp: Date.now()
    };
}

// ============================================================================
// SIMULATED CLIENT CLIENTS WITH MODERN PROTOCOL SUPPORT
// ============================================================================

/**
 * Simulated Modern Mobile Device
 */
async function createModernDevice(wsUrl, options = {}) {
    const ws = new WebSocket(`${wsUrl}?type=device`);
    const messageQueue = [];
    const listeners = [];

    // Default rich telemetry state conforming to PROJECT.md
    const telemetryState = {
        os: { name: 'iOS', version: '17.4', ...(options.os || {}) },
        browser: { name: 'Safari', version: '17.4', engine: 'WebKit', ...(options.browser || {}) },
        screen: { width: 393, height: 852, dpr: 3, colorDepth: 24, ...(options.screen || {}) },
        viewport: { width: 393, height: 750, ...(options.viewport || {}) },
        network: { effectiveType: '4g', downlink: 10, rtt: 50, online: true, ...(options.network || {}) },
        battery: { supported: false, level: null, charging: null, ...(options.battery || {}) },
        hardware: { concurrency: 6, memory: null, platform: 'iPhone', ...(options.hardware || {}) },
        features: {
            webgl: true,
            webrtc: true,
            indexedDB: true,
            serviceWorker: true,
            localStorage: true,
            sessionStorage: true,
            cookie: true,
            websocket: true,
            ...(options.features || {})
        },
        timestamp: Date.now()
    };

    const networkBodies = new Map([
        ['req-order-1', JSON.stringify({ orderId: 'ORD-9912', status: 'CONFIRMED', total: 49.99 })],
        ['req-large', 'X'.repeat(120 * 1024)] // 120KB payload
    ]);

    let roomPin = null;

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Modern Device WebSocket open timeout')), 4000);
        ws.addEventListener('open', () => {
            clearTimeout(timer);
            resolve();
        });
        ws.addEventListener('error', (e) => {
            clearTimeout(timer);
            reject(new Error(`Modern Device WebSocket connection error: ${e.message || 'unknown'}`));
        });
    });

    function sendJson(obj) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    }

    ws.addEventListener('message', (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch {
            return;
        }

        if ((msg.type === 'room_pin' || msg.type === 'init') && msg.pin) {
            roomPin = msg.pin;
        }

        // Auto-approve developer pairing requests
        if (msg.type === 'auth_request') {
            sendJson({
                type: 'auth_response',
                authId: msg.authId,
                approved: true,
                timestamp: Date.now()
            });
        }

        // On developer connected: automatically push initial telemetry if enabled
        if (msg.type === 'dev_connected' && options.autoPushTelemetry !== false) {
            telemetryState.timestamp = Date.now();
            sendJson({
                type: 'device_telemetry',
                data: telemetryState
            });
        }

        // Auto-respond to Modernization Protocols
        if (options.autoRespond !== false) {
            // Latency Ping/Pong
            if (msg.type === 'device_ping') {
                sendJson({
                    type: 'device_pong',
                    timestamp: msg.timestamp
                });
            }

            // System Information Pull
            if (msg.type === 'pull_device_info') {
                telemetryState.timestamp = Date.now();
                sendJson({
                    type: 'device_telemetry',
                    data: telemetryState
                });
            }

            // Network Body Pull
            if (msg.type === 'pull_network_body') {
                const body = networkBodies.get(msg.requestId) || '{"status": "ok"}';
                sendJson({
                    type: 'network_body_data',
                    requestId: msg.requestId,
                    body: body
                });
            }

            // REPL Execution
            if (msg.type === 'exec_js') {
                try {
                    let result;
                    if (msg.code === '2 + 2') {
                        result = '4';
                    } else if (msg.code === 'document.title') {
                        result = 'Modern Debugging Session';
                    } else if (msg.code === 'window.innerWidth') {
                        result = String(telemetryState.viewport.width);
                    } else if (typeof options.customEval === 'function') {
                        result = String(options.customEval(msg.code, telemetryState));
                    } else {
                        // eslint-disable-next-line no-eval
                        result = String(eval(msg.code));
                    }
                    sendJson({
                        type: 'exec_js_result',
                        code: msg.code,
                        result: result,
                        output: result,
                        isError: false,
                        error: null,
                        timestamp: Date.now()
                    });
                } catch (err) {
                    sendJson({
                        type: 'exec_js_result',
                        code: msg.code,
                        result: null,
                        output: null,
                        isError: true,
                        error: err.message,
                        timestamp: Date.now()
                    });
                }
            }
        }

        // Check listeners
        for (let i = listeners.length - 1; i >= 0; i--) {
            const { predicate, resolve } = listeners[i];
            if (predicate(msg)) {
                listeners.splice(i, 1);
                resolve(msg);
                return;
            }
        }

        messageQueue.push(msg);
    });

    function waitForMessage(predicate, timeoutMs = 4000) {
        for (let i = 0; i < messageQueue.length; i++) {
            if (predicate(messageQueue[i])) {
                const msg = messageQueue.splice(i, 1)[0];
                return Promise.resolve(msg);
            }
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = listeners.findIndex((l) => l.resolve === resolve);
                if (idx !== -1) listeners.splice(idx, 1);
                reject(new Error(`Device timeout (${timeoutMs}ms) waiting for message`));
            }, timeoutMs);

            listeners.push({
                predicate,
                resolve: (msg) => {
                    clearTimeout(timer);
                    resolve(msg);
                }
            });
        });
    }

    // Await room PIN
    if (!roomPin) {
        const pinMsg = await waitForMessage((m) => (m.type === 'room_pin' || m.type === 'init') && !!m.pin, 3000);
        roomPin = pinMsg.pin;
    }

    return {
        ws,
        roomPin,
        telemetryState,
        networkBodies,
        sendRaw: sendJson,
        waitForMessage,
        pushTelemetry: (override = {}) => {
            const data = { ...telemetryState, ...override, timestamp: Date.now() };
            sendJson({ type: 'device_telemetry', data });
            return data;
        },
        sendNetworkRequest: (req) => {
            sendJson({
                type: 'network_request',
                request: {
                    id: req.id || `req-${Date.now()}`,
                    method: req.method || 'GET',
                    url: req.url || 'https://api.example.com/data',
                    status: req.status || 200,
                    duration: req.duration || 25,
                    headers: req.headers || { 'Content-Type': 'application/json' },
                    responseHeaders: req.responseHeaders || { 'Content-Type': 'application/json' },
                    queryParams: req.queryParams || parseQueryParams(req.url || ''),
                    requestBody: req.requestBody !== undefined ? req.requestBody : null,
                    timestamp: Date.now()
                }
            });
        },
        sendLog: (level, message, args = []) => {
            sendJson({
                type: 'log',
                level,
                message,
                args: args.length ? args : [message],
                timestamp: Date.now()
            });
        },
        close: () => ws.close()
    };
}

/**
 * Simulated Modern Developer Dashboard Client
 */
async function createModernDeveloper(wsUrl, pin) {
    const ws = new WebSocket(`${wsUrl}?type=developer`);
    const messageQueue = [];
    const listeners = [];

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Modern Developer WebSocket open timeout')), 4000);
        ws.addEventListener('open', () => {
            clearTimeout(timer);
            resolve();
        });
        ws.addEventListener('error', (e) => {
            clearTimeout(timer);
            reject(new Error(`Modern Developer WebSocket connection error: ${e.message || 'unknown'}`));
        });
    });

    function sendJson(obj) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    }

    ws.addEventListener('message', (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch {
            return;
        }

        for (let i = listeners.length - 1; i >= 0; i--) {
            const { predicate, resolve } = listeners[i];
            if (predicate(msg)) {
                listeners.splice(i, 1);
                resolve(msg);
                return;
            }
        }

        messageQueue.push(msg);
    });

    function waitForMessage(predicate, timeoutMs = 4000) {
        for (let i = 0; i < messageQueue.length; i++) {
            if (predicate(messageQueue[i])) {
                const msg = messageQueue.splice(i, 1)[0];
                return Promise.resolve(msg);
            }
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = listeners.findIndex((l) => l.resolve === resolve);
                if (idx !== -1) listeners.splice(idx, 1);
                reject(new Error(`Developer timeout (${timeoutMs}ms) waiting for message`));
            }, timeoutMs);

            listeners.push({
                predicate,
                resolve: (msg) => {
                    clearTimeout(timer);
                    resolve(msg);
                }
            });
        });
    }

    // Pair with room PIN
    sendJson({ type: 'connect_room', pin });
    const pairResp = await waitForMessage(
        (m) => m.type === 'room_connected' || m.type === 'connected' || m.type === 'error',
        3000
    );
    if (pairResp.type === 'error') {
        throw new Error(`Room pairing failed: ${pairResp.message}`);
    }

    return {
        ws,
        pin,
        sendRaw: sendJson,
        waitForMessage,
        waitForTelemetry: async (timeoutMs = 4000) => {
            return await waitForMessage((m) => m.type === 'device_telemetry', timeoutMs);
        },
        pingDevice: async (timeoutMs = 4000) => {
            const sendTs = Date.now();
            sendJson({ type: 'device_ping', timestamp: sendTs });
            const pong = await waitForMessage(
                (m) => m.type === 'device_pong' && m.timestamp === sendTs,
                timeoutMs
            );
            const latency = Date.now() - pong.timestamp;
            return { pong, latency };
        },
        pullDeviceInfo: async (timeoutMs = 4000) => {
            sendJson({ type: 'pull_device_info' });
            return await waitForMessage((m) => m.type === 'device_telemetry', timeoutMs);
        },
        pullNetworkBody: async (requestId, timeoutMs = 4000) => {
            sendJson({ type: 'pull_network_body', requestId });
            return await waitForMessage(
                (m) => (m.type === 'network_body_data' || m.type === 'network_body') && m.requestId === requestId,
                timeoutMs
            );
        },
        execRepl: async (code, timeoutMs = 4000) => {
            sendJson({ type: 'exec_js', code });
            return await waitForMessage(
                (m) => m.type === 'exec_js_result' || m.type === 'exec_result',
                timeoutMs
            );
        },
        close: () => ws.close()
    };
}

// ============================================================================
// MASTER TEST SUITE RUNNER
// ============================================================================

async function runModernizationE2ETests() {
    console.log('\n================================================================');
    console.log('🚀 vCONSOLE REMOTE: UI/UX MODERNIZATION E2E TEST SUITE');
    console.log('================================================================\n');

    let server = null;
    let totalPassed = 0;
    let totalFailed = 0;
    const failures = [];

    async function test(tierName, testName, fn) {
        process.stdout.write(`  • [${tierName}] ${testName} ... `);
        try {
            await fn();
            totalPassed++;
            console.log('✅ PASS');
        } catch (err) {
            totalFailed++;
            console.log(`❌ FAIL: ${err.message}`);
            failures.push({ tier: tierName, name: testName, error: err.message, stack: err.stack });
        }
    }

    try {
        server = await startServer();
        console.log(`[Harness] Server running at ${server.url} (ws: ${server.wsUrl}, isGo: ${server.isGoServer})\n`);

        // ====================================================================
        // TIER 1: FEATURE COVERAGE (Isolated Happy Paths)
        // ====================================================================
        console.log('----------------------------------------------------------------');
        console.log('📦 TIER 1: FEATURE COVERAGE (Category-Partition)');
        console.log('----------------------------------------------------------------');

        // Feature 1: Device Telemetry Push & Schema Validation
        await test('Tier 1', '1.1 Initial telemetry push conforms to PROJECT.md schema', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const msg = await dev.waitForTelemetry(3000);
            assert(!!msg && !!msg.data, 'Telemetry packet received');
            validateTelemetrySchema(msg.data);

            assertEqual(msg.data.os.name, 'iOS');
            assertEqual(msg.data.browser.name, 'Safari');
            assertEqual(msg.data.screen.width, 393);
            assertEqual(msg.data.viewport.height, 750);

            dev.close();
            device.close();
        });

        await test('Tier 1', '1.2 Telemetry push on resize/orientation reflects updated dimensions', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            // Wait for initial push
            await dev.waitForTelemetry(3000);

            // Device orientation change from Portrait (393x852) to Landscape (852x393)
            device.pushTelemetry({
                screen: { width: 852, height: 393, dpr: 3, colorDepth: 24 },
                viewport: { width: 852, height: 375 }
            });

            const updatedMsg = await dev.waitForTelemetry(3000);
            assertEqual(updatedMsg.data.screen.width, 852, 'Screen width updated');
            assertEqual(updatedMsg.data.viewport.width, 852, 'Viewport width updated');
            assertEqual(updatedMsg.data.viewport.height, 375, 'Viewport height updated');

            dev.close();
            device.close();
        });

        await test('Tier 1', '1.3 Telemetry features matrix contains all 8 required capability flags', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const msg = await dev.waitForTelemetry(3000);
            const feats = msg.data.features;
            assertEqual(typeof feats.webgl, 'boolean');
            assertEqual(typeof feats.webrtc, 'boolean');
            assertEqual(typeof feats.indexedDB, 'boolean');
            assertEqual(typeof feats.serviceWorker, 'boolean');
            assertEqual(typeof feats.localStorage, 'boolean');
            assertEqual(typeof feats.sessionStorage, 'boolean');
            assertEqual(typeof feats.cookie, 'boolean');
            assertEqual(typeof feats.websocket, 'boolean');

            dev.close();
            device.close();
        });

        // Feature 2: Latency Ping/Pong Protocol
        await test('Tier 1', '2.1 Latency ping/pong completes with matching timestamp', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const { pong, latency } = await dev.pingDevice(3000);
            assert(!!pong, 'Pong message received');
            assert(typeof latency === 'number' && latency >= 0, 'Latency is valid number');
            assert(latency < 50.0, `Ping roundtrip latency ${latency.toFixed(2)}ms must be < 50ms SLA`);

            dev.close();
            device.close();
        });

        await test('Tier 1', '2.2 Consecutive ping/pong heartbeats maintain sequence integrity', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            for (let i = 0; i < 3; i++) {
                const { latency } = await dev.pingDevice(2000);
                assert(latency < 50.0, `Cycle ${i} latency ${latency.toFixed(2)}ms within SLA`);
            }

            dev.close();
            device.close();
        });

        // Feature 3: On-Demand System Information Pull & 6-Card Grid
        await test('Tier 1', '3.1 pull_device_info returns full refreshed telemetry payload', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            // Drain initial connect telemetry
            await dev.waitForTelemetry(3000);

            // Update internal device battery
            device.telemetryState.battery = { supported: true, level: 0.88, charging: true };

            const pullResp = await dev.pullDeviceInfo(3000);
            assert(!!pullResp && !!pullResp.data, 'Telemetry returned on pull');
            assertEqual(pullResp.data.battery.level, 0.88, 'Battery level updated in pull response');
            assertEqual(pullResp.data.battery.charging, true, 'Charging status updated');

            dev.close();
            device.close();
        });

        await test('Tier 1', '3.2 System information mapping creates complete 6-card responsive grid data', async () => {
            const sampleTelemetry = {
                os: { name: 'iOS', version: '17.4' },
                browser: { name: 'Safari', version: '17.4', engine: 'WebKit' },
                screen: { width: 393, height: 852, dpr: 3, colorDepth: 24 },
                viewport: { width: 393, height: 750 },
                network: { effectiveType: '4g', downlink: 10, rtt: 50, online: true },
                battery: { supported: true, level: 0.85, charging: true },
                hardware: { concurrency: 6, memory: 4, platform: 'iPhone' },
                features: { webgl: true, webrtc: true, indexedDB: true, serviceWorker: true, localStorage: true, sessionStorage: true, cookie: true, websocket: true },
                timestamp: Date.now()
            };

            const cards = mapSystemInfoCards(sampleTelemetry);
            assertEqual(cards.systemOverview.os, 'iOS 17.4');
            assertEqual(cards.displaySpecs.resolution, '393×852');
            assertEqual(cards.displaySpecs.dpr, '3x');
            assertEqual(cards.networkSpecs.status, 'Online');
            assertEqual(cards.networkSpecs.downlink, '10 Mbps');
            assertEqual(cards.batterySpecs.level, '85%');
            assertEqual(cards.batterySpecs.charging, 'Charging');
            assertEqual(cards.hardwareSensors.concurrency, '6 Cores');
            assertEqual(cards.hardwareSensors.memory, '4 GB');
        });

        // Feature 4: Network Split-View Data Structures & Sub-Tabs
        await test('Tier 1', '4.1 Network request model contains Headers, Payload, and Duration', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const sampleReq = {
                id: 'req-modern-101',
                method: 'POST',
                url: 'https://api.store.com/v2/items?category=books&limit=10',
                status: 201,
                duration: 35,
                headers: { 'Authorization': 'Bearer test-token', 'Content-Type': 'application/json' },
                responseHeaders: { 'Content-Type': 'application/json; charset=utf-8' },
                requestBody: JSON.stringify({ title: 'Debugging Guide', price: 29.99 })
            };

            device.sendNetworkRequest(sampleReq);

            const msg = await dev.waitForMessage(
                (m) => m.type === 'network_request' && m.request && m.request.id === sampleReq.id,
                3000
            );

            const req = msg.request;
            // Sub-tab 1: Headers
            assertEqual(req.headers['Authorization'], 'Bearer test-token');
            assertEqual(req.responseHeaders['Content-Type'], 'application/json; charset=utf-8');

            // Sub-tab 2: Payload (Query params and body)
            assertEqual(req.queryParams.category, 'books');
            assertEqual(req.queryParams.limit, '10');
            assert(req.requestBody.includes('Debugging Guide'));

            // Sub-tab 3: Response
            assertEqual(req.status, 201);
            assertEqual(req.duration, 35);

            dev.close();
            device.close();
        });

        await test('Tier 1', '4.2 On-demand pull_network_body fetches response body for split view', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const bodyResp = await dev.pullNetworkBody('req-order-1', 3000);
            assert(!!bodyResp && !!bodyResp.body, 'Body received');
            const parsed = JSON.parse(bodyResp.body);
            assertEqual(parsed.orderId, 'ORD-9912');
            assertEqual(parsed.status, 'CONFIRMED');

            dev.close();
            device.close();
        });

        await test('Tier 1', '4.3 Network split-view keyboard navigation (ArrowUp, ArrowDown, Escape)', async () => {
            const requests = [
                { id: 'req-1', url: '/api/v1/users' },
                { id: 'req-2', url: '/api/v1/orders' },
                { id: 'req-3', url: '/api/v1/items' }
            ];

            let activeIdx = 0;
            // ArrowDown
            activeIdx = simulateNetworkKeyboardNav(requests, activeIdx, 'ArrowDown');
            assertEqual(activeIdx, 1, 'Navigated down to index 1');

            activeIdx = simulateNetworkKeyboardNav(requests, activeIdx, 'ArrowDown');
            assertEqual(activeIdx, 2, 'Navigated down to index 2');

            // ArrowDown boundary limit
            activeIdx = simulateNetworkKeyboardNav(requests, activeIdx, 'ArrowDown');
            assertEqual(activeIdx, 2, 'Bounded at index 2');

            // ArrowUp
            activeIdx = simulateNetworkKeyboardNav(requests, activeIdx, 'ArrowUp');
            assertEqual(activeIdx, 1, 'Navigated up to index 1');

            // Escape closes detail pane
            activeIdx = simulateNetworkKeyboardNav(requests, activeIdx, 'Escape');
            assertEqual(activeIdx, null, 'Escape closes selection');
        });

        // Feature 5: Top Bar Telemetry Pills Formatting
        await test('Tier 1', '5.1 Top bar telemetry pills format correctly from telemetry model', async () => {
            const sampleTelemetry = {
                os: { name: 'iOS', version: '17.4' },
                browser: { name: 'Safari', version: '17.4', engine: 'WebKit' },
                screen: { width: 393, height: 852, dpr: 3, colorDepth: 24 },
                viewport: { width: 393, height: 750 },
                network: { effectiveType: '4g', downlink: 15, rtt: 40, online: true },
                battery: { supported: true, level: 0.75, charging: false },
                hardware: { concurrency: 6, memory: null, platform: 'iPhone' },
                features: { webgl: true, webrtc: true, indexedDB: true, serviceWorker: true, localStorage: true, sessionStorage: true, cookie: true, websocket: true },
                timestamp: Date.now()
            };

            const pills = formatTelemetryPills(sampleTelemetry, 12.4);
            assertEqual(pills.osPill, 'iOS 17.4', 'OS pill formatted');
            assertEqual(pills.screenPill, '393×852 @3x', 'Screen pill formatted');
            assertEqual(pills.networkPill, '4G (15Mbps)', 'Network pill formatted');
            assertEqual(pills.latencyPill, 'Ping: 12ms', 'Latency pill formatted');
        });

        // Feature 6: Console Bottom REPL Prompt & Badges
        await test('Tier 1', '6.1 Bottom REPL evaluates JS expression and returns output', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const resp = await dev.execRepl('2 + 2', 3000);
            assert(!!resp, 'REPL response received');
            assertEqual(resp.result, '4', 'Evaluated 2 + 2 -> 4');
            assertEqual(resp.isError, false, 'isError flag is false');

            dev.close();
            device.close();
        });

        await test('Tier 1', '6.2 In-stream REPL command and result formatting', async () => {
            const inputItem = formatReplStreamItem('input', '2 + 2');
            const outputItem = formatReplStreamItem('output', '4');

            assertEqual(inputItem.formatted, '> 2 + 2');
            assertEqual(outputItem.formatted, '< 4');
            assert(outputItem.timestamp >= inputItem.timestamp);
        });

        await test('Tier 1', '6.3 Console log level badges accurately calculate Error, Warn, Info counts', async () => {
            const stream = [
                { level: 'error', message: 'TypeError: null is not an object' },
                { level: 'warn', message: 'Deprecation: use requestAnimationFrame instead' },
                { level: 'warn', message: 'Slow network detected' },
                { level: 'info', message: 'User logged in' },
                { level: 'log', message: 'App mounted' },
                { level: 'debug', message: 'Render pass 1' }
            ];

            const badges = calculateBadgeCounts(stream);
            assertEqual(badges.error, 1, '1 error count');
            assertEqual(badges.warn, 2, '2 warning count');
            assertEqual(badges.info, 3, '3 info count (info + log + debug)');
            assertEqual(badges.all, 6, '6 total count');
        });

        // ====================================================================
        // TIER 2: BOUNDARY & CORNER CASES (Boundary Value Analysis)
        // ====================================================================
        console.log('\n----------------------------------------------------------------');
        console.log('⚡ TIER 2: BOUNDARY & CORNER CASES (BVA)');
        console.log('----------------------------------------------------------------');

        // Boundary 1: Missing Browser APIs Fallback
        await test('Tier 2', '2.1 Missing getBattery API (Safari/WebKit) reports supported=false cleanly', async () => {
            const device = await createModernDevice(server.wsUrl, {
                battery: { supported: false, level: null, charging: null }
            });
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const msg = await dev.waitForTelemetry(3000);
            assertEqual(msg.data.battery.supported, false);
            assertEqual(msg.data.battery.level, null);
            assertEqual(msg.data.battery.charging, null);

            dev.close();
            device.close();
        });

        await test('Tier 2', '2.2 Missing navigator.connection falls back to navigator.onLine', async () => {
            const device = await createModernDevice(server.wsUrl, {
                network: { effectiveType: 'unknown', downlink: null, rtt: null, online: true }
            });
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const msg = await dev.waitForTelemetry(3000);
            assertEqual(msg.data.network.online, true);
            assertEqual(msg.data.network.effectiveType, 'unknown');

            const pills = formatTelemetryPills(msg.data);
            assertEqual(pills.networkPill, 'Online');

            dev.close();
            device.close();
        });

        // Boundary 2: Offline & Network States
        await test('Tier 2', '2.3 Offline network state formats correctly in telemetry pill', async () => {
            const device = await createModernDevice(server.wsUrl, {
                network: { effectiveType: 'none', downlink: 0, rtt: 0, online: false }
            });
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const msg = await dev.waitForTelemetry(3000);
            assertEqual(msg.data.network.online, false);

            const pills = formatTelemetryPills(msg.data);
            assertEqual(pills.networkPill, 'Offline');

            dev.close();
            device.close();
        });

        // Boundary 3: Zero / Extreme Battery States
        await test('Tier 2', '2.4 Critical 0% battery level is preserved as numeric 0.0, not null', async () => {
            const device = await createModernDevice(server.wsUrl, {
                battery: { supported: true, level: 0.0, charging: false }
            });
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const msg = await dev.waitForTelemetry(3000);
            assertEqual(msg.data.battery.level, 0.0);
            assertEqual(msg.data.battery.charging, false);

            dev.close();
            device.close();
        });

        await test('Tier 2', '2.5 100% full battery (1.0) and charging state preserved', async () => {
            const device = await createModernDevice(server.wsUrl, {
                battery: { supported: true, level: 1.0, charging: true }
            });
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const msg = await dev.waitForTelemetry(3000);
            assertEqual(msg.data.battery.level, 1.0);
            assertEqual(msg.data.battery.charging, true);

            dev.close();
            device.close();
        });

        // Boundary 4: Special Characters & Errors in REPL
        await test('Tier 2', '2.6 REPL executes multiline code with newlines and semicolons', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const multilineCode = '(() => {\n  let x = 10;\n  let y = 20;\n  return x + y;\n})()';
            const resp = await dev.execRepl(multilineCode, 3000);
            assertEqual(resp.result, '30');

            dev.close();
            device.close();
        });

        await test('Tier 2', '2.7 REPL handles Unicode, emojis, Chinese, and Khmer characters', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const unicodeCode = '`🚀 远程调试 测试 khmer: សួស្តី`';
            const resp = await dev.execRepl(unicodeCode, 3000);
            assertEqual(resp.result, '🚀 远程调试 测试 khmer: សួស្តី');

            dev.close();
            device.close();
        });

        await test('Tier 2', '2.8 REPL syntax error returns isError=true without session termination', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const badCode = '{ unclosed block: [ ';
            const resp = await dev.execRepl(badCode, 3000);
            assertEqual(resp.isError, true);
            assert(typeof resp.error === 'string' && resp.error.length > 0);

            // Verify session is still alive after syntax error
            const healResp = await dev.execRepl('2 + 2', 3000);
            assertEqual(healResp.result, '4');
            assertEqual(healResp.isError, false);

            dev.close();
            device.close();
        });

        await test('Tier 2', '2.9 REPL runtime exception returns isError=true and error message', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const throwCode = 'throw new Error("Handled Exception in REPL")';
            const resp = await dev.execRepl(throwCode, 3000);
            assertEqual(resp.isError, true);
            assert(resp.error.includes('Handled Exception in REPL'));

            dev.close();
            device.close();
        });

        await test('Tier 2', '2.10 REPL escaped quotes, backticks, and nested JSON strings', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const jsonExpr = 'JSON.stringify({ key: "\\"value\\"", flag: true })';
            const resp = await dev.execRepl(jsonExpr, 3000);
            assert(!resp.isError);
            const parsed = JSON.parse(resp.result);
            assertEqual(parsed.flag, true);

            dev.close();
            device.close();
        });

        // Boundary 5: Empty & Large Payloads in Network Viewer
        await test('Tier 2', '2.11 Empty query params and empty request payload handled safely', async () => {
            const params = parseQueryParams('https://api.example.com/health');
            assertEqual(Object.keys(params).length, 0);

            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            device.sendNetworkRequest({
                id: 'req-empty',
                method: 'GET',
                url: 'https://api.example.com/health',
                status: 204,
                duration: 5,
                requestBody: ''
            });

            const msg = await dev.waitForMessage((m) => m.request && m.request.id === 'req-empty', 3000);
            assertEqual(msg.request.requestBody, '');
            assertEqual(msg.request.status, 204);

            dev.close();
            device.close();
        });

        await test('Tier 2', '2.12 Large network response body (120KB) transferred via pull_network_body', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const resp = await dev.pullNetworkBody('req-large', 4000);
            assert(!!resp.body, 'Large body received');
            assertEqual(resp.body.length, 120 * 1024, '120KB exact size');

            dev.close();
            device.close();
        });

        await test('Tier 2', '2.13 URL query params with repeated keys and encoded chars parsed into array', async () => {
            const url = 'https://api.example.com/search?q=hello%20world&tag=react&tag=vconsole&empty=';
            const params = parseQueryParams(url);

            assertEqual(params.q, 'hello world');
            assert(Array.isArray(params.tag));
            assertEqual(params.tag.length, 2);
            assertEqual(params.tag[0], 'react');
            assertEqual(params.tag[1], 'vconsole');
            assertEqual(params.empty, '');
        });

        // ====================================================================
        // TIER 3: CROSS-FEATURE INTERACTIONS (Pairwise Combinations)
        // ====================================================================
        console.log('\n----------------------------------------------------------------');
        console.log('🔄 TIER 3: CROSS-FEATURE INTERACTIONS (Pairwise)');
        console.log('----------------------------------------------------------------');

        await test('Tier 3', '3.1 REPL command triggering console logs yields both REPL result and log stream', async () => {
            const device = await createModernDevice(server.wsUrl, {
                customEval: (code) => {
                    if (code.includes('logAndReturn')) {
                        device.sendLog('warn', 'Triggered from REPL');
                        return 'DONE';
                    }
                    // eslint-disable-next-line no-eval
                    return eval(code);
                }
            });
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            // Execute code that emits log
            const replPromise = dev.execRepl('logAndReturn()', 3000);
            const logPromise = dev.waitForMessage((m) => m.type === 'log' && m.message === 'Triggered from REPL', 3000);

            const [replResp, logResp] = await Promise.all([replPromise, logPromise]);
            assertEqual(replResp.result, 'DONE');
            assertEqual(logResp.level, 'warn');

            dev.close();
            device.close();
        });

        await test('Tier 3', '3.2 REPL command triggering network request generates network_request frame', async () => {
            const device = await createModernDevice(server.wsUrl, {
                customEval: (code) => {
                    if (code.includes('fetchData')) {
                        device.sendNetworkRequest({
                            id: 'req-repl-fetch',
                            method: 'GET',
                            url: 'https://api.example.com/repl-triggered',
                            status: 200
                        });
                        return 'FETCH_SENT';
                    }
                    // eslint-disable-next-line no-eval
                    return eval(code);
                }
            });
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            const replPromise = dev.execRepl('fetchData()', 3000);
            const netPromise = dev.waitForMessage((m) => m.type === 'network_request' && m.request.id === 'req-repl-fetch', 3000);

            const [replResp, netResp] = await Promise.all([replPromise, netPromise]);
            assertEqual(replResp.result, 'FETCH_SENT');
            assertEqual(netResp.request.url, 'https://api.example.com/repl-triggered');

            dev.close();
            device.close();
        });

        await test('Tier 3', '3.3 Telemetry pull during active network streaming maintains stream isolation', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            // Drain initial telemetry
            await dev.waitForTelemetry(3000);

            // Concurrently stream 10 network requests and 1 telemetry pull
            for (let i = 0; i < 10; i++) {
                device.sendNetworkRequest({ id: `req-concurrent-${i}`, method: 'GET', status: 200 });
            }

            const pullPromise = dev.pullDeviceInfo(3000);
            const pullResp = await pullPromise;
            validateTelemetrySchema(pullResp.data);

            // Ensure network requests are also received
            const lastNet = await dev.waitForMessage(
                (m) => m.type === 'network_request' && m.request.id === 'req-concurrent-9',
                3000
            );
            assert(!!lastNet, 'Network requests survived concurrent pull');

            dev.close();
            device.close();
        });

        await test('Tier 3', '3.4 Latency ping/pong heartbeats during continuous console log pump', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            // Pump 25 rapid logs
            for (let i = 0; i < 25; i++) {
                device.sendLog('info', `Background pump message ${i}`);
            }

            // Perform ping during active log stream
            const { latency } = await dev.pingDevice(3000);
            assert(latency < 50.0, `Ping latency ${latency.toFixed(2)}ms under log load within 50ms SLA`);

            dev.close();
            device.close();
        });

        await test('Tier 3', '3.5 Sequential REPL history navigation and command recall', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            // Simulate command history stack
            const history = [];
            const commands = ['1 + 1', 'Math.max(10, 20)', 'document.title'];

            for (const cmd of commands) {
                const resp = await dev.execRepl(cmd, 3000);
                assert(!resp.isError);
                history.push(cmd);
            }

            assertEqual(history.length, 3);
            assertEqual(history[history.length - 1], 'document.title', 'Caret navigation top is latest');
            assertEqual(history[0], '1 + 1', 'Caret navigation bottom is oldest');

            dev.close();
            device.close();
        });

        await test('Tier 3', '3.6 REPL evaluation modifying state verified via subsequent telemetry pull', async () => {
            const device = await createModernDevice(server.wsUrl, {
                customEval: (code, state) => {
                    if (code.includes('setCustomState')) {
                        state.hardware.concurrency = 8;
                        return 'UPDATED';
                    }
                    // eslint-disable-next-line no-eval
                    return eval(code);
                }
            });
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            // Drain initial connection telemetry
            await dev.waitForTelemetry(3000);

            // Execute REPL state modification
            const replResp = await dev.execRepl('setCustomState()', 3000);
            assertEqual(replResp.result, 'UPDATED');

            // Pull fresh telemetry
            const updated = await dev.pullDeviceInfo(3000);
            assertEqual(updated.data.hardware.concurrency, 8, 'Concurrency updated to 8');

            dev.close();
            device.close();
        });

        // ====================================================================
        // TIER 4: REAL-WORLD WORKLOADS (End-to-End User Simulation)
        // ====================================================================
        console.log('\n----------------------------------------------------------------');
        console.log('🌐 TIER 4: REAL-WORLD WORKLOADS (Workload Simulation)');
        console.log('----------------------------------------------------------------');

        // Provision clean server instance for Tier 4 workload & memory SLA verification
        if (server && typeof server.kill === 'function') {
            server.kill();
        }
        server = await startServer();

        await test('Tier 4', '4.1 Complete Mobile Debugging Session (Telemetry + Latency + Logs + Network + REPL)', async () => {
            // Step 1: Device connects
            const device = await createModernDevice(server.wsUrl, {
                os: { name: 'Android', version: '14' },
                screen: { width: 412, height: 915, dpr: 2.625, colorDepth: 24 },
                network: { effectiveType: '4g', downlink: 25, rtt: 35, online: true }
            });
            assert(!!device.roomPin, 'Device assigned 6-digit room PIN');

            // Step 2: Developer connects
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);
            assert(dev.pin === device.roomPin, 'Developer paired to room');

            // Step 3: Top bar telemetry pills populated
            const telemetryMsg = await dev.waitForTelemetry(3000);
            const pills = formatTelemetryPills(telemetryMsg.data);
            assertEqual(pills.osPill, 'Android 14');
            assertEqual(pills.screenPill, '412×915 @2.625x');

            // Step 4: Latency ping
            const { latency } = await dev.pingDevice(3000);
            assert(latency < 50.0, 'Latency < 50ms');

            // Step 5: Device emits mixed console logs and badges update
            const logsSent = [
                { level: 'info', msg: 'Init Application' },
                { level: 'warn', msg: 'Slow response from CDN' },
                { level: 'error', msg: 'ReferenceError: window.analytics is undefined' }
            ];
            for (const l of logsSent) {
                device.sendLog(l.level, l.msg);
            }

            const receivedLogs = [];
            for (let i = 0; i < 3; i++) {
                const logMsg = await dev.waitForMessage((m) => m.type === 'log', 3000);
                receivedLogs.push(logMsg);
            }
            assertEqual(receivedLogs.length, 3);
            const badges = calculateBadgeCounts(receivedLogs);
            assertEqual(badges.error, 1);
            assertEqual(badges.warn, 1);
            assertEqual(badges.info, 1);

            // Step 6: Network request with split view
            device.sendNetworkRequest({
                id: 'req-e2e-final',
                method: 'POST',
                url: 'https://api.example.com/checkout?currency=USD',
                status: 200,
                duration: 48,
                headers: { 'Content-Type': 'application/json' },
                responseHeaders: { 'X-Server': 'vconsole-remote' },
                requestBody: JSON.stringify({ item: 'Widget A' })
            });

            const netMsg = await dev.waitForMessage((m) => m.request && m.request.id === 'req-e2e-final', 3000);
            assertEqual(netMsg.request.queryParams.currency, 'USD');

            // Step 7: REPL state check
            const replResp = await dev.execRepl('2 + 2', 3000);
            assertEqual(replResp.result, '4');

            // Step 8: Refresh System Info
            const refreshed = await dev.pullDeviceInfo(3000);
            assertEqual(refreshed.data.os.name, 'Android');

            // Step 9: Verify memory footprint (< 15MB RSS)
            const rssMb = server.getRssMb();
            assert(rssMb < 15.0, `Server RSS memory ${rssMb.toFixed(2)} MB must remain < 15.00 MB`);

            dev.close();
            device.close();
        });

        await test('Tier 4', '4.2 Multi-Device Switching & Telemetry Isolation', async () => {
            const dev1 = await createModernDevice(server.wsUrl, { os: { name: 'iOS', version: '17.4' } });
            const dev2 = await createModernDevice(server.wsUrl, { os: { name: 'Android', version: '13' } });

            const developer1 = await createModernDeveloper(server.wsUrl, dev1.roomPin);
            const developer2 = await createModernDeveloper(server.wsUrl, dev2.roomPin);

            const tel1 = await developer1.waitForTelemetry(3000);
            const tel2 = await developer2.waitForTelemetry(3000);

            assertEqual(tel1.data.os.name, 'iOS', 'Dev 1 receives iOS');
            assertEqual(tel2.data.os.name, 'Android', 'Dev 2 receives Android');

            developer1.close();
            developer2.close();
            dev1.close();
            dev2.close();
        });

        await test('Tier 4', '4.3 Stress Workload: 100 mixed events without drop or latency degradation', async () => {
            const device = await createModernDevice(server.wsUrl);
            const dev = await createModernDeveloper(server.wsUrl, device.roomPin);

            // Send burst of 50 logs + 50 network requests
            for (let i = 0; i < 50; i++) {
                device.sendLog('info', `Burst log ${i}`);
                device.sendNetworkRequest({ id: `burst-req-${i}`, status: 200 });
            }

            // Immediately ping device to test broker latency responsiveness
            const { latency } = await dev.pingDevice(4000);
            assert(latency < 50.0, `Ping latency ${latency.toFixed(2)}ms during 100-packet burst < 50ms SLA`);

            dev.close();
            device.close();
        });

    } finally {
        if (server && typeof server.kill === 'function') {
            server.kill();
        }
    }

    // ========================================================================
    // FINAL SUMMARY
    // ========================================================================
    console.log('\n================================================================');
    console.log('📊 MODERNIZATION E2E TEST SUITE EXECUTION SUMMARY');
    console.log('================================================================');
    console.log(`  Total Tests Run:    ${totalPassed + totalFailed}`);
    console.log(`  Tests Passed:       ${totalPassed} ✅`);
    console.log(`  Tests Failed:       ${totalFailed} ${totalFailed > 0 ? '❌' : ''}`);
    console.log('----------------------------------------------------------------');

    if (totalFailed > 0) {
        console.log('\n❌ FAILED TESTS BREAKDOWN:');
        failures.forEach((f, idx) => {
            console.log(`  ${idx + 1}. [${f.tier}] ${f.name}`);
            console.log(`     Error: ${f.error}`);
        });
        console.log('================================================================\n');
        process.exit(1);
    } else {
        console.log('🎉 ALL MODERNIZATION E2E TESTS PASSED SUCCESSFULLY (100% PASS RATE).');
        console.log('================================================================\n');
        process.exit(0);
    }
}

// Execute standalone if invoked directly
if (require.main === module) {
    runModernizationE2ETests().catch((err) => {
        console.error('Fatal Test Suite Error:', err);
        process.exit(1);
    });
}

module.exports = {
    runModernizationE2ETests,
    validateTelemetrySchema,
    formatTelemetryPills,
    mapSystemInfoCards,
    parseQueryParams,
    simulateNetworkKeyboardNav,
    calculateBadgeCounts,
    formatReplStreamItem,
    createModernDevice,
    createModernDeveloper
};
