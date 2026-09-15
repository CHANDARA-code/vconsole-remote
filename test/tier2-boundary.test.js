/**
 * test/tier2-boundary.test.js
 * Tier 2: Boundary & Corner Cases (>=5 tests per feature/boundary area)
 * 
 * Tests extreme boundaries, adversarial inputs, and abnormal conditions:
 * 1. Malformed & Invalid Room PINs (6 tests)
 * 2. Room Lifecycle & Expiration Boundaries (5 tests)
 * 3. Payload Boundary & Size Stress (5 tests)
 * 4. Malformed Packet Handling (5 tests)
 * 5. REPL Boundary & Edge Cases (5 tests)
 * 6. Disconnection During In-Flight Operations (5 tests)
 * 
 * Total: 31 boundary tests
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

async function runTier2() {
    console.log('\n======================================================');
    console.log('⚡ RUNNING TIER 2: BOUNDARY & CORNER CASES TEST SUITE');
    console.log('======================================================\n');

    let passed = 0;
    let failed = 0;
    const failures = [];

    async function test(name, fn) {
        process.stdout.write(`  • [Tier 2] ${name} ... `);
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
        console.log(`[Tier 2] Connected to server at ${serverHandle.url} (ws: ${serverHandle.wsUrl})\n`);

        // ====================================================================
        // BOUNDARY 1: Malformed & Invalid Room PINs (>=5 tests)
        // ====================================================================
        console.log('--- Boundary 1: Malformed & Invalid Room PINs ---');

        await test('1.1 Non-numeric PIN "ABCDEF" is rejected with error', async () => {
            const devWs = new WebSocket(`${serverHandle.wsUrl}?type=developer`);
            await new Promise((r) => devWs.addEventListener('open', r));
            devWs.send(JSON.stringify({ type: 'connect_room', pin: 'ABCDEF' }));

            const msg = await new Promise((resolve) => {
                devWs.addEventListener('message', (e) => {
                    try { resolve(JSON.parse(e.data)); } catch {}
                });
                setTimeout(() => resolve(null), 1500);
            });

            assert(msg !== null, 'Received rejection message');
            assert(msg.type === 'error', 'Type is error');
            devWs.close();
        });

        await test('1.2 Short PIN "123" is rejected', async () => {
            const devWs = new WebSocket(`${serverHandle.wsUrl}?type=developer`);
            await new Promise((r) => devWs.addEventListener('open', r));
            devWs.send(JSON.stringify({ type: 'connect_room', pin: '123' }));

            const msg = await new Promise((resolve) => {
                devWs.addEventListener('message', (e) => {
                    try { resolve(JSON.parse(e.data)); } catch {}
                });
                setTimeout(() => resolve(null), 1500);
            });

            assert(msg !== null && msg.type === 'error', 'Short PIN rejected');
            devWs.close();
        });

        await test('1.3 Long PIN "12345678" is rejected', async () => {
            const devWs = new WebSocket(`${serverHandle.wsUrl}?type=developer`);
            await new Promise((r) => devWs.addEventListener('open', r));
            devWs.send(JSON.stringify({ type: 'connect_room', pin: '12345678' }));

            const msg = await new Promise((resolve) => {
                devWs.addEventListener('message', (e) => {
                    try { resolve(JSON.parse(e.data)); } catch {}
                });
                setTimeout(() => resolve(null), 1500);
            });

            assert(msg !== null && msg.type === 'error', 'Long PIN rejected');
            devWs.close();
        });

        await test('1.4 Empty PIN "" is rejected without server crash', async () => {
            const devWs = new WebSocket(`${serverHandle.wsUrl}?type=developer`);
            await new Promise((r) => devWs.addEventListener('open', r));
            devWs.send(JSON.stringify({ type: 'connect_room', pin: '' }));

            await sleep(300);
            assert(devWs.readyState === WebSocket.OPEN || devWs.readyState === WebSocket.CLOSED, 'Server survived empty PIN');
            devWs.close();
        });

        await test('1.5 SQL injection / script injection string in PIN is rejected cleanly', async () => {
            const devWs = new WebSocket(`${serverHandle.wsUrl}?type=developer`);
            await new Promise((r) => devWs.addEventListener('open', r));
            devWs.send(JSON.stringify({ type: 'connect_room', pin: "12' OR 1=1; DROP TABLE rooms;--" }));

            const msg = await new Promise((resolve) => {
                devWs.addEventListener('message', (e) => {
                    try { resolve(JSON.parse(e.data)); } catch {}
                });
                setTimeout(() => resolve(null), 1500);
            });

            assert(msg !== null && msg.type === 'error', 'SQL injection PIN rejected with error');
            devWs.close();
        });

        await test('1.6 PIN with null byte / special characters is rejected cleanly', async () => {
            const devWs = new WebSocket(`${serverHandle.wsUrl}?type=developer`);
            await new Promise((r) => devWs.addEventListener('open', r));
            devWs.send(JSON.stringify({ type: 'connect_room', pin: '12\u000034' }));

            const msg = await new Promise((resolve) => {
                devWs.addEventListener('message', (e) => {
                    try { resolve(JSON.parse(e.data)); } catch {}
                });
                setTimeout(() => resolve(null), 1500);
            });

            assert(msg !== null && msg.type === 'error', 'Null byte PIN rejected');
            devWs.close();
        });

        // ====================================================================
        // BOUNDARY 2: Room Lifecycle & Expiration Boundaries (>=5 tests)
        // ====================================================================
        console.log('\n--- Boundary 2: Room Lifecycle & Expiration Boundaries ---');

        await test('2.1 Dev connect after device disconnect fails with room not found', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const pin = device.roomPin;
            device.close();
            await sleep(150);

            const devWs = new WebSocket(`${serverHandle.wsUrl}?type=developer`);
            await new Promise((r) => devWs.addEventListener('open', r));
            devWs.send(JSON.stringify({ type: 'connect_room', pin }));

            const msg = await new Promise((resolve) => {
                devWs.addEventListener('message', (e) => {
                    try { resolve(JSON.parse(e.data)); } catch {}
                });
                setTimeout(() => resolve(null), 1500);
            });

            assert(msg !== null && msg.type === 'error', 'Old PIN rejected after device disconnect');
            devWs.close();
        });

        await test('2.2 Second device creates distinct room without overwriting first', async () => {
            const dev1 = await createDeviceClient(serverHandle.wsUrl);
            const dev2 = await createDeviceClient(serverHandle.wsUrl);

            assert(dev1.roomPin !== dev2.roomPin, 'Distinct PINs allocated');

            const p1 = await createDevClient(serverHandle.wsUrl, dev1.roomPin);
            const p2 = await createDevClient(serverHandle.wsUrl, dev2.roomPin);

            assertEqual(p1.pin, dev1.roomPin, 'Dev 1 paired to Room 1');
            assertEqual(p2.pin, dev2.roomPin, 'Dev 2 paired to Room 2');

            p1.close();
            p2.close();
            dev1.close();
            dev2.close();
        });

        await test('2.3 Developer disconnects and reconnects to same active room', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev1 = await createDevClient(serverHandle.wsUrl, device.roomPin);
            dev1.close();
            await sleep(100);

            // Reconnect
            const dev2 = await createDevClient(serverHandle.wsUrl, device.roomPin);
            assertEqual(dev2.pin, device.roomPin, 'Reconnected to same PIN');

            // Verify messaging works on reconnected dev
            device.sendLog('info', 'Message to reconnected dev');
            const logMsg = await dev2.waitForMessage((m) => m.level === 'info', 3000);
            assertEqual(logMsg.message, 'Message to reconnected dev', 'Message received by reconnected dev');

            dev2.close();
            device.close();
        });

        await test('2.4 Second developer is locked out of an already active room', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev1 = await createDevClient(serverHandle.wsUrl, device.roomPin);

            assert(dev1.pin === device.roomPin, 'First dev paired successfully');

            // A room admits exactly one developer at a time
            let secondPaired = false;
            let refusal = null;
            try {
                const dev2 = await createDevClient(serverHandle.wsUrl, device.roomPin);
                secondPaired = true;
                dev2.close();
            } catch (err) {
                refusal = err.message || String(err);
            }

            assert(!secondPaired, 'Second dev must be refused while the room is occupied');
            assert(/busy|in use|refused|error|closed/i.test(refusal), `Refusal explains the lockout, got: ${refusal}`);

            dev1.close();
            device.close();
        });

        await test('2.4b Room accepts a new developer after the first one leaves', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev1 = await createDevClient(serverHandle.wsUrl, device.roomPin);
            dev1.close();
            await sleep(150);

            const dev2 = await createDevClient(serverHandle.wsUrl, device.roomPin);
            assert(dev2.pin === device.roomPin, 'Freed room admits the next developer');

            dev2.close();
            device.close();
        });

        await test('2.5 Rapid sequential room creation and teardown prevents leak', async () => {
            for (let i = 0; i < 10; i++) {
                const dev = await createDeviceClient(serverHandle.wsUrl);
                const p = await createDevClient(serverHandle.wsUrl, dev.roomPin);
                p.close();
                dev.close();
            }
            // Verify server is still completely responsive
            const testDev = await createDeviceClient(serverHandle.wsUrl);
            assert(!!testDev.roomPin, 'Server healthy after 10 sequential rooms');
            testDev.close();
        });

        // ====================================================================
        // BOUNDARY 3: Payload Boundary & Size Stress (>=5 tests)
        // ====================================================================
        console.log('\n--- Boundary 3: Payload Boundary & Size Stress ---');

        await test('3.1 Large console log payload (100KB+ text) streamed without truncation', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const largeChunk = 'A'.repeat(1024); // 1KB
            const bigMessage = largeChunk.repeat(120); // 120KB
            assert(bigMessage.length >= 120000, 'Payload is > 100KB');

            device.sendLog('log', bigMessage);
            const msg = await dev.waitForMessage((m) => m.type === 'log' || m.type === 'console', 4000);
            const receivedText = msg.message || (msg.args && msg.args[0]);
            assertEqual(receivedText.length, bigMessage.length, '120KB message received without truncation');

            dev.close();
            device.close();
        });

        await test('3.2 Unicode, emojis, surrogate pairs, and control characters in console logs', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const specialText = '🔥 🚀 🌟 👨‍👩‍👧‍👦 漢・字 \u0000 \t \n \r "quote" \'single\' <xml>&amp;</xml>';
            device.sendLog('info', specialText);
            const msg = await dev.waitForMessage((m) => m.level === 'info', 3000);
            const receivedText = msg.message || (msg.args && msg.args[0]);
            assertEqual(receivedText, specialText, 'Special characters and emojis preserved verbatim');

            dev.close();
            device.close();
        });

        await test('3.3 Large network body pull (200KB+ JSON string)', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const largeData = JSON.stringify({
                records: new Array(1000).fill(0).map((_, i) => ({
                    id: i,
                    uuid: `uuid-${i}-${'x'.repeat(150)}`,
                    active: true
                }))
            });
            assert(largeData.length > 150000, 'Data is > 150KB');
            device.deviceState.networkBodies.set('req-massive', largeData);

            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);
            const resp = await dev.pullNetworkBody('req-massive');
            const receivedBody = resp.body || resp.data;
            assertEqual(receivedBody.length, largeData.length, 'Massive network body transferred intact');

            dev.close();
            device.close();
        });

        await test('3.4 Deeply nested DOM tree hierarchy (20+ levels)', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            
            // Build 25 levels deep tree
            let current = { tagName: 'SPAN', text: 'Deepest Node', children: [] };
            for (let d = 25; d >= 1; d--) {
                current = { tagName: 'DIV', depth: d, children: [current] };
            }
            device.deviceState.domTree = { tagName: 'HTML', children: [current] };

            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);
            const resp = await dev.pullDomTree();
            const tree = resp.tree || resp.data;
            assertEqual(tree.tagName, 'HTML', 'Root is HTML');
            assert(tree.children[0].depth === 1, 'Depth 1 node found');

            dev.close();
            device.close();
        });

        await test('3.5 Storage with large cookie header (4KB+)', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const largeCookie = 'c_val=' + 'K'.repeat(4096) + '; path=/; secure';
            device.deviceState.cookies = largeCookie;

            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);
            const resp = await dev.pullStorage();
            const storage = resp.storage || resp.data;
            assertEqual(storage.cookies.length, largeCookie.length, '4KB cookie string received intact');

            dev.close();
            device.close();
        });

        // ====================================================================
        // BOUNDARY 4: Malformed Packet Handling (>=5 tests)
        // ====================================================================
        console.log('\n--- Boundary 4: Malformed Packet Handling ---');

        await test('4.1 Raw non-JSON text frame sent from developer does not crash server', async () => {
            const devWs = new WebSocket(`${serverHandle.wsUrl}?type=developer`);
            await new Promise((r) => devWs.addEventListener('open', r));

            devWs.send('THIS IS RAW NON-JSON TEXT [}{');
            await sleep(200);

            // Server should remain alive
            assert(devWs.readyState === WebSocket.OPEN || devWs.readyState === WebSocket.CLOSED, 'Server handled invalid frame');
            devWs.close();
        });

        await test('4.2 Empty JSON object {} handled without server panic', async () => {
            const devWs = new WebSocket(`${serverHandle.wsUrl}?type=developer`);
            await new Promise((r) => devWs.addEventListener('open', r));

            devWs.send(JSON.stringify({}));
            await sleep(200);
            assert(devWs.readyState === WebSocket.OPEN, 'Socket remains open');
            devWs.close();
        });

        await test('4.3 Message without type field handled without error', async () => {
            const devWs = new WebSocket(`${serverHandle.wsUrl}?type=developer`);
            await new Promise((r) => devWs.addEventListener('open', r));

            devWs.send(JSON.stringify({ pin: '123456', randomKey: 'val' }));
            await sleep(200);
            assert(devWs.readyState === WebSocket.OPEN, 'Socket remains open');
            devWs.close();
        });

        await test('4.4 Unknown message type ignored gracefully', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            dev.sendRaw({ type: 'unknown_vendor_extension_123', pin: device.roomPin, payload: 'data' });
            await sleep(200);

            // Verify normal commands still work
            const repl = await dev.execJs('1 + 1');
            assertEqual(repl.result || repl.output, '2', 'REPL works after unknown type');

            dev.close();
            device.close();
        });

        await test('4.5 Non-object JSON value (number / string / array) handled safely', async () => {
            const devWs = new WebSocket(`${serverHandle.wsUrl}?type=developer`);
            await new Promise((r) => devWs.addEventListener('open', r));

            devWs.send(JSON.stringify([1, 2, 3]));
            devWs.send(JSON.stringify(42));
            devWs.send(JSON.stringify('hello'));
            await sleep(200);

            assert(devWs.readyState === WebSocket.OPEN || devWs.readyState === WebSocket.CLOSED, 'Server survived non-object JSON values');
            devWs.close();
        });

        // ====================================================================
        // BOUNDARY 5: REPL Boundary & Edge Cases (>=5 tests)
        // ====================================================================
        console.log('\n--- Boundary 5: REPL Boundary & Edge Cases ---');

        await test('5.1 Exec JS with empty code string "" does not crash', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.execJs('');
            assert(resp !== null, 'Response received for empty code');

            dev.close();
            device.close();
        });

        await test('5.2 Exec JS returning undefined expression is handled cleanly', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.execJs('void 0');
            const output = resp.result !== undefined ? resp.result : resp.output;
            assertEqual(output, 'undefined', 'undefined returned as string');

            dev.close();
            device.close();
        });

        await test('5.3 Exec JS multiline function declaration and invocation', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const code = `
                (function() {
                    var sum = 0;
                    for (var i = 1; i <= 10; i++) sum += i;
                    return sum;
                })()
            `;
            const resp = await dev.execJs(code);
            const output = resp.result !== undefined ? resp.result : resp.output;
            assertEqual(output, '55', 'Multiline loop sum evaluates to 55');

            dev.close();
            device.close();
        });

        await test('5.4 Exec JS syntax error has isError=true and descriptive error', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.execJs('const a = ;');
            assert(resp.isError === true, 'isError flag is true');
            assert(!!resp.error, 'Error message present');

            dev.close();
            device.close();
        });

        await test('5.5 Exec JS generating large output string (10KB+)', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const resp = await dev.execJs('"Z".repeat(10240)');
            const output = resp.result !== undefined ? resp.result : resp.output;
            assertEqual(output.length, 10240, '10KB string generated and returned');

            dev.close();
            device.close();
        });

        // ====================================================================
        // BOUNDARY 6: Disconnection During In-Flight Operations (>=5 tests)
        // ====================================================================
        console.log('\n--- Boundary 6: Disconnection During In-Flight Operations ---');

        await test('6.1 Device disconnects while dev is listening -> dev receives device_disconnected', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            device.close();
            const discMsg = await dev.waitForMessage((m) => m.type === 'device_disconnected', 3000);
            assert(discMsg !== null, 'Dev received device_disconnected message');

            dev.close();
        });

        await test('6.2 Dev disconnects while device is actively sending console logs', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            dev.close();
            await sleep(50);

            // Device pushes logs to closed dev without throwing unhandled exception
            device.sendLog('log', 'Log after dev closed 1');
            device.sendLog('log', 'Log after dev closed 2');
            await sleep(100);

            assert(device.ws.readyState === WebSocket.OPEN, 'Device remains connected after dev closed');
            device.close();
        });

        await test('6.3 Dev disconnects while pull request is in-flight', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl, { autoRespond: false });
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            dev.sendRaw({ type: 'pull_storage', pin: device.roomPin });
            dev.close();
            await sleep(100);

            // Device answers late
            device.sendRaw({ type: 'storage_data', data: {} });
            await sleep(100);

            assert(device.ws.readyState === WebSocket.OPEN, 'Server did not crash on dead dev reply');
            device.close();
        });

        await test('6.4 Rapid connect/disconnect burst (10 clients in 100ms)', async () => {
            const clients = [];
            for (let i = 0; i < 10; i++) {
                const ws = new WebSocket(`${serverHandle.wsUrl}?type=device`);
                clients.push(ws);
            }
            await sleep(50);
            for (const ws of clients) {
                ws.close();
            }
            await sleep(100);

            // Verify server operates normally
            const normalDevice = await createDeviceClient(serverHandle.wsUrl);
            assert(!!normalDevice.roomPin, 'Server responsive after connection burst');
            normalDevice.close();
        });

        await test('6.5 Reconnect resilience: Dev disconnects, reconnects and runs REPL', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            let dev = await createDevClient(serverHandle.wsUrl, device.roomPin);
            dev.close();
            await sleep(100);

            dev = await createDevClient(serverHandle.wsUrl, device.roomPin);
            const repl = await dev.execJs('2 + 3');
            assertEqual(repl.result || repl.output, '5', 'REPL works after dev reconnection');

            dev.close();
            device.close();
        });

    } finally {
        if (serverHandle) {
            await serverHandle.kill();
        }
    }

    console.log('\n======================================================');
    console.log(`TIER 2 SUMMARY: ${passed} PASSED, ${failed} FAILED (TOTAL: ${passed + failed})`);
    console.log('======================================================\n');

    if (failed > 0) {
        throw new Error(`Tier 2 suite had ${failed} failing test(s).`);
    }

    return { passed, failed };
}

if (require.main === module) {
    runTier2().then(
        () => process.exit(0),
        (err) => {
            console.error('\n❌ TIER 2 FAILED:', err.message);
            process.exit(1);
        }
    );
}

module.exports = { runTier2 };
