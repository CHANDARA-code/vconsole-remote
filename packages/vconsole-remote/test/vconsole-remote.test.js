/**
 * Comprehensive Unit Test Suite for vConsoleRemote Client SDK
 */
const assert = require('assert');

// Mock browser environment
class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    this.sentMessages = [];
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 5);
  }

  send(data) {
    this.sentMessages.push(JSON.parse(data));
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose();
  }

  // Helper to simulate server sending message to device
  simulateReceive(data) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }
}
MockWebSocket.instances = [];

class MockStorage {
  constructor() {
    this._data = {};
  }
  get length() {
    return Object.keys(this._data).length;
  }
  key(i) {
    return Object.keys(this._data)[i] || null;
  }
  getItem(k) {
    return this._data[k] !== undefined ? this._data[k] : null;
  }
  setItem(k, v) {
    this._data[k] = String(v);
  }
  removeItem(k) {
    delete this._data[k];
  }
  clear() {
    this._data = {};
  }
}

class MockElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.id = '';
    this.className = '';
    this.textContent = '';
    this.style = {};
    this.attributes = [];
    this.childNodes = [];
    this.children = this.childNodes;
  }
  appendChild(child) {
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  setAttribute(name, value) {
    this.attributes.push({ name, value });
  }
  getAttribute(name) {
    const a = this.attributes.find(x => x.name === name);
    return a ? a.value : null;
  }
  addEventListener(event, fn) {
    if (!this._listeners) this._listeners = {};
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }
  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) this.childNodes.splice(idx, 1);
    child.parentNode = null;
    return child;
  }
  click() {
    const cbs = (this._listeners && this._listeners['click']) || [];
    cbs.forEach(cb => cb({ type: 'click' }));
  }
  querySelectorAll(selector) {
    const wanted = selector.toUpperCase();
    const found = [];
    const walk = (node) => {
      for (const child of node.childNodes || []) {
        if (child.tagName === wanted) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  getContext() {
    return {
      fillStyle: '',
      fillRect: () => {},
      fillText: () => {}
    };
  }
  toDataURL() {
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  }
}

const elementsById = {};
const mockDocument = {
  nodeType: 9,
  title: 'Test App',
  cookie: 'sessionId=xyz123; user=alice',
  documentElement: new MockElement('html'),
  body: new MockElement('body'),
  createElement(tag) {
    const el = new MockElement(tag);
    return el;
  },
  getElementById(id) {
    return elementsById[id] || null;
  }
};

// Setup global mock window
const windowListeners = {};
global.window = {
  location: { origin: 'http://localhost:3000' },
  innerWidth: 375,
  innerHeight: 667,
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
  WebSocket: MockWebSocket
};
mockDocument.addEventListener = () => {};
mockDocument.removeEventListener = () => {};
global.document = mockDocument;
global.localStorage = global.window.localStorage;
global.sessionStorage = global.window.sessionStorage;
global.WebSocket = MockWebSocket;
global.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };

// Mock XMLHttpRequest
class MockXMLHttpRequest {
  constructor() {
    this._listeners = {};
    this.readyState = 0;
    this.status = 200;
    this.responseText = '{"mock":"xhr_response"}';
    this.responseType = '';
  }
  open(method, url) {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }
  setRequestHeader(h, v) {}
  getAllResponseHeaders() {
    return 'content-type: application/json\r\nx-custom: test';
  }
  addEventListener(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }
  send(body) {
    this.requestBody = body;
    this.readyState = 4;
    setTimeout(() => {
      const cbs = this._listeners['load'] || [];
      cbs.forEach(cb => cb());
    }, 5);
  }
}
global.XMLHttpRequest = MockXMLHttpRequest;
global.window.XMLHttpRequest = MockXMLHttpRequest;

// Load bundled UMD module
const VConsoleRemote = require('../dist/vconsole-remote.js');

async function runTests() {
  console.log('=== Starting VConsoleRemote Unit Test Suite ===\n');
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ FAIL: ${name}`);
      console.error(err);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ FAIL: ${name}`);
      console.error(err);
      failed++;
    }
  }

  // Test 1: Class exported properly
  test('VConsoleRemote class export', () => {
    assert.strictEqual(typeof VConsoleRemote, 'function');
    const instance = new VConsoleRemote({ server: 'http://localhost:8080', autoConnect: false });
    assert.ok(instance instanceof VConsoleRemote);
    instance.destroy();
  });

  // Test 2: URL parsing
  test('URL parsing (_parseServerUrls)', () => {
    const instance = new VConsoleRemote({ autoConnect: false });

    const res1 = instance._parseServerUrls('http://192.168.1.50:8080');
    assert.strictEqual(res1.serverOrigin, 'http://192.168.1.50:8080');
    assert.strictEqual(res1.wsUrl, 'ws://192.168.1.50:8080/ws?type=device');

    const res2 = instance._parseServerUrls('ws://localhost:9000');
    assert.strictEqual(res2.serverOrigin, 'http://localhost:9000');
    assert.strictEqual(res2.wsUrl, 'ws://localhost:9000/ws?type=device');

    const res3 = instance._parseServerUrls('https://debug.example.com/ws');
    assert.strictEqual(res3.serverOrigin, 'https://debug.example.com');
    assert.strictEqual(res3.wsUrl, 'wss://debug.example.com/ws?type=device');

    instance.destroy();
  });

  // Test 3: Console Monkey-Patching
  test('Console monkey-patching streams logs & preserves native console', () => {
    let nativeLogged = null;
    global.window.console.log = (...args) => {
      nativeLogged = args;
    };

    const instance = new VConsoleRemote({ autoConnect: true });
    const ws = instance.ws;

    window.console.log('Hello', { user: 'test' }, [1, 2]);

    assert.ok(nativeLogged, 'Native console.log must be called');
    assert.strictEqual(nativeLogged[0], 'Hello');

    const lastMsg = ws.sentMessages.find(m => m.type === 'console');
    assert.ok(lastMsg, 'Must emit type: console message');
    assert.strictEqual(lastMsg.level, 'log');
    assert.strictEqual(lastMsg.args[0], 'Hello');
    assert.strictEqual(lastMsg.args[1].user, 'test');
    assert.deepStrictEqual(lastMsg.args[2], [1, 2]);
    assert.ok(lastMsg.timestamp > 0);

    // Test recursion prevention
    let countBefore = ws.sentMessages.length;
    instance._isLogging = true;
    window.console.log('Should not send when _isLogging is true');
    instance._isLogging = false;
    assert.strictEqual(ws.sentMessages.length, countBefore, 'Recursion guard must prevent re-entry');

    instance.destroy();
  });

  // Test 4: Argument serialization with circular reference and Errors
  test('Safe serialization handles circular references and Errors', () => {
    const instance = new VConsoleRemote({ autoConnect: true });
    const circular = { a: 1 };
    circular.self = circular;

    const err = new Error('Test failure');
    const serialized = instance._serializeArgs([circular, err, undefined, null, BigInt(123)]);

    assert.strictEqual(serialized[0].a, 1);
    assert.strictEqual(serialized[0].self, '[Circular]');
    assert.strictEqual(serialized[1].message, 'Test failure');
    assert.strictEqual(serialized[2], 'undefined');
    assert.strictEqual(serialized[3], null);
    assert.strictEqual(serialized[4], '123n');

    instance.destroy();
  });

  // Test 5: Fetch Monkey-Patching
  await testAsync('Fetch monkey-patching captures metadata and stores body', async () => {
    // Mock native fetch
    global.window.fetch = async (url, options) => {
      return {
        status: 200,
        headers: {
          forEach: (cb) => { cb('application/json', 'content-type'); }
        },
        clone: () => ({
          text: async () => '{"status":"ok","items":[1,2,3]}'
        })
      };
    };

    const instance = new VConsoleRemote({ autoConnect: true });
    const ws = instance.ws;

    const res = await window.fetch('https://api.example.com/data', {
      method: 'POST',
      body: JSON.stringify({ query: 'test' })
    });

    assert.strictEqual(res.status, 200);

    // Wait a tick for clone().text() to finish caching
    await new Promise(r => setTimeout(r, 20));

    const netMsg = ws.sentMessages.find(m => m.type === 'network');
    assert.ok(netMsg, 'Must emit type: network message');
    assert.strictEqual(netMsg.request.method, 'POST');
    assert.strictEqual(netMsg.request.url, 'https://api.example.com/data');
    assert.strictEqual(netMsg.request.status, 200);
    assert.ok(typeof netMsg.request.duration === 'number');

    // Check cached body
    assert.ok(instance._networkCache.has(netMsg.request.id));
    const cached = instance._networkCache.get(netMsg.request.id);
    assert.strictEqual(cached.responseBody, '{"status":"ok","items":[1,2,3]}');

    instance.destroy();
  });

  // Test 6: XMLHttpRequest Monkey-Patching
  await testAsync('XMLHttpRequest monkey-patching captures metadata and stores body', async () => {
    const instance = new VConsoleRemote({ autoConnect: true });
    const ws = instance.ws;

    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/users');
    xhr.setRequestHeader('Authorization', 'Bearer token');
    xhr.send();

    await new Promise(r => setTimeout(r, 20));

    const netMsg = ws.sentMessages.find(m => m.type === 'network' && m.request.url === '/api/users');
    assert.ok(netMsg, 'Must emit XHR network message');
    assert.strictEqual(netMsg.request.method, 'GET');
    assert.strictEqual(netMsg.request.status, 200);

    assert.ok(instance._networkCache.has(netMsg.request.id));
    const cached = instance._networkCache.get(netMsg.request.id);
    assert.strictEqual(cached.responseBody, '{"mock":"xhr_response"}');

    instance.destroy();
  });

  // Test 7: Reverse Protocol - pull_network_body
  test('Inbound pull_network_body responds with network_body_data', () => {
    const instance = new VConsoleRemote({ autoConnect: true });
    const ws = instance.ws;

    instance._storeNetworkRequest('req_test_123', {
      id: 'req_test_123',
      method: 'GET',
      url: '/test',
      status: 200,
      duration: 15,
      responseBody: '{"result":"success"}'
    });

    ws.simulateReceive({
      type: 'pull_network_body',
      requestId: 'req_test_123'
    });

    const resp = ws.sentMessages.find(m => m.type === 'network_body_data');
    assert.ok(resp, 'Must respond with type: network_body_data');
    assert.strictEqual(resp.requestId, 'req_test_123');
    assert.strictEqual(resp.body, '{"result":"success"}');

    instance.destroy();
  });

  // Test 8: Reverse Protocol - pull_storage
  test('Inbound pull_storage responds with storage_data', () => {
    const instance = new VConsoleRemote({ autoConnect: true });
    const ws = instance.ws;

    localStorage.setItem('auth_token', 'jwt.123');
    sessionStorage.setItem('tab_id', 'tab-1');

    ws.simulateReceive({ type: 'pull_storage' });

    const resp = ws.sentMessages.find(m => m.type === 'storage_data');
    assert.ok(resp, 'Must respond with type: storage_data');
    assert.strictEqual(resp.data.sessionStorage.tab_id, 'tab-1');

    // Masking is on by default: credentials never leave the device
    assert.strictEqual(resp.data.localStorage.auth_token, '********');
    assert.ok(!resp.data.cookies.includes('xyz123'), 'Cookie values must be redacted');
    assert.ok(resp.data.cookies.includes('sessionId='), 'Cookie names stay visible');

    instance.destroy();
  });

  // Test 8b: Masking is opt-out for developers debugging their own auth flows
  test('Storage is sent unredacted when maskSensitiveData is false', () => {
    const instance = new VConsoleRemote({
      autoConnect: true,
      security: { maskSensitiveData: false }
    });
    const ws = instance.ws;

    localStorage.setItem('auth_token', 'jwt.123');
    ws.simulateReceive({ type: 'pull_storage' });

    const resp = ws.sentMessages.find(m => m.type === 'storage_data');
    assert.strictEqual(resp.data.localStorage.auth_token, 'jwt.123');
    assert.ok(resp.data.cookies.includes('sessionId=xyz123'));

    instance.destroy();
  });

  // Test 9: Reverse Protocol - pull_dom_tree
  test('Inbound pull_dom_tree responds with dom_tree_data hierarchy', () => {
    const instance = new VConsoleRemote({ autoConnect: true });
    const ws = instance.ws;

    const body = new MockElement('body');
    const div = new MockElement('div');
    div.id = 'root';
    div.setAttribute('class', 'container');
    body.appendChild(div);
    mockDocument.documentElement.appendChild(body);

    ws.simulateReceive({ type: 'pull_dom_tree' });

    const resp = ws.sentMessages.find(m => m.type === 'dom_tree_data');
    assert.ok(resp, 'Must respond with type: dom_tree_data');
    assert.ok(resp.data, 'Must include data hierarchy');
    assert.strictEqual(resp.data.tagName, 'HTML');
    assert.ok(resp.data.children.length > 0);

    instance.destroy();
  });

  // Test 10: Reverse Protocol - pull_screenshot
  test('Inbound pull_screenshot responds with screenshot_data', () => {
    const instance = new VConsoleRemote({ autoConnect: true });
    const ws = instance.ws;

    ws.simulateReceive({ type: 'pull_screenshot' });

    const resp = ws.sentMessages.find(m => m.type === 'screenshot_data');
    assert.ok(resp, 'Must respond with type: screenshot_data');
    assert.ok(resp.data.startsWith('data:image/png;base64,'), 'Must return valid dataUrl');

    instance.destroy();
  });

  // Test 11: Remote REPL exec_js Evaluation
  await testAsync('Remote REPL exec_js evaluates code and returns exec_result', async () => {
    const instance = new VConsoleRemote({
      autoConnect: true,
      security: { allowRemoteEval: true }
    });
    const ws = instance.ws;

    // Synchronous execution
    ws.simulateReceive({ type: 'exec_js', code: '2 + 3 * 4' });
    let resp = ws.sentMessages.find(m => m.type === 'exec_result' && m.result === '14');
    assert.ok(resp, 'Must evaluate arithmetic expression');
    assert.strictEqual(resp.isError, false);

    // Error execution
    ws.simulateReceive({ type: 'exec_js', code: 'nonExistentVar.foo()' });
    resp = ws.sentMessages.find(m => m.type === 'exec_result' && m.isError === true);
    assert.ok(resp, 'Must catch runtime error');
    assert.ok(resp.error.length > 0);

    // Promise execution
    ws.simulateReceive({ type: 'exec_js', code: 'Promise.resolve(42 + 8)' });
    await new Promise(r => setTimeout(r, 20));
    resp = ws.sentMessages.find(m => m.type === 'exec_result' && m.result === '50');
    assert.ok(resp, 'Must await Promise and return 50');

    instance.destroy();
  });

  // Test 12: Handshake & QR Code Canvas rendering
  test('Handshake updates PIN and renders QR canvas', () => {
    const instance = new VConsoleRemote({ server: 'http://localhost:8080', autoConnect: true });
    const ws = instance.ws;

    // Create tab content
    const tabDom = instance._createTabContent();
    assert.ok(tabDom);

    const canvas = tabDom.querySelector ? tabDom.querySelector('canvas') : tabDom.childNodes.find(c => c.childNodes && c.childNodes.find(k => k.tagName === 'CANVAS'));
    assert.ok(instance._qrCanvas, 'QR canvas element must be stored');
    assert.strictEqual(instance._qrCanvas.id, 'vconsole-remote-qr');

    // Simulate PIN received from server
    ws.simulateReceive({ type: 'room_pin', pin: '654321' });

    assert.strictEqual(instance.roomPin, '654321');

    instance.destroy();
  });

  // Test 11b: Remote evaluation is refused unless explicitly enabled
  test('exec_js is refused when allowRemoteEval is false (default)', () => {
    const instance = new VConsoleRemote({ autoConnect: true });
    const ws = instance.ws;

    globalThis.__vrPwned = false;
    ws.simulateReceive({ type: 'exec_js', code: 'globalThis.__vrPwned = true' });

    assert.strictEqual(globalThis.__vrPwned, false, 'Code must not execute on the device');

    const resp = ws.sentMessages.find(m => m.type === 'exec_result');
    assert.ok(resp, 'Must still answer the developer');
    assert.strictEqual(resp.isError, true);
    assert.ok(/disabled/i.test(resp.error), 'Must explain that evaluation is disabled');

    instance.destroy();
  });

  // Test 11c: Sensitive request/response headers are redacted
  test('Sensitive headers are redacted, auth scheme preserved', () => {
    const instance = new VConsoleRemote({ autoConnect: false });

    const masked = instance._maskHeaders({
      'Authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      'Cookie': 'session=xyz987',
      'X-Api-Key': 'sk_live_9931',
      'Content-Type': 'application/json'
    });

    assert.strictEqual(masked['Authorization'], 'Bearer [REDACTED]');
    assert.strictEqual(masked['Cookie'], '[REDACTED]');
    assert.strictEqual(masked['X-Api-Key'], '[REDACTED]');
    assert.strictEqual(masked['Content-Type'], 'application/json', 'Benign headers pass through');

    instance.destroy();
  });

  // Test 11d: Sensitive JSON and form body keys are redacted at any depth
  test('Sensitive body keys are redacted in JSON and form payloads', () => {
    const instance = new VConsoleRemote({ autoConnect: false });

    const json = JSON.parse(instance._maskBody(JSON.stringify({
      user: 'alex',
      password: 'mypassword',
      profile: { ssn: '123-45-6789', city: 'Phnom Penh' },
      cards: [{ card_number: '4111111111111111', label: 'primary' }]
    })));

    assert.strictEqual(json.user, 'alex');
    assert.strictEqual(json.password, '********');
    assert.strictEqual(json.profile.ssn, '********');
    assert.strictEqual(json.profile.city, 'Phnom Penh', 'Non-sensitive nested keys survive');
    assert.strictEqual(json.cards[0].card_number, '********');
    assert.strictEqual(json.cards[0].label, 'primary');

    const form = instance._maskBody('user=alex&password=hunter2&lang=km');
    assert.strictEqual(form, 'user=alex&password=********&lang=km');

    instance.destroy();
  });

  // Test 11e: Credentials in a query string are redacted
  test('Sensitive query parameters are redacted in captured URLs', () => {
    const instance = new VConsoleRemote({ autoConnect: false });

    const masked = instance._maskUrl('https://api.example.com/v1/me?api_key=sk_live_1&page=2');
    assert.ok(!masked.includes('sk_live_1'), 'Key value must not survive');
    assert.ok(masked.includes('page=2'), 'Benign parameters survive');

    assert.strictEqual(
      instance._maskUrl('https://api.example.com/v1/me'),
      'https://api.example.com/v1/me',
      'URLs without a query string are untouched'
    );

    instance.destroy();
  });

  // Test 11f: A custom key list fully replaces the defaults
  test('Custom sensitiveBodyKeys replace the built-in list', () => {
    const instance = new VConsoleRemote({
      autoConnect: false,
      security: { sensitiveBodyKeys: ['internal_ref'] }
    });

    const masked = JSON.parse(instance._maskBody(JSON.stringify({
      internal_ref: 'abc',
      password: 'still-visible'
    })));

    assert.strictEqual(masked.internal_ref, '********');
    assert.strictEqual(masked.password, 'still-visible', 'A custom list is authoritative');

    instance.destroy();
  });

  // Test 11g: Captured network records are masked in the cache itself
  test('Network cache stores masked headers and bodies', () => {
    const instance = new VConsoleRemote({ autoConnect: true });
    const ws = instance.ws;

    instance._storeNetworkRequest('req_1', {
      id: 'req_1',
      method: 'POST',
      url: 'https://api.example.com/login?token=leak',
      status: 200,
      duration: 12,
      requestHeaders: { Authorization: 'Bearer secret-jwt' },
      responseHeaders: { 'set-cookie': 'session=abc' },
      requestBody: JSON.stringify({ password: 'hunter2' }),
      responseBody: JSON.stringify({ access_token: 'tok_live' })
    });

    const cached = instance._networkCache.get('req_1');
    assert.strictEqual(cached.requestHeaders.Authorization, 'Bearer [REDACTED]');
    assert.strictEqual(cached.responseHeaders['set-cookie'], '[REDACTED]');
    assert.ok(!cached.requestBody.includes('hunter2'));
    assert.ok(!cached.responseBody.includes('tok_live'));
    assert.ok(!cached.url.includes('leak'));

    ws.simulateReceive({ type: 'pull_network_body', requestId: 'req_1' });
    const resp = ws.sentMessages.find(m => m.type === 'network_body_data');
    assert.ok(!JSON.stringify(resp).includes('tok_live'), 'Pulled body must stay redacted');

    instance.destroy();
  });

  // Test 11h: The device approval prompt gates the pairing
  test('auth_request renders an Allow/Reject prompt and answers the server', () => {
    const instance = new VConsoleRemote({ autoConnect: true });
    const ws = instance.ws;

    ws.simulateReceive({
      type: 'auth_request',
      authId: 'auth-123',
      expiresIn: 60,
      client: { description: 'Chrome on macOS', ip: '110.23.xx.xx' }
    });

    assert.ok(instance._authPrompt, 'Prompt element must be mounted');

    const buttons = instance._authPrompt.querySelectorAll('button');
    assert.strictEqual(buttons.length, 2, 'Prompt must offer exactly Allow and Reject');

    const allow = Array.from(buttons).find(b => b.textContent === 'Allow');
    assert.ok(allow, 'Allow button must exist');
    allow.click();

    const resp = ws.sentMessages.find(m => m.type === 'auth_response');
    assert.ok(resp, 'Must answer the server');
    assert.strictEqual(resp.authId, 'auth-123');
    assert.strictEqual(resp.approved, true);
    assert.strictEqual(instance._authPrompt, null, 'Prompt must be dismissed after answering');

    instance.destroy();
  });

  // Test 11i: Rejecting sends approved:false
  test('Rejecting the prompt denies the developer', () => {
    const instance = new VConsoleRemote({ autoConnect: true });
    const ws = instance.ws;

    ws.simulateReceive({
      type: 'auth_request',
      authId: 'auth-456',
      expiresIn: 60,
      client: { description: 'Firefox on Windows', ip: '203.0.xx.xx' }
    });

    const reject = Array.from(instance._authPrompt.querySelectorAll('button'))
      .find(b => b.textContent === 'Reject');
    reject.click();

    const resp = ws.sentMessages.find(m => m.type === 'auth_response');
    assert.strictEqual(resp.authId, 'auth-456');
    assert.strictEqual(resp.approved, false);

    instance.destroy();
  });

  // Test 11j: The QR code carries the room key issued by the server
  test('Room key from the server is embedded in the pairing URL', () => {
    const instance = new VConsoleRemote({ server: 'https://debug.example.com', autoConnect: true });
    const ws = instance.ws;

    ws.simulateReceive({ type: 'room_pin', pin: '482910', key: 'a8f9c73b9ea1b2c3' });

    assert.strictEqual(instance.roomPin, '482910');
    assert.strictEqual(instance.roomKey, 'a8f9c73b9ea1b2c3');

    const pairingUrl = instance._pairingUrl('482910');
    assert.strictEqual(
      pairingUrl,
      'https://debug.example.com/#/room/482910?key=a8f9c73b9ea1b2c3',
      `QR URL must carry the PIN and key, got ${pairingUrl}`
    );

    instance.destroy();
  });

  // Test 11k: Fast-path body masking and safe non-backtracking form handling
  test('Fast-path leaves non-sensitive bodies untouched and parses forms without catastrophic backtracking', () => {
    const instance = new VConsoleRemote({ autoConnect: false });

    // Non-sensitive payload returns identical string without deep traversal overhead
    const benignJson = JSON.stringify({ items: [1, 2, 3], status: 'ok', data: { name: 'product' } });
    const result1 = instance._maskBody(benignJson);
    assert.strictEqual(result1, benignJson, 'Benign body without sensitive keys must return unchanged');

    // Sensitive payload is correctly redacted
    const sensitiveJson = JSON.stringify({ user: 'bob', password: 'my-password-123' });
    const result2 = instance._maskBody(sensitiveJson);
    assert.ok(result2.includes('********'));
    assert.ok(!result2.includes('my-password-123'));

    // Safe linear form parsing with sensitive key
    const formWithSecret = 'field1=val1&secret=supersecret&field2=val2';
    const maskedForm = instance._maskBody(formWithSecret);
    assert.strictEqual(maskedForm, 'field1=val1&secret=********&field2=val2');

    // Potentially adversarial non-matching query string does not hang
    const nonMatching = 'a='.repeat(500) + 'invalid string with spaces and symbols';
    const start = Date.now();
    const safeOutput = instance._maskBody(nonMatching);
    assert.ok(Date.now() - start < 50, 'Must not stall on adversarial strings');
    assert.strictEqual(safeOutput, nonMatching);

    instance.destroy();
  });

  // Test 12a: Upload bodies are described, not stringified into "{}"
  test('Request bodies of every upload type are described usefully', () => {
    const instance = new VConsoleRemote({ autoConnect: false });

    const fd = new FormData();
    fd.append('caption', 'holiday photo');
    fd.append('password', 'hunter2');
    fd.append('file', new File([new Uint8Array(2048)], 'photo.png', { type: 'image/png' }));

    const form = instance._describeRequestBody(fd);
    assert.ok(form.includes('photo.png'), 'File name must be visible');
    assert.ok(form.includes('image/png'), 'File type must be visible');
    assert.ok(form.includes('2.0 KB'), `File size must be visible, got: ${form}`);
    assert.ok(form.includes('holiday photo'), 'Text fields stay readable');
    assert.ok(!form.includes('hunter2'), 'Sensitive form fields are still masked');
    assert.ok(form.includes('1 file'), 'Summary counts the files');

    const blob = instance._describeRequestBody(new Blob([new Uint8Array(1024)], { type: 'image/jpeg' }));
    assert.ok(/Blob.*image\/jpeg.*1\.0 KB/.test(blob), `Blob described, got: ${blob}`);

    const file = instance._describeRequestBody(new File([new Uint8Array(512)], 'doc.pdf', { type: 'application/pdf' }));
    assert.ok(file.includes('doc.pdf') && file.includes('512 B'), `File described, got: ${file}`);

    const buf = instance._describeRequestBody(new ArrayBuffer(4096));
    assert.ok(buf.includes('ArrayBuffer') && buf.includes('4.0 KB'), `ArrayBuffer described, got: ${buf}`);

    const params = instance._describeRequestBody(new URLSearchParams('a=1&b=2'));
    assert.strictEqual(params, 'a=1&b=2', 'URLSearchParams keeps its encoded form');

    instance.destroy();
  });

  // Test 12b: a typed array must not be expanded byte-by-byte into JSON
  test('Typed arrays are summarized rather than expanded per byte', () => {
    const instance = new VConsoleRemote({ autoConnect: false });

    const megabyte = new Uint8Array(1024 * 1024);
    const described = instance._describeRequestBody(megabyte);

    assert.ok(described.includes('1.0 MB'), `Size must be reported, got: ${described}`);
    assert.ok(described.length < 200, `Description must stay small, got ${described.length} chars`);
    assert.ok(!described.includes('"0":0'), 'Must not serialize individual bytes');

    instance.destroy();
  });

  // Test 12c: oversized bodies are capped
  test('Large bodies are truncated to the capture limit', () => {
    const instance = new VConsoleRemote({ autoConnect: false, maxBodyBytes: 1024 });

    const huge = 'x'.repeat(500 * 1024);
    const captured = instance._describeRequestBody(huge);

    assert.ok(captured.length < 2048, `Capture must be bounded, got ${captured.length} chars`);
    assert.ok(/truncated/.test(captured), 'Must say it was truncated');
    assert.ok(/500\.0 KB/.test(captured), `Must report the original size, got tail: ${captured.slice(-80)}`);

    instance.destroy();
  });

  // Test 12d: a base64 data URI becomes a summary instead of megabytes
  test('Oversized data URIs are summarized, not transmitted', () => {
    const instance = new VConsoleRemote({ autoConnect: false, maxBodyBytes: 1024 });

    const dataUri = 'data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024);
    const captured = instance._describeRequestBody(dataUri);

    assert.ok(captured.startsWith('[data URI: image/png'), `Type must be reported, got: ${captured.slice(0, 60)}`);
    assert.ok(/MB/.test(captured), 'Size must be reported');
    assert.ok(!captured.includes('AAAA'), 'Payload itself must not be carried');

    instance.destroy();
  });

  // Test 12e: binary and oversized responses are summarized from headers alone
  test('Binary and oversized responses are not pulled into memory', () => {
    const instance = new VConsoleRemote({ autoConnect: false, maxBodyBytes: 1024 });

    const image = instance._summarizeResponseBody({ 'content-type': 'image/png', 'content-length': '204800' });
    assert.ok(image && image.includes('Binary response') && image.includes('image/png'), `got: ${image}`);

    const large = instance._summarizeResponseBody({ 'content-type': 'application/json', 'content-length': '999999' });
    assert.ok(large && /exceeds/.test(large), `Oversized JSON must be skipped, got: ${large}`);

    const normal = instance._summarizeResponseBody({ 'content-type': 'application/json', 'content-length': '512' });
    assert.strictEqual(normal, null, 'Small JSON responses are read normally');

    instance.destroy();
  });

  // Test 12f: a real multipart upload through patched fetch
  await testAsync('A file upload through fetch is captured with file details', async () => {
    global.window.fetch = async () => ({
      status: 201,
      headers: { forEach: (cb) => { cb('application/json', 'content-type'); } },
      clone: () => ({ text: async () => '{"ok":true}' })
    });

    const instance = new VConsoleRemote({ autoConnect: true });
    const ws = instance.ws;

    const fd = new FormData();
    fd.append('avatar', new File([new Uint8Array(4096)], 'avatar.webp', { type: 'image/webp' }));

    await window.fetch('/api/upload', { method: 'POST', body: fd });
    await new Promise(r => setTimeout(r, 30));

    const cached = [...instance._networkCache.values()].find(r => r.url.includes('/api/upload'));
    assert.ok(cached, 'Upload must be captured');
    assert.ok(cached.requestBody.includes('avatar.webp'), `File name expected, got: ${cached.requestBody}`);
    assert.ok(cached.requestBody.includes('4.0 KB'), `File size expected, got: ${cached.requestBody}`);
    assert.notStrictEqual(cached.requestBody, '{}', 'Must not degrade to an empty object');

    instance.destroy();
  });

  // Test 13: ESM bundle export verification
  await testAsync('ESM bundle exports VConsoleRemote', async () => {
    const esmModule = await import('../dist/vconsole-remote.esm.js');
    assert.strictEqual(typeof esmModule.default, 'function', 'ESM must export VConsoleRemote class as default');
    const instance = new esmModule.default({ server: 'http://localhost:8080', autoConnect: false });
    assert.ok(instance instanceof esmModule.default);
    instance.destroy();
  });

  // Test 14: Comprehensive Device Telemetry Collection (_collectTelemetry)
  await testAsync('Comprehensive device telemetry collection gathers metrics and features', async () => {
    // Setup mock navigator environment with connection and battery
    const origNav = global.window.navigator;
    global.window.navigator = {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      onLine: true,
      platform: 'iPhone',
      hardwareConcurrency: 6,
      deviceMemory: 4,
      connection: {
        effectiveType: '4g',
        downlink: 10,
        rtt: 50
      },
      getBattery: async () => ({
        level: 0.85,
        charging: false
      })
    };

    const origScreen = global.window.screen;
    global.window.screen = {
      width: 393,
      height: 852,
      colorDepth: 24
    };
    global.window.devicePixelRatio = 3;
    global.window.innerWidth = 393;
    global.window.innerHeight = 750;

    const instance = new VConsoleRemote({ autoConnect: false });
    const telemetry = await instance._collectTelemetry();

    // Verify OS
    assert.strictEqual(telemetry.os.name, 'iOS');
    assert.strictEqual(telemetry.os.version, '17.4');

    // Verify Browser
    assert.strictEqual(telemetry.browser.name, 'Safari');
    assert.strictEqual(telemetry.browser.version, '17.4');
    assert.strictEqual(telemetry.browser.engine, 'WebKit');

    // Verify Screen
    assert.strictEqual(telemetry.screen.width, 393);
    assert.strictEqual(telemetry.screen.height, 852);
    assert.strictEqual(telemetry.screen.dpr, 3);
    assert.strictEqual(telemetry.screen.colorDepth, 24);

    // Verify Viewport
    assert.strictEqual(telemetry.viewport.width, 393);
    assert.strictEqual(telemetry.viewport.height, 750);

    // Verify Network
    assert.strictEqual(telemetry.network.effectiveType, '4g');
    assert.strictEqual(telemetry.network.downlink, 10);
    assert.strictEqual(telemetry.network.rtt, 50);
    assert.strictEqual(telemetry.network.online, true);

    // Verify Battery
    assert.strictEqual(telemetry.battery.supported, true);
    assert.strictEqual(telemetry.battery.level, 85);
    assert.strictEqual(telemetry.battery.charging, false);

    // Verify Hardware
    assert.strictEqual(telemetry.hardware.concurrency, 6);
    assert.strictEqual(telemetry.hardware.memory, 4);
    assert.strictEqual(telemetry.hardware.platform, 'iPhone');

    // Verify Features
    assert.strictEqual(typeof telemetry.features, 'object');
    assert.strictEqual(telemetry.features.localStorage, true);
    assert.strictEqual(telemetry.features.sessionStorage, true);
    assert.strictEqual(telemetry.features.websocket, true);
    assert.strictEqual(typeof telemetry.features.webgl, 'boolean');
    assert.strictEqual(typeof telemetry.features.webrtc, 'boolean');
    assert.strictEqual(typeof telemetry.features.indexedDB, 'boolean');
    assert.strictEqual(typeof telemetry.features.serviceWorker, 'boolean');
    assert.strictEqual(typeof telemetry.features.cookie, 'boolean');

    // Verify Timestamp
    assert.strictEqual(typeof telemetry.timestamp, 'number');
    assert.ok(telemetry.timestamp > 0);

    instance.destroy();
    global.window.navigator = origNav;
    global.window.screen = origScreen;
  });

  // Test 15: Safe fallbacks in non-supporting / older browsers & headless environments
  await testAsync('Telemetry collection provides safe fallbacks when APIs are unavailable or throw', async () => {
    const origNav = global.window.navigator;
    // Simulate iOS Safari or older WebView where getBattery and connection are missing, and battery throws
    global.window.navigator = {
      userAgent: '',
      onLine: false,
      getBattery: () => Promise.reject(new Error('Permission denied'))
    };

    const origScreen = global.window.screen;
    delete global.window.screen;

    const instance = new VConsoleRemote({ autoConnect: false });
    const telemetry = await instance._collectTelemetry();

    // Fallbacks must be populated without crashing
    assert.strictEqual(telemetry.os.name, 'Unknown');
    assert.strictEqual(telemetry.os.version, '');
    assert.strictEqual(telemetry.browser.name, 'Unknown');
    assert.strictEqual(telemetry.browser.engine, 'Unknown');

    assert.strictEqual(telemetry.screen.width, 0);
    assert.strictEqual(telemetry.screen.height, 0);
    assert.strictEqual(telemetry.screen.colorDepth, 24);

    assert.strictEqual(telemetry.network.online, false);
    assert.strictEqual(telemetry.network.effectiveType, 'unknown');
    assert.strictEqual(telemetry.network.downlink, null);
    assert.strictEqual(telemetry.network.rtt, null);

    assert.strictEqual(telemetry.battery.supported, false);
    assert.strictEqual(telemetry.battery.level, null);
    assert.strictEqual(telemetry.battery.charging, null);

    assert.strictEqual(telemetry.hardware.concurrency, null);
    assert.strictEqual(telemetry.hardware.memory, null);
    assert.strictEqual(telemetry.hardware.platform, '');

    instance.destroy();
    global.window.navigator = origNav;
    global.window.screen = origScreen;
  });

  // Test 16: User-Agent OS and Browser Regex Matrix
  test('UserAgent parsing handles Android Chrome, macOS Firefox, Windows Edge, Linux, and WeChat', () => {
    const instance = new VConsoleRemote({ autoConnect: false });

    // Android Chrome
    const androidUa = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.94 Mobile Safari/537.36';
    const androidParsed = instance._parseUserAgent(androidUa);
    assert.strictEqual(androidParsed.os.name, 'Android');
    assert.strictEqual(androidParsed.os.version, '14');
    assert.strictEqual(androidParsed.browser.name, 'Chrome');
    assert.strictEqual(androidParsed.browser.version, '122.0.6261.94');
    assert.strictEqual(androidParsed.browser.engine, 'Blink');

    // macOS Firefox
    const macUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.3; rv:123.0) Gecko/20100101 Firefox/123.0';
    const macParsed = instance._parseUserAgent(macUa);
    assert.strictEqual(macParsed.os.name, 'macOS');
    assert.strictEqual(macParsed.os.version, '14.3');
    assert.strictEqual(macParsed.browser.name, 'Firefox');
    assert.strictEqual(macParsed.browser.version, '123.0');
    assert.strictEqual(macParsed.browser.engine, 'Gecko');

    // Windows Edge
    const winUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.2365.92';
    const winParsed = instance._parseUserAgent(winUa);
    assert.strictEqual(winParsed.os.name, 'Windows');
    assert.strictEqual(winParsed.os.version, '10.0');
    assert.strictEqual(winParsed.browser.name, 'Edge');
    assert.strictEqual(winParsed.browser.version, '122.0.2365.92');
    assert.strictEqual(winParsed.browser.engine, 'Blink');

    // WeChat
    const wechatUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Mobile/15E148 MicroMessenger/8.0.47';
    const wechatParsed = instance._parseUserAgent(wechatUa);
    assert.strictEqual(wechatParsed.os.name, 'iOS');
    assert.strictEqual(wechatParsed.browser.name, 'WeChat');
    assert.strictEqual(wechatParsed.browser.version, '8.0.47');

    instance.destroy();
  });

  // Test 17: End-to-end latency responder (device_ping -> device_pong)
  test('Inbound device_ping responds immediately with device_pong and echoes timestamp', () => {
    const instance = new VConsoleRemote({ autoConnect: true });
    const ws = instance.ws;

    const pingTimestamp = 1726473600123;
    ws.simulateReceive({
      type: 'device_ping',
      timestamp: pingTimestamp
    });

    const pong = ws.sentMessages.find(m => m.type === 'device_pong');
    assert.ok(pong, 'device_pong message must be sent in response to device_ping');
    assert.strictEqual(pong.timestamp, pingTimestamp, 'device_pong must echo the exact ping timestamp');

    instance.destroy();
  });

  // Test 18: Inbound pull handlers (pull_device_info, pull_system)
  await testAsync('Inbound pull_device_info and pull_system dispatch device_telemetry', async () => {
    const instance = new VConsoleRemote({ autoConnect: true });
    const ws = instance.ws;

    // Simulate pull_device_info
    ws.sentMessages = [];
    ws.simulateReceive({ type: 'pull_device_info' });
    await new Promise(r => setTimeout(r, 20));

    let telemetryMsg = ws.sentMessages.find(m => m.type === 'device_telemetry');
    assert.ok(telemetryMsg, 'device_telemetry must be sent in response to pull_device_info');
    assert.ok(telemetryMsg.data && telemetryMsg.data.os, 'telemetry payload must contain os data');

    // Simulate pull_system
    ws.sentMessages = [];
    ws.simulateReceive({ type: 'pull_system' });
    await new Promise(r => setTimeout(r, 20));

    telemetryMsg = ws.sentMessages.find(m => m.type === 'device_telemetry');
    assert.ok(telemetryMsg, 'device_telemetry must be sent in response to pull_system');

    instance.destroy();
  });

  // Test 19: Automatic telemetry transmission on dev_connected and room initialization (init)
  await testAsync('Automatically sends device_telemetry when dev_connected or room init arrives', async () => {
    const instance = new VConsoleRemote({ autoConnect: true });
    const ws = instance.ws;

    // Test on init / room_pin
    ws.sentMessages = [];
    ws.simulateReceive({ type: 'init', pin: '888999', key: 'testkey' });
    await new Promise(r => setTimeout(r, 20));

    let msg = ws.sentMessages.find(m => m.type === 'device_telemetry');
    assert.ok(msg, 'device_telemetry must be sent when room initializes with init');

    // Test on dev_connected
    ws.sentMessages = [];
    ws.simulateReceive({ type: 'dev_connected' });
    await new Promise(r => setTimeout(r, 20));

    msg = ws.sentMessages.find(m => m.type === 'device_telemetry');
    assert.ok(msg, 'device_telemetry must be sent when dev_connected arrives');

    instance.destroy();
  });

  // Test 20: Debounced window resize / orientationchange listener and cleanup in destroy()
  await testAsync('Window resize is debounced at 250ms and listeners are removed on destroy()', async () => {
    const instance = new VConsoleRemote({ autoConnect: true });
    const ws = instance.ws;

    // Verify listeners are registered in window._listeners
    assert.ok(global.window._listeners && global.window._listeners['resize'] && global.window._listeners['resize'].length >= 1, 'Resize listener must be registered');
    assert.ok(global.window._listeners && global.window._listeners['orientationchange'] && global.window._listeners['orientationchange'].length >= 1, 'Orientationchange listener must be registered');

    // Trigger multiple resize events rapidly within 100ms
    ws.sentMessages = [];
    global.window.dispatchEvent({ type: 'resize' });
    await new Promise(r => setTimeout(r, 50));
    global.window.dispatchEvent({ type: 'resize' });
    await new Promise(r => setTimeout(r, 50));
    global.window.dispatchEvent({ type: 'resize' });

    // Before 250ms has passed from the last trigger, no telemetry should be dispatched yet
    let dispatched = ws.sentMessages.filter(m => m.type === 'device_telemetry');
    assert.strictEqual(dispatched.length, 0, 'Must be debounced before 250ms window elapses');

    // Wait until 250ms debounce window passes
    await new Promise(r => setTimeout(r, 270));
    dispatched = ws.sentMessages.filter(m => m.type === 'device_telemetry');
    assert.strictEqual(dispatched.length, 1, 'Exactly one debounced device_telemetry dispatch must occur');

    // Now test cleanup on destroy()
    const resizeCountBefore = global.window._listeners['resize'].length;
    instance.destroy();
    const resizeCountAfter = (global.window._listeners['resize'] || []).length;
    assert.strictEqual(resizeCountAfter, resizeCountBefore - 1, 'Resize listener must be removed on destroy()');

    // Also assert that after destruction, dispatching resize does nothing
    ws.sentMessages = [];
    global.window.dispatchEvent({ type: 'resize' });
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(ws.sentMessages.length, 0, 'No messages sent after destroy()');
  });

  // Test 21: VULN-01 Resilience against throwing window.navigator getter
  await testAsync('Resilient to throwing window.navigator getter in _getNavigator and sendTelemetry', async () => {
    const origNav = global.window.navigator;
    const origGlobalNav = global.navigator;
    try {
      Object.defineProperty(global.window, 'navigator', {
        get() {
          throw new Error('SecurityError: Access to navigator is forbidden');
        },
        configurable: true
      });
      if (typeof global.navigator !== 'undefined') {
        Object.defineProperty(global, 'navigator', {
          get() {
            throw new Error('SecurityError: Access to navigator is forbidden');
          },
          configurable: true
        });
      }

      const instance = new VConsoleRemote({ autoConnect: false });
      assert.strictEqual(instance._getNavigator(), null, '_getNavigator must return null when navigator getter throws');

      // sendTelemetry must not throw synchronously and should resolve safely
      let result = null;
      assert.doesNotThrow(() => {
        const p = instance.sendTelemetry();
        assert.ok(p && typeof p.then === 'function', 'sendTelemetry must return a promise');
      });
      result = await instance.sendTelemetry();
      assert.ok(result !== undefined, 'sendTelemetry should resolve safely');
      instance.destroy();
    } finally {
      Object.defineProperty(global.window, 'navigator', { value: origNav, writable: true, configurable: true });
      if (typeof origGlobalNav !== 'undefined') {
        Object.defineProperty(global, 'navigator', { value: origGlobalNav, writable: true, configurable: true });
      }
    }
  });

  // Test 22: VULN-02 Resilience against throwing nav.userAgent getter
  await testAsync('Resilient to throwing nav.userAgent getter in _collectTelemetry and sendTelemetry', async () => {
    const origNav = global.window.navigator;
    try {
      const throwingNav = {
        onLine: true,
        getBattery: async () => ({ level: 0.5, charging: true })
      };
      Object.defineProperty(throwingNav, 'userAgent', {
        get() {
          throw new Error('SecurityError: Blocked userAgent access');
        },
        configurable: true
      });
      Object.defineProperty(global.window, 'navigator', { value: throwingNav, writable: true, configurable: true });

      const instance = new VConsoleRemote({ autoConnect: false });
      let telemetry = null;
      await assert.doesNotReject(async () => {
        telemetry = await instance._collectTelemetry();
      }, 'Collecting telemetry must not reject when userAgent throws');
      assert.ok(telemetry, 'Telemetry object must still be produced');
      assert.strictEqual(telemetry.os.name, 'Unknown');

      let sendRes = null;
      await assert.doesNotReject(async () => {
        sendRes = await instance.sendTelemetry();
      }, 'sendTelemetry must safely resolve when userAgent throws');
      assert.ok(sendRes, 'sendTelemetry returns collected telemetry');

      instance.destroy();
    } finally {
      Object.defineProperty(global.window, 'navigator', { value: origNav, writable: true, configurable: true });
    }
  });

  // Test 23: VULN-03 Resilience against non-string data.type in handleMessage
  test('Resilient to non-string data.type in handleMessage without throwing TypeError', () => {
    const instance = new VConsoleRemote({ autoConnect: true });
    const nonStringTypes = [12345, true, false, {}, [], null, undefined, 0, -1, 3.14];

    for (const badType of nonStringTypes) {
      assert.doesNotThrow(() => {
        instance.handleMessage({ type: badType });
      }, `handleMessage must not throw for non-string type: ${typeof badType}`);
    }

    assert.doesNotThrow(() => {
      instance.handleMessage(null);
      instance.handleMessage(undefined);
      instance.handleMessage("not-an-object");
    }, 'handleMessage must safely ignore non-object values');

    instance.destroy();
  });

  console.log(`\n=== Test Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
