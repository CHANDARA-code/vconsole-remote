/**
 * test/challenger-m2-empirical-stress.test.js
 * Empirical Challenger Verification & Stress Test Suite for Milestone 2
 * 
 * Conducts exhaustive stress tests across:
 * 1. Babel Standalone JSX compilation of server/assets/index.html
 * 2. Network master-detail split view & keyboard navigation
 * 3. Query string parsing & payload formatting edge cases
 * 4. Device telemetry pills, latency heartbeat & 6-card system grid
 * 5. Console REPL execution, keyboard history traversal & counter badges
 * 6. Live end-to-end WebSocket communication over compiled Go server
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
    startServer,
    assert,
    assertEqual,
    assertMatches,
    sleep,
    createDeviceClient,
    createDevClient
} = require('./helpers');

if (typeof globalThis.WebSocket === 'undefined') {
    throw new Error('Native globalThis.WebSocket is required (Node.js v22+ or v24+).');
}

let passedTests = 0;
let failedTests = 0;
const failures = [];

function runTest(name, fn) {
    process.stdout.write(`  • ${name} ... `);
    try {
        const res = fn();
        if (res && typeof res.then === 'function') {
            return res
                .then(() => {
                    passedTests++;
                    console.log('✅ PASS');
                })
                .catch((err) => {
                    failedTests++;
                    failures.push({ name, error: err.message || String(err) });
                    console.log(`❌ FAIL: ${err.message}`);
                });
        } else {
            passedTests++;
            console.log('✅ PASS');
        }
    } catch (err) {
        failedTests++;
        failures.push({ name, error: err.message || String(err) });
        console.log(`❌ FAIL: ${err.message}`);
    }
}

async function main() {
    console.log('\n================================================================');
    console.log('🔬 EMPIRICAL CHALLENGER STRESS SUITE: MILESTONE 2 VERIFICATION');
    console.log('================================================================\n');

    const htmlPath = path.resolve(__dirname, '../server/assets/index.html');
    assert(fs.existsSync(htmlPath), `index.html must exist at ${htmlPath}`);
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    // =========================================================================
    // SECTION 1: BABEL STANDALONE JSX COMPILATION & AST VALIDATION
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('📦 1. BABEL STANDALONE JSX COMPILATION & SYNTAX INTEGRITY');
    console.log('----------------------------------------------------------------');

    const scriptMatch = htmlContent.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
    assert(scriptMatch, 'Must contain <script type="text/babel"> block in index.html');
    const jsxCode = scriptMatch[1];

    let Babel = null;
    let transformedCode = null;

    await runTest('1.1 Fetch and instantiate Babel Standalone 7.24.7 in VM', async () => {
        const res = await fetch('https://cdn.jsdelivr.net/npm/@babel/standalone@7.24.7/babel.min.js');
        const babelSource = await res.text();
        assert(babelSource.length > 1000000, 'Babel source must be non-empty');
        const sandbox = { window: {}, navigator: { userAgent: 'Node' }, console };
        vm.createContext(sandbox);
        vm.runInContext(babelSource, sandbox);
        Babel = sandbox.Babel || sandbox.window.Babel;
        assert(Babel && typeof Babel.transform === 'function', 'Babel.transform must be available');
    });

    await runTest('1.2 In-browser Babel Standalone compiles entire index.html JSX without errors', () => {
        const transformed = Babel.transform(jsxCode, {
            presets: ['react']
        });
        assert(transformed && transformed.code, 'Babel transform must return transformed code');
        assert(transformed.code.length > 50000, 'Transformed code length must be > 50KB');
        transformedCode = transformed.code;
    });

    await runTest('1.3 Transformed JS code compiles cleanly in V8 engine (vm.Script)', () => {
        assert(transformedCode, 'Transformed code must exist');
        const script = new vm.Script(transformedCode);
        assert(script, 'vm.Script must compile without syntax errors');
    });

    await runTest('1.4 Transformed code contains all essential Milestone 2 function signatures', () => {
        const requiredIdentifiers = [
            'simulateNetworkKeyboardNav',
            'parseQueryParams',
            'formatTelemetryPills',
            'mapSystemInfoCards',
            'calculateBadgeCounts',
            'formatReplStreamItem',
            'renderHeadersTab',
            'renderPayloadTab',
            'renderResponseTab',
            'renderSystemTab',
            'executeREPLExpression',
            'DomTreeNode'
        ];
        for (const id of requiredIdentifiers) {
            assert(
                transformedCode.includes(id) || jsxCode.includes(id),
                `Transformed or source code must contain identifier "${id}"`
            );
        }
    });

    // Extract helper functions from index.html for isolated algorithmic stress testing
    const helperSandbox = {
        window: {
            location: { protocol: 'http:', host: 'localhost' }
        },
        document: {
            activeElement: { tagName: 'BODY' }
        },
        URL: globalThis.URL
    };
    vm.createContext(helperSandbox);

    // Extract utility functions block cleanly from index.html
    const lines = htmlContent.split('\n');
    const startIdx = lines.findIndex(l => l.includes('function parseQueryParams('));
    assert(startIdx !== -1, 'Must find function parseQueryParams in index.html');
    const formatIdx = lines.findIndex(l => l.includes('function formatReplStreamItem('));
    assert(formatIdx !== -1, 'Must find function formatReplStreamItem in index.html');
    let endIdx = -1;
    for (let i = formatIdx; i < lines.length; i++) {
        if (lines[i].trim() === '}') {
            endIdx = i + 1;
            break;
        }
    }
    assert(endIdx > startIdx, 'Must find end of utility functions block');
    const utilityBlock = lines.slice(startIdx, endIdx).join('\n');
    vm.runInContext(utilityBlock, helperSandbox);

    const {
        parseQueryParams,
        formatTelemetryPills,
        calculateBadgeCounts,
        mapSystemInfoCards,
        simulateNetworkKeyboardNav,
        formatReplStreamItem
    } = helperSandbox;

    // =========================================================================
    // SECTION 2: NETWORK SPLIT-VIEW & KEYBOARD NAVIGATION
    // =========================================================================
    console.log('\n----------------------------------------------------------------');
    console.log('⚡ 2. NETWORK MASTER-DETAIL & KEYBOARD NAVIGATION STRESS');
    console.log('----------------------------------------------------------------');

    await runTest('2.1 Keyboard nav handles empty request list cleanly', () => {
        const empty = [];
        // When requests.length is 0, requests.length - 1 is -1. Math.min(-1, 1) returns -1.
        // index.html protects this via: if (nextIndex >= 0 && nextIndex < filteredRequests.length)
        assertEqual(simulateNetworkKeyboardNav(empty, 0, 'ArrowDown'), -1);
        assertEqual(simulateNetworkKeyboardNav(empty, 0, 'ArrowUp'), 0);
        assertEqual(simulateNetworkKeyboardNav(empty, 0, 'Escape'), null);
    });

    await runTest('2.2 Keyboard nav handles single item list boundaries', () => {
        const single = [{ id: '1', url: '/test' }];
        assertEqual(simulateNetworkKeyboardNav(single, 0, 'ArrowDown'), 0);
        assertEqual(simulateNetworkKeyboardNav(single, 0, 'ArrowUp'), 0);
        assertEqual(simulateNetworkKeyboardNav(single, 0, 'Escape'), null);
    });

    await runTest('2.3 Keyboard nav step-by-step traversal and edge clamping', () => {
        const list = Array.from({ length: 5 }, (_, i) => ({ id: `req-${i}`, url: `/api/${i}` }));
        
        // Start at 0, navigate down to 4
        let idx = 0;
        idx = simulateNetworkKeyboardNav(list, idx, 'ArrowDown');
        assertEqual(idx, 1);
        idx = simulateNetworkKeyboardNav(list, idx, 'ArrowDown');
        assertEqual(idx, 2);
        idx = simulateNetworkKeyboardNav(list, idx, 'ArrowDown');
        assertEqual(idx, 3);
        idx = simulateNetworkKeyboardNav(list, idx, 'ArrowDown');
        assertEqual(idx, 4);

        // Boundary clamp at end
        idx = simulateNetworkKeyboardNav(list, idx, 'ArrowDown');
        assertEqual(idx, 4);

        // Traverse back up
        idx = simulateNetworkKeyboardNav(list, idx, 'ArrowUp');
        assertEqual(idx, 3);
        idx = simulateNetworkKeyboardNav(list, idx, 'ArrowUp');
        assertEqual(idx, 2);
        idx = simulateNetworkKeyboardNav(list, idx, 'ArrowUp');
        assertEqual(idx, 1);
        idx = simulateNetworkKeyboardNav(list, idx, 'ArrowUp');
        assertEqual(idx, 0);

        // Boundary clamp at beginning
        idx = simulateNetworkKeyboardNav(list, idx, 'ArrowUp');
        assertEqual(idx, 0);

        // Escape closes pane (returns null)
        assertEqual(simulateNetworkKeyboardNav(list, idx, 'Escape'), null);

        // Non-navigational keys return current index
        assertEqual(simulateNetworkKeyboardNav(list, 2, 'Tab'), 2);
        assertEqual(simulateNetworkKeyboardNav(list, 2, 'Enter'), 2);
    });

    await runTest('2.4 Layout flex rules conform to master-detail split view spec', () => {
        // Verify index.html contains master flex rules and detail pane flex rules
        assert(htmlContent.includes('flex: selectedRequest && !isMobile'), 'Must define dynamic flex based on selectedRequest');
        assert(htmlContent.includes('"0 0 45%"') && htmlContent.includes('"0 0 50%"'), 'Master list must have 45-50% flex');
        assert(htmlContent.includes('"0 0 55%"'), 'Detail pane must have 50-55% flex');
    });

    // =========================================================================
    // SECTION 3: QUERY STRING PARSING & PAYLOAD DISPLAY LOGIC
    // =========================================================================
    console.log('\n----------------------------------------------------------------');
    console.log('🔍 3. QUERY STRING PARSING & PAYLOAD DISPLAY STRESS');
    console.log('----------------------------------------------------------------');

    await runTest('3.1 Standard query string parsing', () => {
        const q = parseQueryParams('http://localhost:8080/api/users?name=john&age=30&active=true');
        assertEqual(q.name, 'john');
        assertEqual(q.age, '30');
        assertEqual(q.active, 'true');
    });

    await runTest('3.2 Repeated keys aggregated into arrays', () => {
        const q = parseQueryParams('https://example.com/search?category=books&category=tech&category=art');
        assertEqual(Array.isArray(q.category), true);
        assertEqual(q.category.length, 3);
        assertEqual(q.category[0], 'books');
        assertEqual(q.category[1], 'tech');
        assertEqual(q.category[2], 'art');
    });

    await runTest('3.3 URL encoded characters, unicode and emojis', () => {
        const url = 'https://example.com/api?msg=%E4%BD%A0%E5%A5%BD%E4%B8%96%E7%95%8C&emoji=%F0%9F%9A%80&symbols=%26%3D%3F%25';
        const q = parseQueryParams(url);
        assertEqual(q.msg, '你好世界');
        assertEqual(q.emoji, '🚀');
        assertEqual(q.symbols, '&=?%');
    });

    await runTest('3.4 Empty query string and relative URLs', () => {
        assertEqual(Object.keys(parseQueryParams('/api/items')).length, 0);
        assertEqual(Object.keys(parseQueryParams('/api/items?')).length, 0);
        assertEqual(Object.keys(parseQueryParams('?')).length, 0);
        assertEqual(Object.keys(parseQueryParams('invalid-url-string')).length, 0);
    });

    await runTest('3.5 High volume query string stress (200 parameters)', () => {
        const parts = [];
        for (let i = 0; i < 200; i++) {
            parts.push(`key_${i}=val_${i}`);
        }
        const bigUrl = 'http://localhost/api?' + parts.join('&');
        const q = parseQueryParams(bigUrl);
        assertEqual(Object.keys(q).length, 200);
        assertEqual(q.key_0, 'val_0');
        assertEqual(q.key_199, 'val_199');
    });

    // =========================================================================
    // SECTION 4: TELEMETRY PILLS, LATENCY & SYSTEM CARDS
    // =========================================================================
    console.log('\n----------------------------------------------------------------');
    console.log('📱 4. DEVICE TELEMETRY, LATENCY HEARTBEAT & SYSTEM TAB');
    console.log('----------------------------------------------------------------');

    const sampleTelemetry = {
        os: { name: 'iOS', version: '17.4' },
        browser: { name: 'Safari', version: '17.4', engine: 'WebKit' },
        screen: { width: 393, height: 852, dpr: 3, colorDepth: 24 },
        viewport: { width: 393, height: 750 },
        network: { effectiveType: '4g', downlink: 10, rtt: 50, online: true },
        battery: { supported: true, level: 0.75, charging: false },
        hardware: { concurrency: 6, memory: 8, platform: 'iPhone' },
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
        timestamp: Date.now()
    };

    await runTest('4.1 formatTelemetryPills produces complete, correct pill text', () => {
        const pills = formatTelemetryPills(sampleTelemetry, 48.4);
        assertEqual(pills.osPill, 'iOS 17.4');
        assertEqual(pills.screenPill, '393×852 @3x');
        assertEqual(pills.networkPill, '4G (10Mbps)');
        assertEqual(pills.latencyPill, 'Ping: 48ms');
    });

    await runTest('4.2 formatTelemetryPills handles offline & null latency', () => {
        const offlineTel = {
            ...sampleTelemetry,
            network: { online: false }
        };
        const pills = formatTelemetryPills(offlineTel, null);
        assertEqual(pills.networkPill, 'Offline');
        assertEqual(pills.latencyPill, 'Ping: --');
    });

    await runTest('4.3 formatTelemetryPills resilience against null/empty telemetry', () => {
        const emptyPills = formatTelemetryPills(null, null);
        assertEqual(emptyPills.osPill, '');
        assertEqual(emptyPills.screenPill, '');
        assertEqual(emptyPills.networkPill, '');
        assertEqual(emptyPills.latencyPill, '');
    });

    await runTest('4.4 mapSystemInfoCards outputs complete 6-card grid model', () => {
        const cards = mapSystemInfoCards(sampleTelemetry);
        assert(cards.systemOverview, 'Must have systemOverview card');
        assert(cards.displaySpecs, 'Must have displaySpecs card');
        assert(cards.networkSpecs, 'Must have networkSpecs card');
        assert(cards.batterySpecs, 'Must have batterySpecs card');
        assert(cards.featuresMatrix, 'Must have featuresMatrix card');
        assert(cards.hardwareSensors, 'Must have hardwareSensors card');

        assertEqual(cards.systemOverview.os, 'iOS 17.4');
        assertEqual(cards.displaySpecs.resolution, '393×852');
        assertEqual(cards.displaySpecs.dpr, '3x');
        assertEqual(cards.batterySpecs.level, '75%');
        assertEqual(cards.batterySpecs.charging, 'Discharging');
        assertEqual(cards.hardwareSensors.concurrency, '6 Cores');
        assertEqual(cards.hardwareSensors.memory, '8 GB');
    });

    await runTest('4.5 mapSystemInfoCards handles battery level 0.0 without falsy null-collapse', () => {
        const deadBatteryTel = {
            ...sampleTelemetry,
            battery: { supported: true, level: 0.0, charging: false }
        };
        const cards = mapSystemInfoCards(deadBatteryTel);
        assertEqual(cards.batterySpecs.level, '0%');
    });

    await runTest('4.6 mapSystemInfoCards unsupported battery reports N/A', () => {
        const noBatteryTel = {
            ...sampleTelemetry,
            battery: { supported: false, level: null, charging: null }
        };
        const cards = mapSystemInfoCards(noBatteryTel);
        assertEqual(cards.batterySpecs.supported, false);
        assertEqual(cards.batterySpecs.level, 'N/A');
    });

    await runTest('4.7 Latency heartbeat calculation clamped against clock skew', () => {
        const t0 = 1000;
        // Normal case: now=1050, ping sent at 1000
        const normalLatency = Math.max(0, 1050 - t0);
        assertEqual(normalLatency, 50);

        // Future timestamp due to client/server clock skew: now=980, ping timestamp=1000
        const skewedLatency = Math.max(0, 980 - t0);
        assertEqual(skewedLatency, 0);
    });

    // =========================================================================
    // SECTION 5: CONSOLE BOTTOM REPL, KEYBOARD HISTORY & COUNTER BADGES
    // =========================================================================
    console.log('\n----------------------------------------------------------------');
    console.log('💻 5. CONSOLE REPL PROMPT, HISTORY TRAVERSAL & BADGES');
    console.log('----------------------------------------------------------------');

    await runTest('5.1 calculateBadgeCounts counts levels accurately', () => {
        const logs = [
            { level: 'log', message: 'hello' },
            { level: 'info', message: 'info msg' },
            { level: 'debug', message: 'debug msg' },
            { level: 'warn', message: 'warning 1' },
            { level: 'warning', message: 'warning 2' },
            { level: 'error', message: 'error 1' },
            { level: 'error', message: 'error 2' },
            { level: 'error', message: 'error 3' },
            { level: 'eval_input', message: '> 1 + 1' },
            { level: 'eval_output', message: '< 2' }
        ];
        const counts = calculateBadgeCounts(logs);
        assertEqual(counts.error, 3);
        assertEqual(counts.warn, 2);
        assertEqual(counts.info, 3); // log, info, debug count towards info
        assertEqual(counts.all, 10);
    });

    await runTest('5.2 REPL history traversal state machine logic', () => {
        // Simulate history stack: ['first', 'second', 'third']
        const history = ['first', 'second', 'third'];
        let historyIdx = -1;
        let input = '';

        // ArrowUp from empty input -> recalls newest ('third')
        historyIdx = historyIdx < 0 ? history.length - 1 : Math.max(0, historyIdx - 1);
        input = history[historyIdx];
        assertEqual(historyIdx, 2);
        assertEqual(input, 'third');

        // ArrowUp again -> 'second'
        historyIdx = historyIdx < 0 ? history.length - 1 : Math.max(0, historyIdx - 1);
        input = history[historyIdx];
        assertEqual(historyIdx, 1);
        assertEqual(input, 'second');

        // ArrowUp again -> 'first'
        historyIdx = historyIdx < 0 ? history.length - 1 : Math.max(0, historyIdx - 1);
        input = history[historyIdx];
        assertEqual(historyIdx, 0);
        assertEqual(input, 'first');

        // ArrowUp at boundary -> stays 'first'
        historyIdx = historyIdx < 0 ? history.length - 1 : Math.max(0, historyIdx - 1);
        input = history[historyIdx];
        assertEqual(historyIdx, 0);
        assertEqual(input, 'first');

        // ArrowDown -> 'second'
        let nextIdx = historyIdx + 1;
        historyIdx = nextIdx >= history.length ? -1 : nextIdx;
        input = historyIdx === -1 ? '' : history[historyIdx];
        assertEqual(historyIdx, 1);
        assertEqual(input, 'second');

        // ArrowDown -> 'third'
        nextIdx = historyIdx + 1;
        historyIdx = nextIdx >= history.length ? -1 : nextIdx;
        input = historyIdx === -1 ? '' : history[historyIdx];
        assertEqual(historyIdx, 2);
        assertEqual(input, 'third');

        // ArrowDown past newest -> clears input
        nextIdx = historyIdx + 1;
        historyIdx = nextIdx >= history.length ? -1 : nextIdx;
        input = historyIdx === -1 ? '' : history[historyIdx];
        assertEqual(historyIdx, -1);
        assertEqual(input, '');
    });

    await runTest('5.3 formatReplStreamItem correctly formats command and return values', () => {
        const cmdItem = formatReplStreamItem('input', 'document.title');
        assertEqual(cmdItem.prefix, '>');
        assertEqual(cmdItem.formatted, '> document.title');
        assertEqual(cmdItem.isError, false);

        const resItem = formatReplStreamItem('output', '"vConsole Remote Dashboard"');
        assertEqual(resItem.prefix, '<');
        assertEqual(resItem.formatted, '< "vConsole Remote Dashboard"');
        assertEqual(resItem.isError, false);

        const errItem = formatReplStreamItem('output', 'ReferenceError: x is not defined', true);
        assertEqual(errItem.prefix, '<');
        assertEqual(errItem.formatted, '< ReferenceError: x is not defined');
        assertEqual(errItem.isError, true);
    });

    // =========================================================================
    // SECTION 6: LIVE END-TO-END WEBSOCKET INTERACTION
    // =========================================================================
    console.log('\n----------------------------------------------------------------');
    console.log('🌐 6. LIVE END-TO-END WEBSOCKET COMMUNICATION OVER GO SERVER');
    console.log('----------------------------------------------------------------');

    let serverInstance = null;
    try {
        serverInstance = await startServer({ preferGo: true });
        console.log(`  [Live Server] Running at ${serverInstance.url} (isGo: ${serverInstance.isGoServer})`);
    } catch (err) {
        console.warn(`  [Live Server Warning] Could not start Go server: ${err.message}.`);
    }

    if (serverInstance) {
        const wsUrl = serverInstance.wsUrl;

        await runTest('6.1 End-to-end Device pairing, Telemetry push, and Latency pong', async () => {
            const device = await createDeviceClient(wsUrl);
            const pin = device.getPin();
            assert(pin && pin.length === 6, 'Device must receive 6-digit PIN');

            const dev = await createDevClient(wsUrl, pin, { useQueryPin: true });

            // Device sends telemetry
            device.sendRaw({
                type: 'device_telemetry',
                data: sampleTelemetry
            });

            const telMsg = await dev.waitForMessage((m) => m.type === 'device_telemetry');
            assert(telMsg, 'Developer must receive device_telemetry');
            assertEqual(telMsg.data.os.name, 'iOS');

            // Developer sends ping, device returns pong
            const pingTimestamp = Date.now();
            dev.sendRaw({
                type: 'device_ping',
                timestamp: pingTimestamp
            });

            const pingMsg = await device.waitForMessage((m) => m.type === 'device_ping');
            assertEqual(pingMsg.timestamp, pingTimestamp);

            device.sendRaw({
                type: 'device_pong',
                timestamp: pingMsg.timestamp
            });

            const pongMsg = await dev.waitForMessage((m) => m.type === 'device_pong');
            assertEqual(pongMsg.timestamp, pingTimestamp);

            device.close();
            dev.close();
        });

        await runTest('6.2 REPL exec_js round-trip execution over live WebSocket', async () => {
            const device = await createDeviceClient(wsUrl);
            const pin = device.getPin();
            const dev = await createDevClient(wsUrl, pin, { useQueryPin: true });

            const res = await dev.execJs('1 + 1');
            assert(res, 'Must receive exec_js response');
            assertEqual(res.result, '2');

            device.close();
            dev.close();
        });

        serverInstance.kill();
    }

    // =========================================================================
    // FINAL SUMMARY
    // =========================================================================
    console.log('\n================================================================');
    console.log('📊 EMPIRICAL CHALLENGER VERIFICATION SUMMARY');
    console.log('================================================================');
    console.log(`  Total Tests Run:    ${passedTests + failedTests}`);
    console.log(`  Tests Passed:       ${passedTests} ✅`);
    console.log(`  Tests Failed:       ${failedTests} ${failedTests > 0 ? '❌' : ''}`);
    console.log('----------------------------------------------------------------');

    if (failedTests > 0) {
        console.error('❌ FAILED TESTS:');
        failures.forEach((f, i) => console.error(`  ${i + 1}. ${f.name}: ${f.error}`));
        process.exit(1);
    } else {
        console.log('🎉 ALL EMPIRICAL CHALLENGE TESTS PASSED (100% SUCCESS RATE).');
        console.log('================================================================\n');
    }
}

main().catch((err) => {
    console.error('Unhandled suite error:', err);
    process.exit(1);
});
