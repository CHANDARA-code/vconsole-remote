/**
 * test/e2e-verify.js
 * 10-Step Automated End-to-End Verification Pipeline for vConsole Remote
 * 
 * Verifies all 10 critical production acceptance assertions:
 * Step 1: Spawns the compiled Go server binary.
 * Step 2: Simulates mobile device WebSocket connection (/ws?type=device).
 * Step 3: Validates receipt of 6-digit cryptographic PIN.
 * Step 4: Simulates developer browser WebSocket connection with matching PIN.
 * Step 5: Validates real-time push streaming of console logs with < 50ms latency.
 * Step 6: Validates network request metadata push.
 * Step 7: Dispatches on-demand pull requests (storage, dom_tree, network_body) and validates returned payloads.
 * Step 8: Dispatches exec_js expression and validates evaluated result.
 * Step 9: Validates clean disconnect and dead room cleanup.
 * Step 10: Asserts server process RAM usage remains strictly below 15MB RSS.
 */

const {
    startGoServer,
    createDeviceClient,
    createDevClient,
    assert,
    assertEqual,
    assertMatches,
    sleep,
    getProcessMemoryMb
} = require('./helpers');

async function runE2EVerification() {
    console.log('\n======================================================');
    console.log('🏁 STARTING vCONSOLE REMOTE 10-STEP E2E VERIFICATION');
    console.log('======================================================\n');

    let serverProcess = null;

    try {
        // Step 1: Spawn the compiled Go server binary
        console.log('[Step 1/10] Spawning Go server binary...');
        serverProcess = await startGoServer({ timeout: 8000 });
        console.log(`✓ Server running at ${serverProcess.url} (PID: ${serverProcess.pid})`);

        // Step 2: Simulate mobile device WebSocket connection
        console.log('[Step 2/10] Connecting mobile device WebSocket to /ws?type=device...');
        const device = await createDeviceClient(serverProcess.wsUrl);
        assert(device.ws.readyState === WebSocket.OPEN, 'Mobile device socket is OPEN');
        console.log('✓ Mobile device WebSocket connection established');

        // Step 3: Validate receipt of 6-digit PIN
        console.log('[Step 3/10] Validating receipt of 6-digit room PIN...');
        const roomPin = device.roomPin;
        assert(!!roomPin, 'Room PIN must not be empty');
        assertMatches(roomPin, /^\d{6}$/, `PIN format must be 6 numeric digits, got: ${roomPin}`);
        const pinNum = parseInt(roomPin, 10);
        assert(pinNum >= 100000 && pinNum <= 999999, `PIN ${pinNum} must be in [100000, 999999]`);
        console.log(`✓ Received cryptographically secure 6-digit PIN: ${roomPin}`);

        // Step 4: Simulate developer browser WebSocket connection with PIN
        console.log('[Step 4/10] Connecting developer browser to room PIN...');
        const dev = await createDevClient(serverProcess.wsUrl, roomPin);
        assert(dev.ws.readyState === WebSocket.OPEN, 'Developer socket is OPEN');
        assertEqual(dev.pin, roomPin, 'Developer paired to matching PIN');
        console.log(`✓ Developer browser paired successfully to room ${roomPin}`);

        // Step 5: Validate real-time push streaming of console logs with < 50ms latency
        console.log('[Step 5/10] Validating console push streaming (< 50ms latency)...');
        const t0 = performance.now();
        const testLogText = 'E2E Latency Benchmark Log';
        device.sendLog('info', testLogText);

        const logMsg = await dev.waitForMessage(
            (m) => m.type === 'log' && (m.message === testLogText || (m.args && m.args.includes(testLogText))),
            3000
        );
        const latency = performance.now() - t0;
        assert(!!logMsg, 'Console log message received by developer');
        console.log(`✓ Console log pushed and received in ${latency.toFixed(2)}ms (SLA: < 50ms)`);
        assert(latency < 50.0, `Console push latency ${latency.toFixed(2)}ms exceeded 50ms threshold`);

        // Step 6: Validate network request metadata push
        console.log('[Step 6/10] Validating network request metadata streaming...');
        const testReqId = 'req-e2e-1001';
        device.sendNetwork({
            id: testReqId,
            method: 'POST',
            url: '/api/v1/orders',
            status: 201,
            duration: 18
        });

        const netMsg = await dev.waitForMessage(
            (m) => (m.request && m.request.id === testReqId) || m.id === testReqId,
            3000
        );
        assert(!!netMsg, 'Network metadata message received');
        const reqData = netMsg.request || netMsg;
        assertEqual(reqData.method, 'POST', 'HTTP method is POST');
        assertEqual(reqData.status, 201, 'HTTP status is 201');
        assertEqual(reqData.duration, 18, 'Duration is 18ms');
        console.log('✓ Network request metadata push successfully validated');

        // Step 7: Dispatch on-demand pull requests (storage, dom_tree, network_body)
        console.log('[Step 7/10] Dispatching on-demand pull requests...');
        // 7a. Storage pull
        const storageResp = await dev.pullStorage();
        assert(!!storageResp, 'Storage response received');
        const storage = storageResp.storage || storageResp.data;
        assert(!!storage.localStorage, 'localStorage data present');
        console.log('  • On-demand pull_storage: OK');

        // 7b. DOM tree pull
        const domResp = await dev.pullDomTree();
        assert(!!domResp, 'DOM tree response received');
        const tree = domResp.tree || domResp.data;
        assertEqual(tree.tagName, 'HTML', 'Root DOM tag is HTML');
        console.log('  • On-demand pull_dom_tree: OK');

        // 7c. Network body pull
        const bodyResp = await dev.pullNetworkBody('req-1');
        assert(!!bodyResp, 'Network body response received');
        assertEqual(bodyResp.requestId, 'req-1', 'Matching requestId returned');
        console.log('  • On-demand pull_network_body: OK');
        console.log('✓ All on-demand reverse pull protocols validated');

        // Step 8: Dispatch exec_js expression and validate execution result
        console.log('[Step 8/10] Dispatching remote REPL exec_js expression...');
        const replResp = await dev.execJs('1 + 1');
        assert(!!replResp, 'REPL response received');
        const output = replResp.result !== undefined ? replResp.result : replResp.output;
        assertEqual(output, '2', 'Expression 1 + 1 evaluated to 2');
        assert(!replResp.isError, 'isError flag is false');
        console.log('✓ Remote REPL evaluated "1 + 1" -> "2"');

        // Step 9: Validate clean disconnect and dead room cleanup
        console.log('[Step 9/10] Validating clean disconnect and room cleanup...');
        device.close();
        dev.close();
        await sleep(200);

        // Verify room cleanup: connect new dev to dead room PIN
        const deadDevWs = new WebSocket(`${serverProcess.wsUrl}?type=developer`);
        await new Promise((r) => deadDevWs.addEventListener('open', r));
        deadDevWs.send(JSON.stringify({ type: 'connect_room', pin: roomPin }));

        const deadRoomResponse = await new Promise((resolve) => {
            deadDevWs.addEventListener('message', (e) => {
                try { resolve(JSON.parse(e.data)); } catch {}
            });
            setTimeout(() => resolve(null), 1500);
        });

        assert(deadRoomResponse !== null, 'Received server response for dead room attempt');
        assert(deadRoomResponse.type === 'error', 'Dead room connection rejected with error');
        deadDevWs.close();
        console.log('✓ Clean disconnect and room deletion validated');

        // Step 10: Assert server process RAM usage is < 15MB
        console.log('[Step 10/10] Inspecting server process RSS memory...');
        const rssMb = getProcessMemoryMb(serverProcess.pid);
        console.log(`✓ Server Process RSS Memory: ${rssMb.toFixed(2)} MB (Threshold: < 15.00 MB)`);
        assert(rssMb < 15.0, `RAM usage ${rssMb.toFixed(2)} MB exceeded 15.0 MB threshold`);

        console.log('\n======================================================');
        console.log('🎉 10/10 AUTOMATED E2E PIPELINE ASSERTIONS PASSED');
        console.log('======================================================\n');
        return true;
    } finally {
        if (serverProcess) {
            serverProcess.kill();
        }
    }
}

if (require.main === module) {
    runE2EVerification().then(
        () => process.exit(0),
        (err) => {
            console.error('\n❌ E2E VERIFICATION PIPELINE FAILED:', err.message);
            process.exit(1);
        }
    );
}

module.exports = { runE2EVerification };
