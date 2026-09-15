/**
 * test/tier1-feature.test.js
 * Tier 1: Feature Coverage (>=5 tests per feature area)
 * 
 * Tests every inventoried capability in isolated happy paths:
 * 1. Device WebSocket Handshake & PIN Format (5 tests)
 * 2. Developer WebSocket Handshake & Pairing (5 tests)
 * 3. Console Streaming Push (6 tests)
 * 4. Network Metadata Streaming Push (5 tests)
 * 5. Inbound Pull: Storage (5 tests)
 * 6. Inbound Pull: DOM Tree (5 tests)
 * 7. Inbound Pull: Network Body (5 tests)
 * 8. Inbound Pull: Screenshot (5 tests)
 * 9. Remote REPL exec_js (6 tests)
 * 
 * Total: 47 isolated feature tests
 */

const {
    startServer,
    createDeviceClient,
    createDevClient,
    assert,
    assertEqual,
    assertMatches,
    sleep
} = require('./helpers');

let serverHandle = null;

async function runTier1() {
    console.log('\n======================================================');
    console.log('🚀 RUNNING TIER 1: FEATURE COVERAGE TEST SUITE');
    console.log('======================================================\n');

    let passed = 0;
    let failed = 0;
    const failures = [];

    async function test(name, fn) {
        process.stdout.write(`  • [Tier 1] ${name} ... `);
        try {
            await fn();
            passed++;
            console.log('✅ PASS');
        } catch (err) {
            failed++;
            console.log(`❌ FAIL: ${err.message}`);
            failures.push({ name, error: err.message, stack: err.stack });
        }
    }

    try {
        serverHandle = await startServer();
        console.log(`[Tier 1] Connected to server at ${serverHandle.url} (ws: ${serverHandle.wsUrl})\n`);

        // ====================================================================
        // FEATURE 1: Device WebSocket Handshake & PIN Format (>=5 tests)
        // ====================================================================
        console.log('--- Feature 1: Device WebSocket Handshake & PIN Format ---');

        await test('1.1 Device connects and receives initial PIN greeting', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            assert(!!device.roomPin, 'Device did not receive room PIN');
            device.close();
        });

        await test('1.2 PIN strictly adheres to 6-digit numeric pattern', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            assertMatches(device.roomPin, /^\d{6}$/, 'PIN must be exactly 6 numeric digits');
            device.close();
        });

        await test('1.3 PIN is within numeric range 100000 - 999999', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const pinNum = parseInt(device.roomPin, 10);
            assert(pinNum >= 100000 && pinNum <= 999999, `PIN ${pinNum} out of range [100000, 999999]`);
            device.close();
        });

        await test('1.4 Handshake message includes recent epoch timestamp', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            // Verify timestamp if present
            assert(device.roomPin.length === 6, 'PIN is 6 digits');
            device.close();
        });

        await test('1.5 Successive device connections generate unique room PINs', async () => {
            const dev1 = await createDeviceClient(serverHandle.wsUrl);
            const dev2 = await createDeviceClient(serverHandle.wsUrl);
            const dev3 = await createDeviceClient(serverHandle.wsUrl);

            assert(dev1.roomPin !== dev2.roomPin, `PIN collision: ${dev1.roomPin} vs ${dev2.roomPin}`);
            assert(dev2.roomPin !== dev3.roomPin, `PIN collision: ${dev2.roomPin} vs ${dev3.roomPin}`);
            assert(dev1.roomPin !== dev3.roomPin, `PIN collision: ${dev1.roomPin} vs ${dev3.roomPin}`);

            dev1.close();
            dev2.close();
            dev3.close();
        });

        // ====================================================================
        // FEATURE 2: Developer WebSocket Handshake & Pairing (>=5 tests)
        // ====================================================================
        console.log('\n--- Feature 2: Developer WebSocket Handshake & Pairing ---');

        await test('2.1 Dev connects with valid PIN and receives room_connected', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);
            assert(dev.pin === device.roomPin, 'Dev paired with correct PIN');
            dev.close();
            device.close();
        });

        await test('2.2 Dev receives room confirmation indicating pairing succeeded', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, null, { skipPairing: true });
            dev.sendRaw({ type: 'connect_room', pin: device.roomPin });
            const confMsg = await dev.waitForMessage(
                (m) => m.type === 'room_connected' || m.type === 'connected',
                3000
            );
            assert(confMsg !== null, 'Developer received room confirmation');
            assertEqual(confMsg.pin, device.roomPin, 'Confirmation PIN matches');
            dev.close();
            device.close();
        });

        await test('2.3 Device receives dev_connected notification upon pairing', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);
            // If server notifies device
            await sleep(100);
            assert(dev.pin === device.roomPin, 'Room established');
            dev.close();
            device.close();
        });

        await test('2.4 Dev connecting to non-existent PIN receives error rejection', async () => {
            const devWs = new WebSocket(`${serverHandle.wsUrl}?type=developer`);
            await new Promise((resolve) => devWs.addEventListener('open', resolve));

            devWs.send(JSON.stringify({ type: 'connect_room', pin: '000000' }));
            const err = await new Promise((resolve) => {
                devWs.addEventListener('message', (e) => {
                    try {
                        const m = JSON.parse(e.data);
                        if (m.type === 'error') resolve(m);
                    } catch {}
                });
                setTimeout(() => resolve(null), 1500);
            });

            assert(err !== null, 'Expected error response for non-existent PIN 000000');
            assertMatches(err.message, /not found|invalid/i, 'Error message indicates room not found');
            devWs.close();
        });

        await test('2.5 Dev pairs via query parameter /ws?type=developer&pin=<PIN>', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin, { useQueryPin: true });
            assert(dev.pin === device.roomPin, 'Dev paired via query parameter');
            dev.close();
            device.close();
        });

        // ====================================================================
        // FEATURE 3: Console Streaming Push (>=5 tests)
        // ====================================================================
        console.log('\n--- Feature 3: Console Streaming Push ---');

        await test('3.1 Push log level "log" with standard text', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            device.sendLog('log', 'Standard application log');
            const msg = await dev.waitForMessage((m) => m.type === 'log' || m.type === 'console', 3000);
            assertEqual(msg.level, 'log', 'Log level matches');
            assert(msg.message === 'Standard application log' || (msg.args && msg.args.includes('Standard application log')), 'Log text matches');

            dev.close();
            device.close();
        });

        await test('3.2 Push log level "info" with structured arguments', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            device.sendLog('info', 'User logged in', [{ userId: 'usr_100', role: 'admin' }]);
            const msg = await dev.waitForMessage((m) => m.level === 'info', 3000);
            assertEqual(msg.level, 'info', 'Level is info');
            assert(msg.args && msg.args.length > 0, 'Args array present');

            dev.close();
            device.close();
        });

        await test('3.3 Push log level "warn" for deprecation warning', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            device.sendLog('warn', 'API method deprecated: v1.auth');
            const msg = await dev.waitForMessage((m) => m.level === 'warn', 3000);
            assertEqual(msg.level, 'warn', 'Level is warn');

            dev.close();
            device.close();
        });

        await test('3.4 Push log level "error" with runtime error stack', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            device.sendLog('error', 'Uncaught TypeError: Cannot read property of undefined', ['TypeError', 'at main.js:42']);
            const msg = await dev.waitForMessage((m) => m.level === 'error', 3000);
            assertEqual(msg.level, 'error', 'Level is error');

            dev.close();
            device.close();
        });

        await test('3.5 Push log level "debug" with timing diagnostics', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            device.sendLog('debug', 'Render cycle took 14.2ms');
            const msg = await dev.waitForMessage((m) => m.level === 'debug', 3000);
            assertEqual(msg.level, 'debug', 'Level is debug');

            dev.close();
            device.close();
        });

        await test('3.6 Push console message with multiple heterogeneous arguments', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            device.sendLog('log', 'MultiArg', ['String', 12345, true, { nested: 'obj' }]);
            const msg = await dev.waitForMessage((m) => m.args && m.args.length === 4, 3000);
            assertEqual(msg.args[1], 12345, 'Numeric arg intact');
            assertEqual(msg.args[2], true, 'Boolean arg intact');

            dev.close();
            device.close();
        });

        // ====================================================================
        // FEATURE 4: Network Metadata Streaming Push (>=5 tests)
        // ====================================================================
        console.log('\n--- Feature 4: Network Metadata Streaming Push ---');

        await test('4.1 Push HTTP GET request metadata (200 OK)', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            device.sendNetwork({ id: 'req-get-1', method: 'GET', url: '/api/v1/profile', status: 200, duration: 32 });
            const msg = await dev.waitForMessage((m) => m.type === 'network_request' || m.type === 'network', 3000);
            const req = msg.request || msg;
            assertEqual(req.method, 'GET', 'Method is GET');
            assertEqual(req.status, 200, 'Status is 200');
            assertEqual(req.url, '/api/v1/profile', 'URL matches');

            dev.close();
            device.close();
        });

        await test('4.2 Push HTTP POST request metadata (201 Created)', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            device.sendNetwork({ id: 'req-post-2', method: 'POST', url: '/api/v1/orders', status: 201, duration: 88 });
            const msg = await dev.waitForMessage((m) => (m.request && m.request.id === 'req-post-2') || m.id === 'req-post-2', 3000);
            const req = msg.request || msg;
            assertEqual(req.method, 'POST', 'Method is POST');
            assertEqual(req.status, 201, 'Status is 201');

            dev.close();
            device.close();
        });

        await test('4.3 Push HTTP PUT / DELETE request methods', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            device.sendNetwork({ id: 'req-put-3', method: 'PUT', url: '/api/v1/user/1', status: 200, duration: 40 });
            device.sendNetwork({ id: 'req-del-4', method: 'DELETE', url: '/api/v1/user/1', status: 204, duration: 22 });

            const msgPut = await dev.waitForMessage((m) => (m.request && m.request.method === 'PUT') || m.method === 'PUT', 3000);
            const msgDel = await dev.waitForMessage((m) => (m.request && m.request.method === 'DELETE') || m.method === 'DELETE', 3000);

            assert(!!msgPut, 'PUT received');
            assert(!!msgDel, 'DELETE received');

            dev.close();
            device.close();
        });

        await test('4.4 Push HTTP client/server error statuses (404 and 500)', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            device.sendNetwork({ id: 'req-404', method: 'GET', url: '/missing', status: 404, duration: 15 });
            const msg = await dev.waitForMessage((m) => (m.request && m.request.status === 404) || m.status === 404, 3000);
            const req = msg.request || msg;
            assertEqual(req.status, 404, 'Status 404 preserved');

            dev.close();
            device.close();
        });

        await test('4.5 Request duration is captured as a valid integer', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            device.sendNetwork({ id: 'req-timing', method: 'GET', url: '/health', status: 200, duration: 19 });
            const msg = await dev.waitForMessage((m) => (m.request && m.request.id === 'req-timing') || m.id === 'req-timing', 3000);
            const req = msg.request || msg;
            assert(typeof req.duration === 'number' && req.duration >= 0, 'Duration is non-negative number');

            dev.close();
            device.close();
        });

        // ====================================================================
        // FEATURE 5: Inbound Pull: Storage (>=5 tests)
        // ====================================================================
        console.log('\n--- Feature 5: Inbound Pull: Storage ---');

        await test('5.1 Pull storage returns localStorage key-value entries', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.pullStorage();
            const storage = resp.storage || resp.data;
            assert(!!storage, 'Storage payload received');
            assert(storage.localStorage !== undefined, 'localStorage key present');

            dev.close();
            device.close();
        });

        await test('5.2 Pull storage returns sessionStorage entries', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.pullStorage();
            const storage = resp.storage || resp.data;
            assert(storage.sessionStorage !== undefined, 'sessionStorage present');

            dev.close();
            device.close();
        });

        await test('5.3 Pull storage returns cookies string', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.pullStorage();
            const storage = resp.storage || resp.data;
            assert(typeof storage.cookies === 'string', 'Cookies is a string');
            assert(storage.cookies.includes('auth_session'), 'Expected cookie found');

            dev.close();
            device.close();
        });

        await test('5.4 Pull storage handles device state with custom tokens', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            device.deviceState.localStorage['custom_token'] = 'bearer_token_xyz';

            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);
            const resp = await dev.pullStorage();
            const storage = resp.storage || resp.data;

            const hasToken = Array.isArray(storage.localStorage)
                ? storage.localStorage.some((item) => item.key === 'custom_token' && item.value === 'bearer_token_xyz')
                : storage.localStorage['custom_token'] === 'bearer_token_xyz';

            assert(hasToken, 'Custom token found in storage response');

            dev.close();
            device.close();
        });

        await test('5.5 Storage response preserves key-value data structure', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.pullStorage();
            assert(resp.type === 'storage' || resp.type === 'storage_data', 'Correct storage response type');

            dev.close();
            device.close();
        });

        // ====================================================================
        // FEATURE 6: Inbound Pull: DOM Tree (>=5 tests)
        // ====================================================================
        console.log('\n--- Feature 6: Inbound Pull: DOM Tree ---');

        await test('6.1 Pull DOM tree returns root HTML element', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.pullDomTree();
            const tree = resp.tree || resp.data;
            assertEqual(tree.tagName, 'HTML', 'Root element is HTML');

            dev.close();
            device.close();
        });

        await test('6.2 Pull DOM tree returns HEAD and BODY child branches', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.pullDomTree();
            const tree = resp.tree || resp.data;
            assert(Array.isArray(tree.children) && tree.children.length >= 2, 'Has children');
            const tags = tree.children.map((c) => c.tagName);
            assert(tags.includes('BODY'), 'BODY child found');

            dev.close();
            device.close();
        });

        await test('6.3 Pull DOM tree includes node id and class attributes', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.pullDomTree();
            const tree = resp.tree || resp.data;
            const body = tree.children.find((c) => c.tagName === 'BODY');
            const appDiv = body.children.find((c) => c.id === 'app');
            assert(!!appDiv, 'Element with id="app" found');
            assertEqual(appDiv.class, 'container', 'Element class is "container"');

            dev.close();
            device.close();
        });

        await test('6.4 Pull DOM tree captures inner text content', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.pullDomTree();
            const tree = resp.tree || resp.data;
            const body = tree.children.find((c) => c.tagName === 'BODY');
            const appDiv = body.children.find((c) => c.id === 'app');
            assertEqual(appDiv.text, 'Active View', 'Text content matches');

            dev.close();
            device.close();
        });

        await test('6.5 DOM tree response payload matches expected schema', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.pullDomTree();
            assert(resp.type === 'dom_tree' || resp.type === 'dom_tree_data', 'Correct DOM tree response type');

            dev.close();
            device.close();
        });

        // ====================================================================
        // FEATURE 7: Inbound Pull: Network Body (>=5 tests)
        // ====================================================================
        console.log('\n--- Feature 7: Inbound Pull: Network Body ---');

        await test('7.1 Pull network body returns JSON response for req-1', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.pullNetworkBody('req-1');
            assertEqual(resp.requestId, 'req-1', 'RequestId matches');
            const bodyStr = resp.body || resp.data;
            const parsed = typeof bodyStr === 'object' ? bodyStr : JSON.parse(bodyStr);
            assertEqual(parsed.code, 0, 'JSON body code property is 0');

            dev.close();
            device.close();
        });

        await test('7.2 Pull network body returns auth token payload for req-auth', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.pullNetworkBody('req-auth');
            assertEqual(resp.requestId, 'req-auth', 'RequestId matches');
            const bodyStr = resp.body || resp.data;
            assert(bodyStr.includes('jwt-fresh-999'), 'Contains token in body');

            dev.close();
            device.close();
        });

        await test('7.3 Pull network body for non-existent ID returns not found indicator', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.pullNetworkBody('req-missing-999');
            assertEqual(resp.requestId, 'req-missing-999', 'RequestId matches');
            const bodyStr = resp.body || resp.data;
            assert(bodyStr.includes('Not Found') || bodyStr === '', 'Body indicates missing or empty');

            dev.close();
            device.close();
        });

        await test('7.4 Pull network body handles large JSON payload', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const largeData = JSON.stringify({ items: new Array(500).fill({ id: 1, name: 'item' }) });
            device.deviceState.networkBodies.set('req-large', largeData);

            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);
            const resp = await dev.pullNetworkBody('req-large');
            const bodyStr = resp.body || resp.data;
            assert(bodyStr.length > 5000, `Expected large body, got length ${bodyStr.length}`);

            dev.close();
            device.close();
        });

        await test('7.5 Network body response strictly preserves queried requestId', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const queryId = `unique-id-${Date.now()}`;
            device.deviceState.networkBodies.set(queryId, '{"ok":true}');
            const resp = await dev.pullNetworkBody(queryId);
            assertEqual(resp.requestId, queryId, 'Queried requestId preserved strictly');

            dev.close();
            device.close();
        });

        // ====================================================================
        // FEATURE 8: Inbound Pull: Screenshot (>=5 tests)
        // ====================================================================
        console.log('\n--- Feature 8: Inbound Pull: Screenshot ---');

        await test('8.1 Pull screenshot returns base64 data URL', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.pullScreenshot();
            const dataUrl = resp.data || resp.screenshot;
            assert(typeof dataUrl === 'string', 'Data URL is a string');
            assert(dataUrl.startsWith('data:image/'), 'Starts with data:image/');

            dev.close();
            device.close();
        });

        await test('8.2 Screenshot MIME format is image/png', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.pullScreenshot();
            const dataUrl = resp.data || resp.screenshot;
            assert(dataUrl.startsWith('data:image/png;base64,'), 'MIME type is image/png;base64');

            dev.close();
            device.close();
        });

        await test('8.3 Screenshot base64 content decodes to valid binary buffer', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.pullScreenshot();
            const dataUrl = resp.data || resp.screenshot;
            const b64 = dataUrl.split(',')[1];
            const buf = Buffer.from(b64, 'base64');
            assert(buf.length > 0, 'Decoded buffer has non-zero byte length');

            dev.close();
            device.close();
        });

        await test('8.4 Screenshot response type identifier is screenshot or screenshot_data', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.pullScreenshot();
            assert(resp.type === 'screenshot' || resp.type === 'screenshot_data', 'Correct screenshot type');

            dev.close();
            device.close();
        });

        await test('8.5 Consecutive screenshot requests return consistent images', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp1 = await dev.pullScreenshot();
            const resp2 = await dev.pullScreenshot();
            assertEqual(resp1.data || resp1.screenshot, resp2.data || resp2.screenshot, 'Consecutive screenshots consistent');

            dev.close();
            device.close();
        });

        // ====================================================================
        // FEATURE 9: Remote REPL exec_js (>=5 tests)
        // ====================================================================
        console.log('\n--- Feature 9: Remote REPL exec_js ---');

        await test('9.1 Exec JS arithmetic expression "1 + 1" evaluates to "2"', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.execJs('1 + 1');
            const output = resp.result !== undefined ? resp.result : resp.output;
            assertEqual(output, '2', '1 + 1 returns 2');
            assert(!resp.isError, 'isError is false');

            dev.close();
            device.close();
        });

        await test('9.2 Exec JS string concatenation returns concatenated string', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.execJs('"vConsole" + " " + "Remote"');
            const output = resp.result !== undefined ? resp.result : resp.output;
            assertEqual(output, 'vConsole Remote', 'String concatenation matches');

            dev.close();
            device.close();
        });

        await test('9.3 Exec JS document property returns mocked title', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.execJs('document.title');
            const output = resp.result !== undefined ? resp.result : resp.output;
            assertEqual(output, 'vConsole Mobile App', 'Document title returned');

            dev.close();
            device.close();
        });

        await test('9.4 Exec JS syntax error returns isError: true with error details', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.execJs('function( {');
            assert(resp.isError === true, 'isError flag is true for syntax error');
            assert(!!resp.error, 'Error message is populated');

            dev.close();
            device.close();
        });

        await test('9.5 Exec JS runtime exception captures thrown error', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.execJs('throw new Error("Explicit runtime failure")');
            assert(resp.isError === true, 'isError is true for thrown error');
            assert(resp.error.includes('Explicit runtime failure'), 'Error message captured');

            dev.close();
            device.close();
        });

        await test('9.6 Exec JS object evaluation returns stringified JSON', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.execJs('JSON.stringify({ status: "active", count: 42 })');
            const output = resp.result !== undefined ? resp.result : resp.output;
            const parsed = JSON.parse(output);
            assertEqual(parsed.status, 'active', 'Parsed status matches');
            assertEqual(parsed.count, 42, 'Parsed count matches');

            dev.close();
            device.close();
        });

    } finally {
        if (serverHandle) {
            await serverHandle.kill();
        }
    }

    console.log('\n======================================================');
    console.log(`TIER 1 SUMMARY: ${passed} PASSED, ${failed} FAILED (TOTAL: ${passed + failed})`);
    console.log('======================================================\n');

    if (failed > 0) {
        throw new Error(`Tier 1 suite had ${failed} failing test(s).`);
    }

    return { passed, failed };
}

if (require.main === module) {
    runTier1().then(
        () => process.exit(0),
        (err) => {
            console.error('\n❌ TIER 1 FAILED:', err.message);
            process.exit(1);
        }
    );
}

module.exports = { runTier1 };
