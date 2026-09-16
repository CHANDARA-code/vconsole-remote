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
global.window = {
  location: { origin: 'http://localhost:3000' },
  innerWidth: 375,
  innerHeight: 667,
  document: mockDocument,
  localStorage: new MockStorage(),
  sessionStorage: new MockStorage(),
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
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

  console.log(`\n=== Test Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
