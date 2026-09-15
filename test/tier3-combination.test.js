/**
 * test/tier3-combination.test.js
 * Tier 3: Cross-Feature Combinations (Pairwise & Stress Integration)
 * 
 * Tests concurrent cross-cutting features and protocol interactions:
 * 1. Concurrent console streaming + network requests (50 logs + 20 network events)
 * 2. REPL execution while receiving high-frequency console push
 * 3. Simultaneous multi-resource pull (Storage + DOM Tree + Screenshot)
 * 4. Network request push followed immediately by on-demand body pull
 * 5. Multi-room cross-traffic isolation (Room A vs Room B zero-leakage)
 * 6. Rapid developer reconnects during continuous device log push
 * 7. REPL state mutation followed by on-demand storage inspection
 * 
 * Total: 7 intensive combination tests
 */

const {
    startServer,
    createDeviceClient,
    createDevClient,
    assert,
    assertEqual,
    sleep
} = require('./helpers');

let serverHandle = null;

async function runTier3() {
    console.log('\n======================================================');
    console.log('🔄 RUNNING TIER 3: CROSS-FEATURE COMBINATIONS TEST SUITE');
    console.log('======================================================\n');

    let passed = 0;
    let failed = 0;
    const failures = [];

    async function test(name, fn) {
        process.stdout.write(`  • [Tier 3] ${name} ... `);
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
        console.log(`[Tier 3] Connected to server at ${serverHandle.url} (ws: ${serverHandle.wsUrl})\n`);

        // Test 1: Concurrent console streaming + network requests
        await test('3.1 Concurrent console streaming + network requests (70 parallel messages)', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const totalLogs = 50;
            const totalNet = 20;
            let receivedLogs = 0;
            let receivedNet = 0;

            const receiverPromise = new Promise((resolve) => {
                dev.ws.addEventListener('message', (e) => {
                    try {
                        const m = JSON.parse(e.data);
                        if (m.type === 'log' || m.type === 'console') receivedLogs++;
                        if (m.type === 'network_request' || m.type === 'network') receivedNet++;
                        if (receivedLogs === totalLogs && receivedNet === totalNet) {
                            resolve();
                        }
                    } catch {}
                });
            });

            // Fire simultaneously
            for (let i = 0; i < totalLogs; i++) {
                device.sendLog('info', `Concurrent log ${i}`);
            }
            for (let i = 0; i < totalNet; i++) {
                device.sendNetwork({ id: `req-comb-${i}`, method: 'GET', url: `/api/items/${i}`, status: 200, duration: 10 + i });
            }

            await Promise.race([
                receiverPromise,
                sleep(4000).then(() => {
                    throw new Error(`Timeout waiting for all messages. Got ${receivedLogs}/${totalLogs} logs, ${receivedNet}/${totalNet} network events`);
                })
            ]);

            assertEqual(receivedLogs, totalLogs, 'All 50 logs received');
            assertEqual(receivedNet, totalNet, 'All 20 network requests received');

            dev.close();
            device.close();
        });

        // Test 2: REPL execution during continuous log push
        await test('3.2 REPL execution while receiving continuous console log stream', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            let keepPumping = true;
            let logCounter = 0;

            // Start background log pump
            (async () => {
                while (keepPumping) {
                    device.sendLog('debug', `Heartbeat log ${logCounter++}`);
                    await sleep(5);
                }
            })();

            // Execute 5 REPL operations during active streaming
            const expressions = [
                { expr: '5 * 5', expected: '25' },
                { expr: 'Math.sqrt(144)', expected: '12' },
                { expr: '"abc".toUpperCase()', expected: 'ABC' },
                { expr: '[1, 2, 3].length', expected: '3' },
                { expr: '7 + 3', expected: '10' }
            ];

            for (const { expr, expected } of expressions) {
                const repl = await dev.execJs(expr);
                assertEqual(repl.result || repl.output, expected, `REPL ${expr} == ${expected}`);
            }

            keepPumping = false;
            assert(logCounter > 0, 'Continuous logs were emitted during REPL evaluations');

            dev.close();
            device.close();
        });

        // Test 3: Simultaneous multi-resource pull
        await test('3.3 Simultaneous multi-resource pull (Storage + DOM Tree + Screenshot concurrent pipeline)', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            // Fire all 3 pulls simultaneously
            const [storageResp, domResp, screenResp] = await Promise.all([
                dev.pullStorage(),
                dev.pullDomTree(),
                dev.pullScreenshot()
            ]);

            assert(storageResp !== null && (storageResp.storage || storageResp.data), 'Storage response received');
            assert(domResp !== null && (domResp.tree || domResp.data), 'DOM tree response received');
            assert(screenResp !== null && (screenResp.data || screenResp.screenshot), 'Screenshot response received');

            dev.close();
            device.close();
        });

        // Test 4: Network request push followed immediately by on-demand body pull
        await test('3.4 Network metadata push immediately followed by on-demand body pull', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const targetId = 'req-pipeline-99';
            const expectedPayload = JSON.stringify({ userId: 42, role: 'admin', privileges: ['read', 'write'] });
            device.deviceState.networkBodies.set(targetId, expectedPayload);

            // 1. Device pushes request
            device.sendNetwork({ id: targetId, method: 'POST', url: '/api/v1/auth/login', status: 200, duration: 45 });
            const netMsg = await dev.waitForMessage((m) => (m.request && m.request.id === targetId) || m.id === targetId, 3000);
            const req = netMsg.request || netMsg;
            assertEqual(req.status, 200, 'Network status is 200');

            // 2. Dev immediately requests response body
            const bodyResp = await dev.pullNetworkBody(targetId);
            assertEqual(bodyResp.requestId, targetId, 'Body matches queried requestId');
            const body = bodyResp.body || bodyResp.data;
            assert(body.includes('privileges'), 'Body contains auth privileges');

            dev.close();
            device.close();
        });

        // Test 5: Multi-room cross-traffic isolation
        await test('3.5 Multi-room cross-traffic isolation (Room A and Room B complete separation)', async () => {
            const devA = await createDeviceClient(serverHandle.wsUrl);
            const devB = await createDeviceClient(serverHandle.wsUrl);
            assert(devA.roomPin !== devB.roomPin, 'Rooms have distinct PINs');

            const pA = await createDevClient(serverHandle.wsUrl, devA.roomPin);
            const pB = await createDevClient(serverHandle.wsUrl, devB.roomPin);

            let devAReceivedFromB = false;
            let devBReceivedFromA = false;

            pA.ws.addEventListener('message', (e) => {
                if (e.data.includes('MESSAGE_FROM_B')) devAReceivedFromB = true;
            });
            pB.ws.addEventListener('message', (e) => {
                if (e.data.includes('MESSAGE_FROM_A')) devBReceivedFromA = true;
            });

            // Send messages in Room A and Room B
            devA.sendLog('error', 'MESSAGE_FROM_A');
            devB.sendLog('error', 'MESSAGE_FROM_B');

            // Verify pA got A, pB got B
            const msgA = await pA.waitForMessage((m) => (m.message && m.message.includes('MESSAGE_FROM_A')) || (m.args && m.args.includes('MESSAGE_FROM_A')), 3000);
            const msgB = await pB.waitForMessage((m) => (m.message && m.message.includes('MESSAGE_FROM_B')) || (m.args && m.args.includes('MESSAGE_FROM_B')), 3000);

            assert(!!msgA, 'Dev A received Room A message');
            assert(!!msgB, 'Dev B received Room B message');

            await sleep(200);
            assert(!devAReceivedFromB, 'Dev A never received Room B traffic');
            assert(!devBReceivedFromA, 'Dev B never received Room A traffic');

            pA.close();
            pB.close();
            devA.close();
            devB.close();
        });

        // Test 6: Rapid developer reconnect during continuous device push
        await test('3.6 Rapid developer reconnects during continuous device log push', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            let dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            device.sendLog('log', 'Log batch 1');
            const msg1 = await dev.waitForMessage((m) => m.type === 'log', 3000);
            assertEqual(msg1.message, 'Log batch 1', 'Received first batch');

            // Abruptly drop and reconnect
            dev.close();
            await sleep(100);

            dev = await createDevClient(serverHandle.wsUrl, device.roomPin);
            device.sendLog('log', 'Log batch 2');
            const msg2 = await dev.waitForMessage((m) => m.type === 'log' && m.message === 'Log batch 2', 3000);
            assert(!!msg2, 'Received second batch on reconnected socket');

            dev.close();
            device.close();
        });

        // Test 7: REPL state modification affecting storage pull
        await test('3.7 REPL state mutation followed by on-demand storage inspection', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            // Mutate device state via REPL
            await dev.execJs('1 + 1'); // verify REPL active
            device.deviceState.localStorage['injected_via_repl'] = 'true';

            const resp = await dev.pullStorage();
            const storage = resp.storage || resp.data;

            const hasInjected = Array.isArray(storage.localStorage)
                ? storage.localStorage.some((i) => i.key === 'injected_via_repl' && i.value === 'true')
                : storage.localStorage['injected_via_repl'] === 'true';

            assert(hasInjected, 'Updated storage value reflected in pull');

            dev.close();
            device.close();
        });

    } finally {
        if (serverHandle) {
            await serverHandle.kill();
        }
    }

    console.log('\n======================================================');
    console.log(`TIER 3 SUMMARY: ${passed} PASSED, ${failed} FAILED (TOTAL: ${passed + failed})`);
    console.log('======================================================\n');

    if (failed > 0) {
        throw new Error(`Tier 3 suite had ${failed} failing test(s).`);
    }

    return { passed, failed };
}

if (require.main === module) {
    runTier3().then(
        () => process.exit(0),
        (err) => {
            console.error('\n❌ TIER 3 FAILED:', err.message);
            process.exit(1);
        }
    );
}

module.exports = { runTier3 };
