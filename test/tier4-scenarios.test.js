/**
 * test/tier4-scenarios.test.js
 * Tier 4: Real-World Application Scenarios (>=5 realistic scenarios)
 * 
 * Simulates complete realistic production debugging sessions:
 * 1. Complete Mobile App Debugging Lifecycle (Connect -> Pair -> Sync -> Log -> Inspect -> Mutate -> Disconnect)
 * 2. Latency-Critical Bug Hunting & Error Diagnostics (<50ms broker routing SLA)
 * 3. Complex Single-Page App DOM Hierarchy & Screen Snapshot Inspection
 * 4. Intermittent Mobile Connectivity, Drop & Re-pairing Resilience
 * 5. Multi-Tenant Team Debugging (3 concurrent developer-device sessions with <15MB RAM verification)
 * 
 * Total: 5 comprehensive end-to-end real-world scenarios
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

async function runTier4() {
    console.log('\n======================================================');
    console.log('🌐 RUNNING TIER 4: REAL-WORLD APPLICATION SCENARIOS');
    console.log('======================================================\n');

    let passed = 0;
    let failed = 0;
    const failures = [];

    async function test(name, fn) {
        process.stdout.write(`  • [Tier 4] ${name} ... `);
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
        console.log(`[Tier 4] Connected to server at ${serverHandle.url} (ws: ${serverHandle.wsUrl})\n`);

        // ====================================================================
        // SCENARIO 1: Complete Mobile App Debugging Lifecycle
        // ====================================================================
        await test('Scenario 1: Complete Mobile App Debugging Lifecycle Flow', async () => {
            // Step 1: Mobile user opens page with vConsole Remote
            const device = await createDeviceClient(serverHandle.wsUrl);
            const pin = device.roomPin;
            assertMatches(pin, /^\d{6}$/, 'Device received 6-digit PIN');

            // Step 2: Developer opens dashboard with URL /#/room/<PIN> and connects
            const dev = await createDevClient(serverHandle.wsUrl, pin);
            assertEqual(dev.pin, pin, 'Developer paired to room');

            // Step 3: Initial state dump (Storage and DOM Tree)
            const storage = await dev.pullStorage();
            assert(!!storage, 'Storage dump retrieved');

            const dom = await dev.pullDomTree();
            assert(!!dom, 'DOM tree dump retrieved');

            // Step 4: Real-time user action logging
            device.sendLog('info', 'User tapped #checkout-button');
            device.sendNetwork({ id: 'req-checkout-1', method: 'POST', url: '/api/v2/checkout', status: 200, duration: 42 });

            const logMsg = await dev.waitForMessage((m) => m.message === 'User tapped #checkout-button', 3000);
            assert(!!logMsg, 'Checkout tap log received');

            const netMsg = await dev.waitForMessage((m) => (m.request && m.request.id === 'req-checkout-1') || m.id === 'req-checkout-1', 3000);
            assert(!!netMsg, 'Checkout network metadata received');

            // Step 5: Network body inspection
            device.deviceState.networkBodies.set('req-checkout-1', JSON.stringify({ orderId: 'ord_98765', total: 49.99 }));
            const bodyResp = await dev.pullNetworkBody('req-checkout-1');
            const bodyStr = bodyResp.body || bodyResp.data;
            assert(bodyStr.includes('ord_98765'), 'Order ID found in payload');

            // Step 6: REPL state modification
            const replResp = await dev.execJs('100 + 25');
            assertEqual(replResp.result || replResp.output, '125', 'REPL state calculation matches');

            // Step 7: Mobile user closes tab / disconnects
            device.close();
            const discMsg = await dev.waitForMessage((m) => m.type === 'device_disconnected', 3000);
            assert(!!discMsg, 'Developer notified of device disconnection');

            dev.close();
        });

        // ====================================================================
        // SCENARIO 2: Latency-Critical Bug Hunting & Error Diagnostics
        // ====================================================================
        await test('Scenario 2: Latency-Critical Diagnostics & <50ms Broker Routing SLA', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            const latencies = [];
            const numSamples = 10;

            for (let i = 0; i < numSamples; i++) {
                const marker = `latency-probe-${i}`;
                const t0 = performance.now();
                device.sendLog('warn', marker);

                await dev.waitForMessage((m) => m.message === marker, 3000);
                const dt = performance.now() - t0;
                latencies.push(dt);
            }

            const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
            const maxLatency = Math.max(...latencies);

            // Assert routing latency is well within the 50ms SLA
            assert(avgLatency < 50, `Average broker latency ${avgLatency.toFixed(2)}ms exceeded 50ms SLA`);
            console.log(` (avg: ${avgLatency.toFixed(2)}ms, max: ${maxLatency.toFixed(2)}ms) `);

            dev.close();
            device.close();
        });

        // ====================================================================
        // SCENARIO 3: Complex Single-Page App DOM Hierarchy & Screen Snapshot
        // ====================================================================
        await test('Scenario 3: SPA DOM Inspection & Visual Screen Snapshot', async () => {
            const device = await createDeviceClient(serverHandle.wsUrl);
            
            // Populate realistic SPA DOM
            device.deviceState.domTree = {
                tagName: 'HTML',
                children: [
                    { tagName: 'HEAD', children: [{ tagName: 'TITLE', text: 'E-Commerce Mobile' }] },
                    {
                        tagName: 'BODY',
                        class: 'mobile-viewport theme-light',
                        children: [
                            { tagName: 'NAV', id: 'app-navbar', children: [{ tagName: 'H1', text: 'Products' }] },
                            {
                                tagName: 'MAIN',
                                id: 'product-feed',
                                children: [
                                    { tagName: 'ARTICLE', class: 'card', id: 'item-1', children: [{ tagName: 'SPAN', text: 'Headphones $99' }] },
                                    { tagName: 'ARTICLE', class: 'card', id: 'item-2', children: [{ tagName: 'SPAN', text: 'Keyboard $129' }] }
                                ]
                            },
                            { tagName: 'FOOTER', id: 'tab-bar', children: [{ tagName: 'BUTTON', text: 'Cart (2)' }] }
                        ]
                    }
                ]
            };

            const dev = await createDevClient(serverHandle.wsUrl, device.roomPin);

            // 1. Pull and verify DOM
            const domResp = await dev.pullDomTree();
            const tree = domResp.tree || domResp.data;
            const body = tree.children.find((c) => c.tagName === 'BODY');
            const main = body.children.find((c) => c.id === 'product-feed');
            assertEqual(main.children.length, 2, 'Found 2 product articles in feed');

            // 2. Pull visual screenshot
            const screenResp = await dev.pullScreenshot();
            const dataUrl = screenResp.data || screenResp.screenshot;
            assert(dataUrl.startsWith('data:image/png;base64,'), 'Valid PNG screen capture');

            // 3. REPL inspection of product count
            const repl = await dev.execJs('[99, 129].reduce((a, b) => a + b, 0)');
            assertEqual(repl.result || repl.output, '228', 'Cart total evaluated via REPL');

            dev.close();
            device.close();
        });

        // ====================================================================
        // SCENARIO 4: Intermittent Mobile Connectivity, Drop & Re-pairing
        // ====================================================================
        await test('Scenario 4: Intermittent Mobile Connectivity & Re-pairing Resilience', async () => {
            // Mobile session 1
            const device1 = await createDeviceClient(serverHandle.wsUrl);
            const dev1 = await createDevClient(serverHandle.wsUrl, device1.roomPin);

            device1.sendLog('info', 'Session 1 active');
            const msg1 = await dev1.waitForMessage((m) => m.message === 'Session 1 active', 3000);
            assert(!!msg1, 'Session 1 active message received');

            // Mobile loses connection (network drop / airplane mode)
            device1.close();
            const dropMsg = await dev1.waitForMessage((m) => m.type === 'device_disconnected', 3000);
            assert(!!dropMsg, 'Dev notified of connection drop');
            dev1.close();

            await sleep(150);

            // Mobile regains connection, re-registers
            const device2 = await createDeviceClient(serverHandle.wsUrl);
            assertMatches(device2.roomPin, /^\d{6}$/, 'New PIN generated on reconnection');

            // Dev pairs to new room PIN
            const dev2 = await createDevClient(serverHandle.wsUrl, device2.roomPin);
            device2.sendLog('info', 'Session 2 restored');
            const msg2 = await dev2.waitForMessage((m) => m.message === 'Session 2 restored', 3000);
            assert(!!msg2, 'Session 2 restored message received');

            // Verify full REPL operational in restored session
            const repl = await dev2.execJs('"online"');
            assertEqual(repl.result || repl.output, 'online', 'REPL works after reconnection');

            dev2.close();
            device2.close();
        });

        // ====================================================================
        // SCENARIO 5: Multi-Tenant Team Debugging & Memory Footprint Verification
        // ====================================================================
        await test('Scenario 5: Multi-Tenant Debugging (3 concurrent sessions) & < 15MB RAM', async () => {
            // Spawn 3 independent device-developer pairs
            const deviceA = await createDeviceClient(serverHandle.wsUrl);
            const deviceB = await createDeviceClient(serverHandle.wsUrl);
            const deviceC = await createDeviceClient(serverHandle.wsUrl);

            const devA = await createDevClient(serverHandle.wsUrl, deviceA.roomPin);
            const devB = await createDevClient(serverHandle.wsUrl, deviceB.roomPin);
            const devC = await createDevClient(serverHandle.wsUrl, deviceC.roomPin);

            // Execute concurrent operations across all 3 rooms
            const promises = [
                // Room A: iOS checkout diagnostics
                (async () => {
                    deviceA.sendLog('error', 'iOS Safari WebKit CSS bug');
                    deviceA.sendNetwork({ id: 'net-a', method: 'GET', url: '/ios/cart', status: 200, duration: 15 });
                    const m = await devA.waitForMessage((msg) => msg.message === 'iOS Safari WebKit CSS bug', 3000);
                    assert(!!m, 'Room A received log');
                    const r = await devA.execJs('navigator.userAgent || "Safari"');
                    assert(!!(r.result || r.output), 'Room A REPL evaluated');
                })(),

                // Room B: Android Chrome auth
                (async () => {
                    deviceB.sendLog('warn', 'Android Chrome token expired');
                    deviceB.sendNetwork({ id: 'net-b', method: 'POST', url: '/android/auth', status: 401, duration: 80 });
                    const m = await devB.waitForMessage((msg) => msg.message === 'Android Chrome token expired', 3000);
                    assert(!!m, 'Room B received log');
                    const r = await devB.execJs('1 + 2');
                    assertEqual(r.result || r.output, '3', 'Room B REPL evaluated');
                })(),

                // Room C: Tablet layout inspection
                (async () => {
                    deviceC.sendLog('debug', 'Tablet viewport orientation: landscape');
                    const m = await devC.waitForMessage((msg) => msg.message === 'Tablet viewport orientation: landscape', 3000);
                    assert(!!m, 'Room C received log');
                    const storage = await devC.pullStorage();
                    assert(!!storage, 'Room C storage pulled');
                })()
            ];

            await Promise.all(promises);

            // Verify Server Memory Footprint remains < 15MB
            const rssMb = serverHandle.getRssMb();
            console.log(` (Server RSS: ${rssMb.toFixed(2)} MB) `);
            assert(rssMb < 15.0, `Server RSS memory ${rssMb.toFixed(2)} MB exceeded 15 MB threshold`);

            devA.close();
            devB.close();
            devC.close();
            deviceA.close();
            deviceB.close();
            deviceC.close();
        });

    } finally {
        if (serverHandle) {
            await serverHandle.kill();
        }
    }

    console.log('\n======================================================');
    console.log(`TIER 4 SUMMARY: ${passed} PASSED, ${failed} FAILED (TOTAL: ${passed + failed})`);
    console.log('======================================================\n');

    if (failed > 0) {
        throw new Error(`Tier 4 suite had ${failed} failing test(s).`);
    }

    return { passed, failed };
}

if (require.main === module) {
    runTier4().then(
        () => process.exit(0),
        (err) => {
            console.error('\n❌ TIER 4 FAILED:', err.message);
            process.exit(1);
        }
    );
}

module.exports = { runTier4 };
