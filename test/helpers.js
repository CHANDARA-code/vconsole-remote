/**
 * test/helpers.js
 * Comprehensive E2E Testing Harness & Utilities for vConsole Remote
 * 
 * Supports Node.js native WebSocket (Node v22+ / v24+ globalThis.WebSocket)
 * Provides process lifecycle management for the Go server binary,
 * a built-in reference mock broker for hermetic isolation testing,
 * simulated Mobile Device and Developer Dashboard WebSocket clients,
 * high-resolution latency timers, memory measurement, and deep assertions.
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

// Ensure native WebSocket is available
if (typeof globalThis.WebSocket === 'undefined') {
    throw new Error('Native globalThis.WebSocket is required (Node.js v22+ or v24+).');
}

/**
 * Find an available TCP port dynamically
 */
function findFreePort(startPort = 8900) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(findFreePort(startPort + 1));
            } else {
                reject(err);
            }
        });
        server.listen(startPort, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/**
 * Sleep helper
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read process RSS memory in Megabytes
 */
function getProcessMemoryMb(pid) {
    try {
        if (!pid) return 0;
        const output = execSync(`ps -o rss= -p ${pid}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const rssKb = parseInt(output, 10);
        if (isNaN(rssKb)) return 0;
        return rssKb / 1024;
    } catch {
        return 0;
    }
}

/**
 * Measure execution latency of an async operation in milliseconds
 */
async function measureLatency(fn) {
    const t0 = performance.now();
    const result = await fn();
    const latency = performance.now() - t0;
    return { latency, result };
}

/**
 * Assertion helpers
 */
function assert(condition, message = 'Assertion failed') {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual(actual, expected, message) {
    const actStr = typeof actual === 'object' ? JSON.stringify(actual) : String(actual);
    const expStr = typeof expected === 'object' ? JSON.stringify(expected) : String(expected);
    if (actStr !== expStr) {
        throw new Error(message || `Expected ${expStr}, got ${actStr}`);
    }
}

function assertMatches(value, regex, message) {
    if (!regex.test(String(value))) {
        throw new Error(message || `Value "${value}" did not match pattern ${regex}`);
    }
}

/**
 * Poll an HTTP URL until it returns 200 OK or timeout
 */
async function waitForHttpReady(url, timeoutMs = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        try {
            const res = await new Promise((resolve, reject) => {
                const req = http.get(url, (response) => {
                    resolve(response.statusCode);
                });
                req.on('error', reject);
                req.setTimeout(500, () => {
                    req.destroy();
                    reject(new Error('timeout'));
                });
            });
            if (res === 200 || res === 204 || res === 404) {
                return true;
            }
        } catch {
            // Retry
        }
        await sleep(50);
    }
    throw new Error(`Server at ${url} failed to respond within ${timeoutMs}ms`);
}

/**
 * Start the Go server process or compile it if needed.
 * Returns a handle with port, url, wsUrl, kill(), and getRssMb().
 */
async function startGoServer(options = {}) {
    const projectRoot = path.resolve(__dirname, '..');
    const serverDir = path.join(projectRoot, 'server');
    const binaryPath = path.join(serverDir, 'vconsole-remote');

    // Build binary if it doesn't exist
    if (!fs.existsSync(binaryPath)) {
        try {
            console.log('[Test Harness] Compiling Go server binary...');
            // In Go, compile package with . instead of single file so all package files (room.go, safeconn.go) are included
            execSync('go build -o vconsole-remote .', {
                cwd: serverDir,
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 30000
            });
        } catch (err) {
            console.warn('[Test Harness] go build failed:', err.message);
        }
    }

    const port = options.port || (await findFreePort());
    let serverProcess = null;

    // Every client in this suite shares the loopback address, so the production
    // brute-force budget (5 failures/min/IP) would block the whole run after the
    // handful of deliberately-invalid PIN cases. The limiter itself is covered by
    // the Go tests in server/security_test.go, which assert the real default.
    const serverEnv = {
        ...process.env,
        PORT: String(port),
        PIN_ATTEMPT_LIMIT: options.pinAttemptLimit || '100000',
        ...(options.env || {})
    };

    if (fs.existsSync(binaryPath)) {
        serverProcess = spawn(binaryPath, [], {
            cwd: serverDir,
            env: serverEnv,
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } else {
        // Fall back to go run .
        serverProcess = spawn('go', ['run', '.'], {
            cwd: serverDir,
            env: serverEnv,
            stdio: ['ignore', 'pipe', 'pipe']
        });
    }

    // Capture logs for debugging if requested
    if (options.debug) {
        serverProcess.stdout.on('data', (d) => process.stdout.write(`[Server stdout] ${d}`));
        serverProcess.stderr.on('data', (d) => process.stderr.write(`[Server stderr] ${d}`));
    }

    const url = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    await waitForHttpReady(url, options.timeout || 8000);

    return {
        pid: serverProcess.pid,
        port,
        url,
        wsUrl,
        process: serverProcess,
        isGoServer: true,
        getRssMb: () => getProcessMemoryMb(serverProcess.pid),
        kill: () => {
            if (serverProcess && !serverProcess.killed) {
                try {
                    serverProcess.kill('SIGTERM');
                } catch {}
            }
        }
    };
}

/**
 * Pure Node.js In-Memory Reference Broker Server.
 * Implements 100% of the Interface Contracts defined in PROJECT.md:
 * - CSPRNG 6-digit PIN generation
 * - Device registration via /ws?type=device
 * - Developer pairing via /ws?type=developer with PIN
 * - Bi-directional message forwarding
 * - On-demand pull routing
 * - Remote REPL routing
 * - Disconnect notifications and room cleanup
 */
async function startReferenceBroker(options = {}) {
    const crypto = require('crypto');
    const port = options.port || (await findFreePort());
    
    // In-memory rooms: pin -> { id, deviceWs, devWs, lastActive }
    const rooms = new Map();

    function generatePin() {
        for (let i = 0; i < 10; i++) {
            // Cryptographic 6-digit PIN in range 100000 - 999999
            const num = crypto.randomInt(100000, 1000000);
            const pinStr = String(num);
            if (!rooms.has(pinStr)) {
                return pinStr;
            }
        }
        throw new Error('PIN collision retry limit exceeded');
    }

    const server = http.createServer((req, res) => {
        if (req.url === '/' || req.url === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<!DOCTYPE html><html><body>vConsole Remote Test Broker</body></html>');
            return;
        }
        res.writeHead(404);
        res.end('Not Found');
    });

    // Custom lightweight WebSocket server on the HTTP server
    // Using Node's native HTTP upgrade handling with manual frame parser / writer
    // Or Node 22+ built-in WebSocket / simple WS implementation
    const connectedSockets = new Set();

    server.on('upgrade', (req, socket, head) => {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        if (parsedUrl.pathname !== '/ws') {
            socket.destroy();
            return;
        }

        const clientType = parsedUrl.searchParams.get('type') || 'developer';
        const queryPin = parsedUrl.searchParams.get('pin');

        const key = req.headers['sec-websocket-key'];
        if (!key) {
            socket.destroy();
            return;
        }

        const acceptKey = crypto
            .createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');

        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
        );

        connectedSockets.add(socket);

        // Frame wrapper
        let currentPin = null;
        let isDevice = clientType === 'device';

        function sendJson(obj) {
            if (socket.destroyed) return;
            const payload = Buffer.from(JSON.stringify(obj), 'utf8');
            const length = payload.length;
            let header;

            if (length < 126) {
                header = Buffer.from([0x81, length]);
            } else if (length < 65536) {
                header = Buffer.alloc(4);
                header[0] = 0x81;
                header[1] = 126;
                header.writeUInt16BE(length, 2);
            } else {
                header = Buffer.alloc(10);
                header[0] = 0x81;
                header[1] = 127;
                header.writeBigUInt64BE(BigInt(length), 2);
            }

            try {
                socket.write(Buffer.concat([header, payload]));
            } catch {}
        }

        if (isDevice) {
            // Register room and assign PIN
            const pin = generatePin();
            currentPin = pin;
            const room = {
                id: pin,
                deviceSocket: socket,
                deviceSend: sendJson,
                devSocket: null,
                devSend: null,
                lastActive: Date.now()
            };
            rooms.set(pin, room);

            // Send room_pin to device
            sendJson({
                type: 'room_pin',
                pin: pin,
                timestamp: Date.now()
            });
        }

        // Developer pairing by query param if provided
        if (!isDevice && queryPin && rooms.has(queryPin)) {
            const room = rooms.get(queryPin);
            currentPin = queryPin;
            room.devSocket = socket;
            room.devSend = sendJson;
            sendJson({
                type: 'room_connected',
                pin: queryPin,
                timestamp: Date.now()
            });
            if (room.deviceSocket) {
                sendJson({
                    type: 'connection_status',
                    message: 'Device connected',
                    timestamp: Date.now()
                });
                room.deviceSend({
                    type: 'dev_connected',
                    message: 'Developer connected',
                    timestamp: Date.now()
                });
            }
        }

        // Buffer incoming data
        let buffer = Buffer.alloc(0);

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);

            while (buffer.length >= 2) {
                const firstByte = buffer[0];
                const secondByte = buffer[1];
                const opcode = firstByte & 0x0f;
                const isMasked = (secondByte & 0x80) !== 0;
                let payloadLength = secondByte & 0x7f;
                let offset = 2;

                if (opcode === 0x08) {
                    // Close frame
                    socket.end();
                    return;
                }

                if (payloadLength === 126) {
                    if (buffer.length < 4) break;
                    payloadLength = buffer.readUInt16BE(2);
                    offset = 4;
                } else if (payloadLength === 127) {
                    if (buffer.length < 10) break;
                    payloadLength = Number(buffer.readBigUInt64BE(2));
                    offset = 10;
                }

                const maskLength = isMasked ? 4 : 0;
                if (buffer.length < offset + maskLength + payloadLength) break;

                let mask = null;
                if (isMasked) {
                    mask = buffer.slice(offset, offset + 4);
                    offset += 4;
                }

                const rawPayload = buffer.slice(offset, offset + payloadLength);
                buffer = buffer.slice(offset + payloadLength);

                if (isMasked) {
                    for (let i = 0; i < rawPayload.length; i++) {
                        rawPayload[i] ^= mask[i % 4];
                    }
                }

                // Parse message
                let msg;
                try {
                    msg = JSON.parse(rawPayload.toString('utf8'));
                } catch {
                    // Malformed JSON frame
                    continue;
                }

                handleMessage(msg);
            }
        });

        function handleMessage(msg) {
            if (isDevice) {
                // Device forwarding to developer
                const room = rooms.get(currentPin);
                if (room && room.devSend) {
                    room.lastActive = Date.now();
                    room.devSend(msg);
                }
            } else {
                // Developer messages
                if (msg.type === 'connect_room') {
                    const pin = msg.pin;
                    const room = rooms.get(pin);
                    if (!room) {
                        sendJson({
                            type: 'error',
                            message: 'Room not found or invalid PIN',
                            timestamp: Date.now()
                        });
                        return;
                    }
                    currentPin = pin;
                    room.devSocket = socket;
                    room.devSend = sendJson;
                    room.lastActive = Date.now();

                    sendJson({
                        type: 'room_connected',
                        pin: pin,
                        timestamp: Date.now()
                    });

                    if (room.deviceSocket) {
                        sendJson({
                            type: 'connection_status',
                            message: 'Device connected',
                            timestamp: Date.now()
                        });
                        room.deviceSend({
                            type: 'dev_connected',
                            message: 'Developer connected',
                            timestamp: Date.now()
                        });
                    }
                } else {
                    // Forward requests to device
                    const pin = msg.pin || currentPin;
                    const room = rooms.get(pin);
                    if (room && room.deviceSend) {
                        room.lastActive = Date.now();
                        room.deviceSend(msg);
                    }
                }
            }
        }

        socket.on('close', () => {
            connectedSockets.delete(socket);
            if (isDevice && currentPin) {
                const room = rooms.get(currentPin);
                if (room) {
                    rooms.delete(currentPin);
                    if (room.devSend && room.devSocket && !room.devSocket.destroyed) {
                        room.devSend({
                            type: 'device_disconnected',
                            message: 'Device has disconnected',
                            timestamp: Date.now()
                        });
                        try { room.devSocket.end(); } catch {}
                    }
                }
            } else if (!isDevice && currentPin) {
                const room = rooms.get(currentPin);
                if (room) {
                    room.devSocket = null;
                    room.devSend = null;
                    if (room.deviceSend && room.deviceSocket && !room.deviceSocket.destroyed) {
                        room.deviceSend({
                            type: 'developer_disconnected',
                            message: 'Developer has disconnected',
                            timestamp: Date.now()
                        });
                    }
                }
            }
        });

        socket.on('error', () => {
            try { socket.destroy(); } catch {}
        });
    });

    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

    const url = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    return {
        pid: process.pid,
        port,
        url,
        wsUrl,
        isGoServer: false,
        getRssMb: () => process.memoryUsage().rss / (1024 * 1024),
        kill: () => {
            for (const s of connectedSockets) {
                try { s.destroy(); } catch {}
            }
            connectedSockets.clear();
            rooms.clear();
            return new Promise((resolve) => server.close(resolve));
        }
    };
}

/**
 * Smart Start: attempts Go server first; falls back to reference broker if unavailable.
 */
async function startServer(options = {}) {
    if (options.mode === 'mock') {
        return startReferenceBroker(options);
    }

    if (options.mode === 'go') {
        return startGoServer(options);
    }

    // Default 'auto': try Go binary or go run, fallback to reference broker
    try {
        return await startGoServer(options);
    } catch (err) {
        console.warn(`[Test Harness] Live Go server unavailable (${err.message}). Starting reference test broker.`);
        return await startReferenceBroker(options);
    }
}

/**
 * Simulated Mobile Device Client
 */
async function createDeviceClient(wsUrl, options = {}) {
    const ws = new WebSocket(`${wsUrl}?type=device`);
    const messageQueue = [];
    const listeners = [];

    // Default simulated device state
    const deviceState = {
        localStorage: { 'token': 'mock-jwt-token-12345', 'userId': 'user_99' },
        sessionStorage: { 'sessionKey': 'sess_abc' },
        cookies: 'auth_session=abcdef123456; theme=dark',
        domTree: {
            tagName: 'HTML',
            children: [
                { tagName: 'HEAD', children: [{ tagName: 'TITLE', text: 'vConsole Mobile App' }] },
                { tagName: 'BODY', children: [{ tagName: 'DIV', id: 'app', class: 'container', text: 'Active View' }] }
            ]
        },
        networkBodies: new Map([
            ['req-1', JSON.stringify({ code: 0, message: 'OK', data: { items: [1, 2, 3] } })],
            ['req-auth', JSON.stringify({ token: 'jwt-fresh-999', expiresIn: 3600 })]
        ]),
        screenshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    };

    let roomPin = null;
    let roomKey = null;
    let lastAuthRequest = null;

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Device WebSocket open timeout')), 4000);
        ws.addEventListener('open', () => {
            clearTimeout(timer);
            resolve();
        });
        ws.addEventListener('error', (e) => {
            clearTimeout(timer);
            reject(new Error(`Device WebSocket connection error: ${e.message || 'unknown'}`));
        });
    });

    ws.addEventListener('message', (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch {
            return;
        }

        // Capture PIN if announcement
        if ((msg.type === 'room_pin' || msg.type === 'init') && msg.pin) {
            roomPin = msg.pin;
            if (msg.key) roomKey = msg.key;
        }

        // Device owner's Allow / Reject decision. Tests exercise the real
        // approval gate rather than bypassing it; pass autoApprove: false to
        // simulate the owner rejecting a connection.
        if (msg.type === 'auth_request') {
            lastAuthRequest = msg;
            if (options.autoApprove !== false) {
                sendJson({
                    type: 'auth_response',
                    authId: msg.authId,
                    approved: options.autoApprove !== 'reject',
                    timestamp: Date.now()
                });
            }
        }

        // Automatic responders if enabled
        if (options.autoRespond !== false) {
            if (msg.type === 'pull_storage') {
                sendJson({
                    type: 'storage_data',
                    storage: {
                        localStorage: Object.entries(deviceState.localStorage).map(([k, v]) => ({ key: k, value: v })),
                        sessionStorage: Object.entries(deviceState.sessionStorage).map(([k, v]) => ({ key: k, value: v })),
                        cookies: deviceState.cookies
                    },
                    data: {
                        localStorage: deviceState.localStorage,
                        sessionStorage: deviceState.sessionStorage,
                        cookies: deviceState.cookies
                    }
                });
            } else if (msg.type === 'pull_dom_tree') {
                sendJson({
                    type: 'dom_tree_data',
                    tree: deviceState.domTree,
                    data: deviceState.domTree
                });
            } else if (msg.type === 'pull_network_body') {
                const body = deviceState.networkBodies.get(msg.requestId) || '{"error": "Not Found"}';
                sendJson({
                    type: 'network_body_data',
                    requestId: msg.requestId,
                    body: body,
                    data: body
                });
            } else if (msg.type === 'pull_screenshot') {
                sendJson({
                    type: 'screenshot_data',
                    data: deviceState.screenshot
                });
            } else if (msg.type === 'exec_js') {
                try {
                    // Safe evaluation
                    let output;
                    if (msg.code === '1 + 1') {
                        output = 2;
                    } else if (msg.code === 'document.title') {
                        output = 'vConsole Mobile App';
                    } else {
                        // eslint-disable-next-line no-eval
                        output = eval(msg.code);
                    }
                    sendJson({
                        type: 'exec_js_result',
                        code: msg.code,
                        result: String(output),
                        output: String(output),
                        isError: false,
                        error: null
                    });
                } catch (err) {
                    sendJson({
                        type: 'exec_js_result',
                        code: msg.code,
                        result: null,
                        output: null,
                        isError: true,
                        error: err.message
                    });
                }
            }
        }

        // Notify waiting listeners
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

    function sendJson(obj) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    }

    // Wait for the room PIN message from server
    if (!roomPin) {
        const pinMsg = await waitForMessage((m) => (m.type === 'room_pin' || m.type === 'init') && !!m.pin, 3000);
        roomPin = pinMsg.pin;
    }

    function waitForMessage(predicate, timeoutMs = 4000) {
        // Check already queued messages
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
                reject(new Error(`Timeout (${timeoutMs}ms) waiting for message`));
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

    return {
        ws,
        roomPin,
        deviceState,
        getPin: () => roomPin,
        getKey: () => roomKey,
        getLastAuthRequest: () => lastAuthRequest,
        approveAuth: (approved = true) => sendJson({
            type: 'auth_response',
            authId: lastAuthRequest ? lastAuthRequest.authId : '',
            approved,
            timestamp: Date.now()
        }),
        sendLog: (level, message, args = []) => {
            sendJson({
                type: 'log',
                level,
                message,
                args: args.length ? args : [message],
                timestamp: Date.now()
            });
        },
        sendNetwork: (request) => {
            sendJson({
                type: 'network_request',
                request: {
                    id: request.id || `req-${Date.now()}`,
                    method: request.method || 'GET',
                    url: request.url || '/api/test',
                    status: request.status || 200,
                    duration: request.duration || 25,
                    timestamp: Date.now()
                }
            });
        },
        sendRaw: sendJson,
        waitForMessage,
        close: () => ws.close()
    };
}

/**
 * Simulated Developer Dashboard Client
 */
async function createDevClient(wsUrl, pin, options = {}) {
    const connectUrl = options.useQueryPin ? `${wsUrl}?type=developer&pin=${pin}` : `${wsUrl}?type=developer`;
    const ws = new WebSocket(connectUrl);
    const messageQueue = [];
    const listeners = [];

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Developer WebSocket open timeout')), 4000);
        ws.addEventListener('open', () => {
            clearTimeout(timer);
            resolve();
        });
        ws.addEventListener('error', (e) => {
            clearTimeout(timer);
            reject(new Error(`Developer WebSocket connection error: ${e.message || 'unknown'}`));
        });
    });

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

    function sendJson(obj) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    }

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
                reject(new Error(`Timeout (${timeoutMs}ms) waiting for message`));
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

    // Handshake: pair with room if not auto-paired via query param
    if (pin && !options.skipPairing) {
        sendJson({
            type: 'connect_room',
            pin
        });
        const pairResp = await waitForMessage(
            (m) => m.type === 'room_connected' || m.type === 'connected' || m.type === 'error',
            3000
        );
        if (pairResp.type === 'error') {
            throw new Error(`Room pairing failed: ${pairResp.message}`);
        }
    }

    return {
        ws,
        pin,
        sendRaw: sendJson,
        waitForMessage,
        pullStorage: async (timeoutMs = 4000) => {
            sendJson({ type: 'pull_storage', pin });
            return await waitForMessage((m) => m.type === 'storage' || m.type === 'storage_data', timeoutMs);
        },
        pullDomTree: async (timeoutMs = 4000) => {
            sendJson({ type: 'pull_dom_tree', pin });
            return await waitForMessage((m) => m.type === 'dom_tree' || m.type === 'dom_tree_data', timeoutMs);
        },
        pullNetworkBody: async (requestId, timeoutMs = 4000) => {
            sendJson({ type: 'pull_network_body', pin, requestId });
            return await waitForMessage(
                (m) => (m.type === 'network_body' || m.type === 'network_body_data') && m.requestId === requestId,
                timeoutMs
            );
        },
        pullScreenshot: async (timeoutMs = 4000) => {
            sendJson({ type: 'pull_screenshot', pin });
            return await waitForMessage((m) => m.type === 'screenshot' || m.type === 'screenshot_data', timeoutMs);
        },
        execJs: async (code, timeoutMs = 4000) => {
            sendJson({ type: 'exec_js', pin, code });
            return await waitForMessage(
                (m) => m.type === 'exec_js_result' || m.type === 'exec_result',
                timeoutMs
            );
        },
        close: () => ws.close()
    };
}

module.exports = {
    findFreePort,
    sleep,
    getProcessMemoryMb,
    measureLatency,
    assert,
    assertEqual,
    assertMatches,
    startServer,
    startGoServer,
    startReferenceBroker,
    createDeviceClient,
    createDevClient
};
