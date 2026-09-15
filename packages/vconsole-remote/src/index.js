import VConsole from 'vconsole';
import QRCode from 'qrcode';

/**
 * vConsole Remote - Lightweight remote debugging tool built on top of vConsole
 */
class VConsoleRemote {
  constructor(options = {}) {
    this.options = {
      server: options.server || 'http://localhost:8080',
      theme: options.theme || 'dark',
      autoConnect: options.autoConnect !== false,
      ...options
    };

    const { serverOrigin, wsUrl } = this._parseServerUrls(this.options.server);
    this.serverOrigin = serverOrigin;
    this.wsUrl = wsUrl;

    this.vConsole = null;
    this.ws = null;
    this.roomPin = null;
    this.remoteTab = null;
    this._tabContainer = null;
    this._qrCanvas = null;

    // Offline message buffer & request body cache
    this._queue = [];
    this._networkCache = new Map();
    this._maxNetworkCache = 100;
    this._maxQueueSize = 200;

    // Flags & timers
    this._isLogging = false;
    this._destroyed = false;
    this._reconnectTimer = null;

    // Preserved native globals
    this._originalConsole = null;
    this._originalFetch = null;
    this._originalXHROpen = null;
    this._originalXHRSend = null;
    this._originalXHRSetRequestHeader = null;

    // Initialize SDK
    this.init();
  }

  /**
   * Parse server URL into HTTP(S) server origin and WS(S) endpoint URL
   */
  _parseServerUrls(input) {
    let serverStr = (input || 'http://localhost:8080').trim();

    if (!/^https?:\/\//i.test(serverStr) && !/^wss?:\/\//i.test(serverStr)) {
      serverStr = 'http://' + serverStr;
    }

    const isSecure = /^https:\/\//i.test(serverStr) || /^wss:\/\//i.test(serverStr);
    const httpProto = isSecure ? 'https:' : 'http:';
    const wsProto = isSecure ? 'wss:' : 'ws:';

    const hostAndPath = serverStr.replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '');
    const host = hostAndPath.split('/')[0];

    const serverOrigin = `${httpProto}//${host}`;
    const wsUrl = `${wsProto}//${host}/ws?type=device`;

    return { serverOrigin, wsUrl };
  }

  /**
   * Initialize interceptors, vConsole plugin, and WebSocket connection
   */
  init() {
    // 1. Monkey-patch console, fetch, and XMLHttpRequest immediately
    this._patchConsole();
    this._patchFetch();
    this._patchXHR();

    // 2. Initialize vConsole instance if needed
    if (typeof window !== 'undefined') {
      if (!window.vConsole && typeof VConsole === 'function') {
        try {
          this.vConsole = new VConsole({
            theme: this.options.theme
          });
        } catch (_) {}
      } else {
        this.vConsole = window.vConsole || null;
      }
    }

    // 3. Register custom Remote tab plugin
    this._initVConsolePlugin();

    // 4. Auto-connect WebSocket if enabled
    if (this.options.autoConnect) {
      this.connect();
    }
  }

  /**
   * Monkey-patch window.console (log, info, warn, error, debug)
   */
  _patchConsole() {
    if (typeof window === 'undefined' || !window.console) return;

    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    this._originalConsole = {};

    for (const method of methods) {
      if (typeof window.console[method] === 'function') {
        this._originalConsole[method] = window.console[method].bind(window.console);

        window.console[method] = (...args) => {
          // Always invoke native console first
          this._originalConsole[method](...args);

          // Prevent infinite recursion from internal logging
          if (this._isLogging) return;
          this._isLogging = true;

          try {
            const serializedArgs = this._serializeArgs(args);
            const logPayload = {
              type: 'console',
              level: method,
              args: serializedArgs,
              message: this._formatArgs(args),
              timestamp: Date.now()
            };
            this._send(logPayload);
          } catch (_) {
            // Ignore serialization errors
          } finally {
            this._isLogging = false;
          }
        };
      }
    }
  }

  /**
   * Serialize arguments safely, resolving circular references, Errors, and DOM nodes
   */
  _serializeArgs(args) {
    return args.map(arg => this._safeSerialize(arg));
  }

  _safeSerialize(arg, depth = 0, seen = new WeakSet()) {
    if (arg === null) return null;
    if (arg === undefined) return 'undefined';
    if (typeof arg === 'number' || typeof arg === 'boolean' || typeof arg === 'string') {
      return arg;
    }
    if (typeof arg === 'bigint') {
      return arg.toString() + 'n';
    }
    if (typeof arg === 'symbol') {
      return arg.toString();
    }
    if (typeof arg === 'function') {
      return `[Function: ${arg.name || 'anonymous'}]`;
    }
    if (arg instanceof Error) {
      return {
        name: arg.name,
        message: arg.message,
        stack: arg.stack
      };
    }
    if (arg && typeof arg === 'object' && typeof arg.nodeType === 'number') {
      if (arg.nodeType === 1) {
        const tagName = (arg.tagName || arg.nodeName || 'element').toLowerCase();
        let attrStr = '';
        if (arg.attributes) {
          attrStr = Array.from(arg.attributes || [])
            .map(a => `${a.name}="${a.value}"`)
            .join(' ');
        }
        return `<${tagName}${attrStr ? ' ' + attrStr : ''}>`;
      }
      return `[Node: ${arg.nodeName || arg.nodeType}]`;
    }
    if (depth > 6) {
      return '[Object (max depth)]';
    }
    if (typeof arg === 'object') {
      if (seen.has(arg)) {
        return '[Circular]';
      }
      seen.add(arg);
      try {
        if (Array.isArray(arg)) {
          return arg.map(item => this._safeSerialize(item, depth + 1, seen));
        }
        const obj = {};
        for (const key of Object.keys(arg)) {
          obj[key] = this._safeSerialize(arg[key], depth + 1, seen);
        }
        return obj;
      } catch (_) {
        return String(arg);
      }
    }
    return String(arg);
  }

  _formatArgs(args) {
    try {
      return args
        .map(a => {
          if (typeof a === 'string') return a;
          if (typeof a === 'object' && a !== null) {
            try {
              return JSON.stringify(this._safeSerialize(a));
            } catch (_) {
              return String(a);
            }
          }
          return String(a);
        })
        .join(' ');
    } catch (_) {
      return '';
    }
  }

  /**
   * Monkey-patch window.fetch
   */
  _patchFetch() {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;

    const originalFetch = window.fetch.bind(window);
    this._originalFetch = originalFetch;

    window.fetch = async (...args) => {
      const startTime = Date.now();
      const requestId = 'fetch_' + startTime + '_' + Math.random().toString(36).substr(2, 6);

      const input = args[0];
      const init = args[1] || {};

      let url = '';
      let method = 'GET';
      let requestBody = null;
      let requestHeaders = {};

      if (typeof input === 'string') {
        url = input;
      } else if (input && typeof input === 'object') {
        url = input.url || String(input);
        if (input.method) method = input.method;
        if (input.headers) {
          try {
            if (typeof input.headers.forEach === 'function') {
              input.headers.forEach((v, k) => { requestHeaders[k] = v; });
            } else {
              requestHeaders = { ...input.headers };
            }
          } catch (_) {}
        }
      }

      if (init.method) method = init.method.toUpperCase();
      if (init.body) {
        try {
          requestBody = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
        } catch (_) {
          requestBody = '[Body]';
        }
      }
      if (init.headers) {
        try {
          if (typeof init.headers.forEach === 'function') {
            init.headers.forEach((v, k) => { requestHeaders[k] = v; });
          } else {
            requestHeaders = { ...requestHeaders, ...init.headers };
          }
        } catch (_) {}
      }

      try {
        const response = await originalFetch(...args);
        const duration = Date.now() - startTime;
        const status = response.status;

        // Clone response to read body text for on-demand inspection
        let responseHeaders = {};
        try {
          if (response.headers && typeof response.headers.forEach === 'function') {
            response.headers.forEach((v, k) => { responseHeaders[k] = v; });
          }
        } catch (_) {}

        try {
          const clone = response.clone();
          clone.text().then(text => {
            this._storeNetworkRequest(requestId, {
              id: requestId,
              method,
              url,
              status,
              duration,
              requestHeaders,
              responseHeaders,
              requestBody,
              responseBody: text,
              timestamp: startTime
            });
          }).catch(() => {
            this._storeNetworkRequest(requestId, {
              id: requestId,
              method,
              url,
              status,
              duration,
              requestHeaders,
              responseHeaders,
              requestBody,
              responseBody: '[Binary/Opaque Response]',
              timestamp: startTime
            });
          });
        } catch (_) {
          this._storeNetworkRequest(requestId, {
            id: requestId,
            method,
            url,
            status,
            duration,
            requestHeaders,
            responseHeaders,
            requestBody,
            responseBody: '[Cannot clone response]',
            timestamp: startTime
          });
        }

        // Emit network metadata push event
        this._send({
          type: 'network',
          request: {
            id: requestId,
            method,
            url,
            status,
            duration,
            timestamp: startTime
          }
        });

        return response;
      } catch (err) {
        const duration = Date.now() - startTime;
        this._storeNetworkRequest(requestId, {
          id: requestId,
          method,
          url,
          status: 0,
          duration,
          requestHeaders,
          responseHeaders: {},
          requestBody,
          responseBody: err.message || 'Network Request Failed',
          timestamp: startTime
        });

        this._send({
          type: 'network',
          request: {
            id: requestId,
            method,
            url,
            status: 0,
            duration,
            timestamp: startTime,
            error: err.message
          }
        });

        throw err;
      }
    };
  }

  /**
   * Monkey-patch XMLHttpRequest
   */
  _patchXHR() {
    if (typeof window === 'undefined' || typeof window.XMLHttpRequest === 'undefined') return;

    const self = this;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    this._originalXHROpen = originalOpen;
    this._originalXHRSend = originalSend;
    this._originalXHRSetRequestHeader = originalSetRequestHeader;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this._vr_id = 'xhr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      this._vr_method = (method || 'GET').toUpperCase();
      this._vr_url = String(url);
      this._vr_requestHeaders = {};
      return originalOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
      if (this._vr_requestHeaders) {
        this._vr_requestHeaders[header] = value;
      }
      return originalSetRequestHeader.apply(this, [header, value]);
    };

    XMLHttpRequest.prototype.send = function(body) {
      const xhr = this;
      const requestId = xhr._vr_id || ('xhr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6));
      const method = xhr._vr_method || 'GET';
      const url = xhr._vr_url || '';
      const startTime = Date.now();
      let requestBody = null;

      if (body) {
        try {
          requestBody = typeof body === 'string' ? body : JSON.stringify(body);
        } catch (_) {
          requestBody = '[Body]';
        }
      }

      const onComplete = () => {
        if (xhr._vr_handled) return;
        xhr._vr_handled = true;

        const duration = Date.now() - startTime;
        const status = xhr.status || 0;
        let responseBody = '';

        try {
          if (!xhr.responseType || xhr.responseType === 'text') {
            responseBody = xhr.responseText || '';
          } else if (xhr.responseType === 'json') {
            responseBody = JSON.stringify(xhr.response);
          } else {
            responseBody = `[Response type: ${xhr.responseType}]`;
          }
        } catch (_) {
          responseBody = '[Response read error]';
        }

        let responseHeaders = {};
        try {
          const rawHeaders = xhr.getAllResponseHeaders();
          if (rawHeaders) {
            rawHeaders.trim().split(/[\r\n]+/).forEach(line => {
              const parts = line.split(': ');
              const header = parts.shift();
              const value = parts.join(': ');
              if (header) responseHeaders[header.toLowerCase()] = value;
            });
          }
        } catch (_) {}

        self._storeNetworkRequest(requestId, {
          id: requestId,
          method,
          url,
          status,
          duration,
          requestHeaders: xhr._vr_requestHeaders || {},
          responseHeaders,
          requestBody,
          responseBody,
          timestamp: startTime
        });

        self._send({
          type: 'network',
          request: {
            id: requestId,
            method,
            url,
            status,
            duration,
            timestamp: startTime
          }
        });
      };

      xhr.addEventListener('load', onComplete);
      xhr.addEventListener('error', onComplete);
      xhr.addEventListener('abort', onComplete);

      return originalSend.apply(this, [body]);
    };
  }

  /**
   * Store network request data with FIFO eviction
   */
  _storeNetworkRequest(id, data) {
    if (this._networkCache.size >= this._maxNetworkCache) {
      const firstKey = this._networkCache.keys().next().value;
      this._networkCache.delete(firstKey);
    }
    this._networkCache.set(id, data);
  }

  /**
   * Refactor plugin registration using official VConsolePlugin lifecycle hooks
   */
  _initVConsolePlugin() {
    if (!this.vConsole) return;

    // Resolve base plugin class from vConsole instance or static exports
    const BasePluginClass =
      (this.vConsole.constructor && this.vConsole.constructor.VConsolePlugin) ||
      VConsole.VConsolePlugin ||
      (typeof window !== 'undefined' && window.VConsole && window.VConsole.VConsolePlugin) ||
      class {
        constructor(id, name) {
          this.id = id;
          this.name = name;
          this.eventMap = new Map();
        }
        on(event, cb) {
          this.eventMap.set(event, cb);
          return this;
        }
        trigger(event, ...args) {
          const cb = this.eventMap.get(event);
          if (cb) cb(...args);
          return this;
        }
      };

    const self = this;
    class RemotePlugin extends BasePluginClass {
      constructor(id, name) {
        super(id, name);
        this.on('renderTab', (callback) => {
          if (typeof callback === 'function') {
            const content = self._createTabContent();
            callback(content);
          }
        });
        this.on('show', () => {
          if (self.options.autoConnect && (!self.ws || self.ws.readyState === WebSocket.CLOSED)) {
            self.connect();
          }
        });
      }
    }

    const plugin = new RemotePlugin('remote', '📡 Remote');

    if (typeof this.vConsole.addPlugin === 'function') {
      this.vConsole.addPlugin(plugin);
    }
    this.remoteTab = plugin;
  }

  /**
   * Build the Remote tab DOM content with connection status, PIN, and QR canvas
   */
  _createTabContent() {
    const container = document.createElement('div');
    container.className = 'vconsole-remote-tab';
    container.style.padding = '16px';
    container.style.color = '#333';
    container.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    // Status element
    const statusElement = document.createElement('div');
    statusElement.id = 'vconsole-remote-status';
    statusElement.textContent = 'Status: Connecting... 🟡';
    statusElement.style.padding = '10px 14px';
    statusElement.style.marginBottom = '14px';
    statusElement.style.borderRadius = '6px';
    statusElement.style.backgroundColor = '#f5f5f5';
    statusElement.style.textAlign = 'center';
    statusElement.style.fontWeight = '500';
    statusElement.style.fontSize = '14px';
    container.appendChild(statusElement);

    // PIN element
    const pinElement = document.createElement('div');
    pinElement.id = 'vconsole-remote-pin';
    pinElement.style.padding = '14px';
    pinElement.style.marginBottom = '14px';
    pinElement.style.fontWeight = 'bold';
    pinElement.style.fontSize = '30px';
    pinElement.style.letterSpacing = '6px';
    pinElement.style.textAlign = 'center';
    pinElement.style.color = '#07c160';
    pinElement.style.backgroundColor = '#f0f9eb';
    pinElement.style.borderRadius = '8px';
    pinElement.textContent = this.roomPin ? `PIN: ${this._formatPin(this.roomPin)}` : 'PIN: ------';
    container.appendChild(pinElement);

    // QR Canvas container
    const qrWrapper = document.createElement('div');
    qrWrapper.style.display = 'flex';
    qrWrapper.style.flexDirection = 'column';
    qrWrapper.style.alignItems = 'center';
    qrWrapper.style.justifyContent = 'center';
    qrWrapper.style.padding = '12px';
    qrWrapper.style.backgroundColor = '#ffffff';
    qrWrapper.style.borderRadius = '8px';
    qrWrapper.style.margin = '0 auto 12px auto';
    qrWrapper.style.width = '200px';
    qrWrapper.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.08)';

    const qrCanvas = document.createElement('canvas');
    qrCanvas.id = 'vconsole-remote-qr';
    qrCanvas.width = 180;
    qrCanvas.height = 180;
    qrWrapper.appendChild(qrCanvas);

    const qrHint = document.createElement('div');
    qrHint.style.color = '#666';
    qrHint.style.fontSize = '12px';
    qrHint.style.marginTop = '8px';
    qrHint.style.textAlign = 'center';
    qrHint.textContent = 'Scan to pair desktop dashboard';
    qrWrapper.appendChild(qrHint);

    container.appendChild(qrWrapper);

    this._tabContainer = container;
    this._qrCanvas = qrCanvas;

    // Render QR immediately if PIN is already present
    if (this.roomPin) {
      this._renderQrCode(qrCanvas, this.roomPin);
    }

    return container;
  }

  /**
   * Render QR Code to HTMLCanvasElement pointing to server dashboard
   */
  _renderQrCode(canvasElement, pin) {
    const canvas =
      canvasElement ||
      this._qrCanvas ||
      (typeof document !== 'undefined' && document.getElementById('vconsole-remote-qr'));
    if (!canvas || !pin) return;

    const targetUrl = `${this.serverOrigin}/#/room/${pin}`;
    QRCode.toCanvas(canvas, targetUrl, { width: 180, margin: 2 }, (error) => {
      if (error && this._originalConsole && this._originalConsole.error) {
        this._originalConsole.error('[vConsole-Remote] QR Code render error:', error);
      }
    });
  }

  _formatPin(pin) {
    if (!pin) return '';
    const str = String(pin).replace(/\D/g, '');
    if (str.length === 6) {
      return `${str.slice(0, 3)}-${str.slice(3)}`;
    }
    return str;
  }

  /**
   * Update the PIN display and render QR code canvas
   */
  updatePinDisplay() {
    if (!this.roomPin) return;

    if (typeof document !== 'undefined') {
      const pinElement = document.getElementById('vconsole-remote-pin');
      if (pinElement) {
        pinElement.textContent = `PIN: ${this._formatPin(this.roomPin)}`;
      }

      const qrCanvas =
        this._qrCanvas || document.getElementById('vconsole-remote-qr');
      if (qrCanvas) {
        this._renderQrCode(qrCanvas, this.roomPin);
      }
    }
  }

  /**
   * Update connection status label and color
   */
  updateConnectionStatus(status) {
    if (typeof document !== 'undefined') {
      const statusElement = document.getElementById('vconsole-remote-status');
      if (statusElement) {
        statusElement.textContent = `Status: ${status}`;
        statusElement.style.color = this.getConnectionColor(status);
      }
    }
  }

  getConnectionColor(status) {
    if (status.includes('Connected') || status.includes('🟢')) return '#07c160';
    if (status.includes('Waiting') || status.includes('🟡')) return '#fa8c16';
    return '#f5222d';
  }

  /**
   * Connect to the remote WebSocket server (/ws?type=device)
   */
  connect() {
    if (this._destroyed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        this.updateConnectionStatus('Connected to Server 🟢');
        this._flushQueue();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (_) {}
      };

      this.ws.onclose = () => {
        this.updateConnectionStatus('Waiting for Developer 🟡');
        this._scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.updateConnectionStatus('Connection Error 🟥');
      };
    } catch (error) {
      this.updateConnectionStatus('Connection Error 🟥');
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._destroyed || !this.options.autoConnect) return;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this.connect();
    }, 2500);
  }

  /**
   * Safely dispatch message over WebSocket or buffer in offline queue
   */
  _send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (_) {}
    } else {
      if (this._queue.length < this._maxQueueSize) {
        this._queue.push(payload);
      }
    }
  }

  _flushQueue() {
    while (this._queue.length > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg = this._queue.shift();
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (_) {
        break;
      }
    }
  }

  /**
   * Inbound message handler dispatching developer pull requests and REPL eval
   */
  handleMessage(data) {
    if (!data || typeof data !== 'object') return;

    const msgType = (data.type || '').toLowerCase();

    switch (msgType) {
      case 'init':
      case 'room_pin':
        this.roomPin = data.pin || (data.message && data.message.pin) || null;
        this.updatePinDisplay();
        this.updateConnectionStatus('Waiting for Developer 🟡');
        break;

      case 'dev_connected':
      case 'room_connected':
        this.updateConnectionStatus('Developer Connected 🟢');
        break;

      case 'dev_disconnected':
        this.updateConnectionStatus('Waiting for Developer 🟡');
        break;

      case 'pull_network_body':
        this._handlePullNetworkBody(data);
        break;

      case 'pull_storage':
        this._handlePullStorage(data);
        break;

      case 'pull_dom_tree':
        this._handlePullDomTree(data);
        break;

      case 'pull_screenshot':
        this._handlePullScreenshot(data);
        break;

      case 'exec_js':
        this._handleExecJS(data);
        break;

      default:
        break;
    }
  }

  /**
   * Responders: pull_network_body
   */
  _handlePullNetworkBody(data) {
    const reqId = data.requestId || data.id;
    let bodyContent = '';
    let fullRecord = null;

    if (this._networkCache && this._networkCache.has(reqId)) {
      const cached = this._networkCache.get(reqId);
      bodyContent = cached.responseBody || '';
      fullRecord = {
        requestId: reqId,
        method: cached.method,
        url: cached.url,
        status: cached.status,
        duration: cached.duration,
        requestHeaders: cached.requestHeaders,
        responseHeaders: cached.responseHeaders,
        requestBody: cached.requestBody,
        response: cached.responseBody,
        body: cached.responseBody
      };
    } else {
      bodyContent = 'Request body not found or expired';
      fullRecord = { requestId: reqId, body: bodyContent, error: 'Not found' };
    }

    this._send({
      type: 'network_body_data',
      requestId: reqId,
      body: bodyContent,
      data: fullRecord
    });
  }

  /**
   * Responders: pull_storage
   */
  _handlePullStorage(data) {
    const lsMap = {};
    const ssMap = {};
    let cookiesStr = '';

    try {
      if (typeof localStorage !== 'undefined') {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          lsMap[key] = localStorage.getItem(key);
        }
      }
    } catch (_) {}

    try {
      if (typeof sessionStorage !== 'undefined') {
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          ssMap[key] = sessionStorage.getItem(key);
        }
      }
    } catch (_) {}

    try {
      if (typeof document !== 'undefined') {
        cookiesStr = document.cookie || '';
      }
    } catch (_) {}

    const storagePayload = {
      type: 'storage_data',
      data: {
        localStorage: lsMap,
        sessionStorage: ssMap,
        cookies: cookiesStr
      },
      storage: {
        localStorage: Object.keys(lsMap).map(k => ({ key: k, value: lsMap[k] })),
        sessionStorage: Object.keys(ssMap).map(k => ({ key: k, value: ssMap[k] })),
        cookies: cookiesStr ? cookiesStr.split('; ').filter(Boolean).map(c => {
          const idx = c.indexOf('=');
          return idx > -1 ? { key: c.slice(0, idx), value: c.slice(idx + 1) } : { key: c, value: '' };
        }) : []
      }
    };

    this._send(storagePayload);
  }

  /**
   * Responders: pull_dom_tree
   */
  _handlePullDomTree(data) {
    let domHierarchy = null;
    if (typeof document !== 'undefined' && document.documentElement) {
      domHierarchy = this._serializeNode(document.documentElement, 0, 12);
    }
    if (!domHierarchy) {
      domHierarchy = { tagName: 'HTML', children: [] };
    }

    this._send({
      type: 'dom_tree_data',
      data: domHierarchy,
      tree: domHierarchy
    });
  }

  _serializeNode(node, depth = 0, maxDepth = 12) {
    if (!node) return null;
    if (depth > maxDepth) {
      return { tagName: node.tagName || node.nodeName || '...', children: [] };
    }

    if (node.nodeType === 1) {
      const tagName = node.tagName;
      const attributes = [];

      if (node.attributes) {
        for (let i = 0; i < node.attributes.length; i++) {
          const attr = node.attributes[i];
          attributes.push({ name: attr.name, value: attr.value });
        }
      }

      const item = {
        tagName: tagName,
        id: node.id || '',
        className: node.className || '',
        attributes: attributes,
        children: []
      };

      if (tagName === 'SCRIPT' || tagName === 'STYLE') {
        return item;
      }

      const childNodes = node.childNodes;
      if (childNodes) {
        for (let i = 0; i < childNodes.length; i++) {
          const child = childNodes[i];
          if (child.nodeType === 1) {
            const childItem = this._serializeNode(child, depth + 1, maxDepth);
            if (childItem) item.children.push(childItem);
          } else if (child.nodeType === 3) {
            const text = (child.textContent || '').trim();
            if (text) {
              item.textContent = (item.textContent ? item.textContent + ' ' : '') + text;
            }
          }
        }
      }

      return item;
    }

    return null;
  }

  /**
   * Responders: pull_screenshot
   */
  _handlePullScreenshot(data) {
    const sendScreenshotResponse = (dataUrl) => {
      this._send({
        type: 'screenshot_data',
        data: dataUrl,
        screenshot: { data: (dataUrl || '').replace(/^data:image\/[a-z]+;base64,/, '') }
      });
    };

    if (typeof window !== 'undefined' && window.html2canvas) {
      try {
        const root = document.body || document.documentElement;
        window.html2canvas(root).then(canvas => {
          sendScreenshotResponse(canvas.toDataURL('image/png'));
        }).catch(() => {
          sendScreenshotResponse(this._generateFallbackScreenshot());
        });
        return;
      } catch (_) {}
    }

    sendScreenshotResponse(this._generateFallbackScreenshot());
  }

  _generateFallbackScreenshot() {
    if (typeof document === 'undefined') return 'data:image/png;base64,';

    try {
      const canvas = document.createElement('canvas');
      const width = (typeof window !== 'undefined' && window.innerWidth) || 375;
      const height = (typeof window !== 'undefined' && window.innerHeight) || 667;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#1e1e1e';
        ctx.fillRect(0, 0, width, height);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 20px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('vConsole Remote Snapshot', width / 2, 80);

        ctx.font = '14px monospace';
        ctx.fillStyle = '#aaaaaa';
        ctx.fillText(`PIN: ${this.roomPin || 'N/A'}`, width / 2, 120);
        ctx.fillText(new Date().toLocaleString(), width / 2, 150);
        ctx.fillText(`Viewport: ${width}x${height}`, width / 2, 180);
        if (typeof document !== 'undefined' && document.title) {
          ctx.fillText(`Title: ${document.title}`, width / 2, 210);
        }
      }
      return canvas.toDataURL('image/png');
    } catch (_) {
      return 'data:image/png;base64,';
    }
  }

  /**
   * Responders: exec_js remote REPL evaluation
   */
  _handleExecJS(data) {
    const code = data.code || '';

    try {
      // Indirect eval evaluates in global scope
      const evalResult = (0, eval)(code);

      if (evalResult && typeof evalResult.then === 'function') {
        evalResult
          .then(res => {
            const outStr = this._stringifyResult(res);
            this._send({
              type: 'exec_result',
              result: outStr,
              output: outStr,
              isError: false
            });
          })
          .catch(err => {
            const errMsg = err ? (err.message || String(err)) : 'Promise rejected';
            this._send({
              type: 'exec_result',
              error: errMsg,
              output: errMsg,
              isError: true
            });
          });
      } else {
        const outStr = this._stringifyResult(evalResult);
        this._send({
          type: 'exec_result',
          result: outStr,
          output: outStr,
          isError: false
        });
      }
    } catch (err) {
      const errMsg = err ? (err.message || String(err)) : 'Execution error';
      this._send({
        type: 'exec_result',
        error: errMsg,
        output: errMsg,
        isError: true
      });
    }
  }

  _stringifyResult(val) {
    if (typeof val === 'undefined') return 'undefined';
    if (val === null) return 'null';
    if (typeof val === 'object') {
      try {
        return JSON.stringify(val);
      } catch (_) {
        return String(val);
      }
    }
    return String(val);
  }

  /**
   * Legacy manual emission methods for backward compatibility
   */
  sendLog(level, message) {
    this._send({
      type: 'console',
      level,
      args: [message],
      message: String(message),
      timestamp: Date.now()
    });
  }

  sendNetworkRequest(request) {
    this._send({
      type: 'network',
      request,
      timestamp: Date.now()
    });
  }

  sendDomTree(tree) {
    this._send({
      type: 'dom_tree_data',
      data: tree,
      tree,
      timestamp: Date.now()
    });
  }

  sendStorage(storage) {
    this._send({
      type: 'storage_data',
      data: storage,
      storage,
      timestamp: Date.now()
    });
  }

  sendScreenshot(screenshot) {
    this._send({
      type: 'screenshot_data',
      data: screenshot,
      screenshot: { data: screenshot },
      timestamp: Date.now()
    });
  }

  executeJS(code) {
    this._send({
      type: 'exec_js',
      code,
      timestamp: Date.now()
    });
  }

  pullNetworkBody(requestId) {
    this._send({
      type: 'pull_network_body',
      requestId,
      timestamp: Date.now()
    });
  }

  pullStorage() {
    this._send({
      type: 'pull_storage',
      timestamp: Date.now()
    });
  }

  pullDomTree() {
    this._send({
      type: 'pull_dom_tree',
      timestamp: Date.now()
    });
  }

  pullScreenshot() {
    this._send({
      type: 'pull_screenshot',
      timestamp: Date.now()
    });
  }

  /**
   * Cleanup SDK instance, restoring all patched globals
   */
  destroy() {
    this._destroyed = true;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }

    // Restore original console
    if (this._originalConsole && typeof window !== 'undefined' && window.console) {
      for (const [m, fn] of Object.entries(this._originalConsole)) {
        window.console[m] = fn;
      }
    }

    // Restore original fetch
    if (this._originalFetch && typeof window !== 'undefined') {
      window.fetch = this._originalFetch;
    }

    // Restore original XMLHttpRequest
    if (typeof XMLHttpRequest !== 'undefined') {
      if (this._originalXHROpen) XMLHttpRequest.prototype.open = this._originalXHROpen;
      if (this._originalXHRSend) XMLHttpRequest.prototype.send = this._originalXHRSend;
      if (this._originalXHRSetRequestHeader) XMLHttpRequest.prototype.setRequestHeader = this._originalXHRSetRequestHeader;
    }
  }
}

// Global and CommonJS export bindings
if (typeof window !== 'undefined') {
  window.VConsoleRemote = VConsoleRemote;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = VConsoleRemote;
}

export default VConsoleRemote;