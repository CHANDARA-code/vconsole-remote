import VConsole from 'vconsole';
import QRCode from 'qrcode';

/**
 * Brand palette, mirroring the dashboard's Ant Design theme so the on-device
 * UI and the desktop dashboard read as one product.
 */
const BrandColors = {
  bgBase: '#FAF9F5',
  bgContainer: '#F4F3EE',
  bgElevated: '#ECEAE1',
  border: '#E3E1D9',
  text: '#1F1E1C',
  textSecondary: '#6B6862',
  textTertiary: '#B1ADA1',
  primary: '#C15F3C',
  primaryHover: '#A94F30',
  success: '#4A7862',
  warning: '#B08838',
  error: '#B3492F',
  onPrimary: '#FFFFFF',
  overlay: 'rgba(31, 30, 28, 0.72)',
};

// Bodies above this size are recorded as a summary rather than in full. The
// SDK runs on real devices and forwards over a phone's uplink, so capturing a
// multi-megabyte upload verbatim costs the user memory and bandwidth for data
// nobody reads in a log panel.
const DEFAULT_MAX_BODY_BYTES = 128 * 1024;

// Content types whose bodies are meaningless as text.
const BINARY_CONTENT_TYPE = /^(image|video|audio|font)\/|^application\/(octet-stream|pdf|zip|gzip|x-gzip|wasm|x-protobuf|vnd\.android\.package-archive)/i;

const REDACTED_HEADER = '[REDACTED]';
const REDACTED_VALUE = '********';

const DEFAULT_SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'token',
  'x-auth-token'
];

const DEFAULT_SENSITIVE_BODY_KEYS = [
  'password',
  'passwd',
  'secret',
  'credit_card',
  'card_number',
  'cvv',
  'ssn',
  'pin',
  'token',
  'access_token',
  'refresh_token',
  'auth_token',
  'id_token',
  'api_key',
  'apikey',
  'authorization',
  'session_id',
  'sessionid'
];

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

    this.security = this._normalizeSecurityOptions(options.security);

    // Upper bound on how much of any single request or response body is kept
    const requestedMax = Number(options.maxBodyBytes);
    this.maxBodyBytes = Number.isFinite(requestedMax) && requestedMax >= 0
      ? requestedMax
      : DEFAULT_MAX_BODY_BYTES;

    const { serverOrigin, wsUrl } = this._parseServerUrls(this.options.server);
    this.serverOrigin = serverOrigin;
    this.wsUrl = wsUrl;

    this.vConsole = null;
    this.ws = null;
    this.roomPin = null;
    this.roomKey = null;
    this.remoteTab = null;
    this._tabContainer = null;
    this._qrCanvas = null;

    // Pending developer authorization prompt
    this._authPrompt = null;
    this._authCountdownTimer = null;

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
   * Resolve the security policy, defaulting to the safe end of every choice:
   * masking on, remote evaluation off.
   */
  _normalizeSecurityOptions(provided) {
    const input = provided || {};
    const toLowerList = (list, fallback) => {
      const source = Array.isArray(list) ? list : fallback;
      return source.map(entry => String(entry).toLowerCase());
    };

    return {
      maskSensitiveData: input.maskSensitiveData !== false,
      sensitiveHeaders: toLowerList(input.sensitiveHeaders, DEFAULT_SENSITIVE_HEADERS),
      sensitiveBodyKeys: toLowerList(input.sensitiveBodyKeys, DEFAULT_SENSITIVE_BODY_KEYS),
      allowRemoteEval: input.allowRemoteEval === true
    };
  }

  _formatBytes(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size < 0) return 'unknown size';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Apply the capture limit to a textual body, replacing an oversized data URI
   * with a summary and truncating anything else that runs past the cap.
   */
  _captureText(text) {
    if (typeof text !== 'string' || text === '') return text;

    const limit = this.maxBodyBytes;
    if (limit <= 0 || text.length <= limit) return text;

    const dataUri = /^data:([^;,]*)[^,]*,/.exec(text);
    if (dataUri) {
      return `[data URI: ${dataUri[1] || 'unknown type'}, ${this._formatBytes(text.length)}]`;
    }

    return `${text.slice(0, limit)}\n… [truncated: ${this._formatBytes(text.length)} total, showing the first ${this._formatBytes(limit)}]`;
  }

  /**
   * Turn a request body into something readable.
   *
   * fetch and XHR accept FormData, Blob, File, ArrayBuffer, typed arrays,
   * URLSearchParams and streams. JSON.stringify renders most of those as "{}"
   * and expands a typed array into one JSON entry per byte, so each shape is
   * described explicitly instead.
   */
  _describeRequestBody(body) {
    if (body === null || body === undefined) return null;
    if (typeof body === 'string') return this._captureText(body);

    // Resolve constructors from window in a browser and globalThis elsewhere,
    // so the describers behave the same under test as they do on a device.
    const isType = (name) => {
      const ctor = (typeof window !== 'undefined' && window[name])
        || (typeof globalThis !== 'undefined' && globalThis[name]);
      return typeof ctor === 'function' && body instanceof ctor;
    };

    try {
      if (isType('URLSearchParams')) return this._captureText(body.toString());
      if (isType('FormData')) return this._describeFormData(body);

      // File extends Blob, so it has to be checked first
      if (isType('File')) {
        return `[File: ${body.name || 'unnamed'}, ${body.type || 'unknown type'}, ${this._formatBytes(body.size)}]`;
      }
      if (isType('Blob')) {
        return `[Blob: ${body.type || 'unknown type'}, ${this._formatBytes(body.size)}]`;
      }
      if (isType('ArrayBuffer')) {
        return `[ArrayBuffer: ${this._formatBytes(body.byteLength)}]`;
      }
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) {
        const name = (body.constructor && body.constructor.name) || 'TypedArray';
        return `[${name}: ${this._formatBytes(body.byteLength)}]`;
      }
      if (isType('ReadableStream')) {
        // Reading it here would consume the upload before it is sent
        return '[ReadableStream: not captured]';
      }
      if (isType('Document')) return '[Document]';
    } catch (_) {
      return '[Body: could not be inspected]';
    }

    try {
      return this._captureText(JSON.stringify(body));
    } catch (_) {
      return '[Body: not serializable]';
    }
  }

  /**
   * Describe a multipart upload: text fields inline (masked where they name a
   * credential), files as name, type and size rather than their contents.
   */
  _describeFormData(formData) {
    const lines = [];
    let fileCount = 0;
    let fileBytes = 0;

    try {
      const entries = typeof formData.entries === 'function' ? formData.entries() : [];
      for (const [name, value] of entries) {
        if (value && typeof value === 'object' && typeof value.size === 'number') {
          fileCount += 1;
          fileBytes += value.size;
          const filename = value.name || 'unnamed';
          lines.push(`${name}: [file ${filename}, ${value.type || 'unknown type'}, ${this._formatBytes(value.size)}]`);
        } else {
          const masked = this.security.maskSensitiveData && this._isSensitiveKey(name)
            ? REDACTED_VALUE
            : String(value);
          lines.push(`${name}: ${masked}`);
        }
      }
    } catch (_) {
      return '[FormData: could not be read]';
    }

    if (!lines.length) return '[FormData: empty]';

    const summary = fileCount
      ? ` (${fileCount} file${fileCount === 1 ? '' : 's'}, ${this._formatBytes(fileBytes)})`
      : '';
    return this._captureText(`FormData${summary}\n${lines.join('\n')}`);
  }

  /**
   * Decide whether a response body is worth materialising. Returns a summary
   * string to store instead, or null to read the body normally.
   */
  _summarizeResponseBody(headers) {
    const lookup = (name) => {
      if (!headers) return '';
      const hit = Object.keys(headers).find(k => k.toLowerCase() === name);
      return hit ? String(headers[hit]) : '';
    };

    const contentType = lookup('content-type');
    const declaredLength = parseInt(lookup('content-length'), 10);

    if (contentType && BINARY_CONTENT_TYPE.test(contentType)) {
      const size = Number.isFinite(declaredLength) ? `, ${this._formatBytes(declaredLength)}` : '';
      return `[Binary response: ${contentType.split(';')[0]}${size}]`;
    }

    if (this.maxBodyBytes > 0 && Number.isFinite(declaredLength) && declaredLength > this.maxBodyBytes) {
      return `[Response not captured: ${this._formatBytes(declaredLength)} exceeds the ${this._formatBytes(this.maxBodyBytes)} capture limit]`;
    }

    return null;
  }

  _isSensitiveHeader(name) {
    return this.security.sensitiveHeaders.indexOf(String(name).toLowerCase()) !== -1;
  }

  _isSensitiveKey(name) {
    return this.security.sensitiveBodyKeys.indexOf(String(name).toLowerCase()) !== -1;
  }

  /**
   * Redact sensitive headers, preserving the auth scheme so the developer can
   * still see which kind of credential was sent.
   */
  _maskHeaders(headers) {
    if (!this.security.maskSensitiveData || !headers || typeof headers !== 'object') {
      return headers;
    }

    const masked = {};
    for (const key of Object.keys(headers)) {
      const value = headers[key];
      if (!this._isSensitiveHeader(key)) {
        masked[key] = value;
        continue;
      }
      const schemeMatch = typeof value === 'string' && value.match(/^(Bearer|Basic|Digest|Token)\s+/i);
      masked[key] = schemeMatch ? `${schemeMatch[1]} ${REDACTED_HEADER}` : REDACTED_HEADER;
    }
    return masked;
  }

  /**
   * Redact sensitive keys anywhere inside a JSON or form-encoded payload,
   * leaving the surrounding structure intact so the body stays readable.
   */
  _maskBody(body) {
    if (!this.security.maskSensitiveData || typeof body !== 'string' || body === '') {
      return body;
    }

    try {
      const parsed = JSON.parse(body);
      return JSON.stringify(this._maskObject(parsed));
    } catch (_) {
      // Not JSON; fall through to form-encoded handling
    }

    if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body)) {
      return body
        .split('&')
        .map(pair => {
          const idx = pair.indexOf('=');
          if (idx === -1) return pair;
          const key = pair.slice(0, idx);
          let decodedKey = key;
          try {
            decodedKey = decodeURIComponent(key);
          } catch (_) {}
          return this._isSensitiveKey(decodedKey) ? `${key}=${REDACTED_VALUE}` : pair;
        })
        .join('&');
    }

    return body;
  }

  _maskObject(value, depth = 0, seen = new WeakSet()) {
    if (depth > 8 || value === null || typeof value !== 'object') {
      return value;
    }
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map(item => this._maskObject(item, depth + 1, seen));
    }

    const masked = {};
    for (const key of Object.keys(value)) {
      masked[key] = this._isSensitiveKey(key)
        ? REDACTED_VALUE
        : this._maskObject(value[key], depth + 1, seen);
    }
    return masked;
  }

  /**
   * Redact credentials carried in a query string, which would otherwise leak
   * through the URL shown in the network list.
   */
  _maskUrl(url) {
    if (!this.security.maskSensitiveData || typeof url !== 'string') {
      return url;
    }
    const queryIndex = url.indexOf('?');
    if (queryIndex === -1) {
      return url;
    }

    const base = url.slice(0, queryIndex);
    const [query, ...hashParts] = url.slice(queryIndex + 1).split('#');
    const maskedQuery = query
      .split('&')
      .map(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return pair;
        const key = pair.slice(0, idx);
        let decodedKey = key;
        try {
          decodedKey = decodeURIComponent(key);
        } catch (_) {}
        return this._isSensitiveKey(decodedKey) || this._isSensitiveHeader(decodedKey)
          ? `${key}=${REDACTED_VALUE}`
          : pair;
      })
      .join('&');

    const hash = hashParts.length ? `#${hashParts.join('#')}` : '';
    return `${base}?${maskedQuery}${hash}`;
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
      if (init.body !== undefined && init.body !== null) {
        requestBody = this._describeRequestBody(init.body);
      } else if (input && typeof input === 'object' && input.body) {
        // Request object carrying a body stream
        requestBody = this._describeRequestBody(input.body);
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

        const baseRecord = {
          id: requestId,
          method,
          url,
          status,
          duration,
          requestHeaders,
          responseHeaders,
          requestBody,
          timestamp: startTime
        };

        // Binary or oversized payloads are summarized from the headers alone,
        // so the body is never pulled into memory on the device.
        const skipReason = this._summarizeResponseBody(responseHeaders);
        if (skipReason) {
          this._storeNetworkRequest(requestId, { ...baseRecord, responseBody: skipReason });
          this._send({
            type: 'network',
            request: {
              id: requestId,
              method,
              url: this._maskUrl(url),
              status,
              duration,
              timestamp: startTime
            }
          });
          return response;
        }

        try {
          const clone = response.clone();
          clone.text().then(text => {
            this._storeNetworkRequest(requestId, {
              ...baseRecord,
              responseBody: this._captureText(text)
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
            url: this._maskUrl(url),
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
            url: this._maskUrl(url),
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

      if (body !== undefined && body !== null) {
        requestBody = self._describeRequestBody(body);
      }

      const onComplete = () => {
        if (xhr._vr_handled) return;
        xhr._vr_handled = true;

        const duration = Date.now() - startTime;
        const status = xhr.status || 0;
        let responseBody = '';

        try {
          if (!xhr.responseType || xhr.responseType === 'text') {
            responseBody = self._captureText(xhr.responseText || '');
          } else if (xhr.responseType === 'json') {
            responseBody = self._captureText(JSON.stringify(xhr.response));
          } else if (xhr.responseType === 'arraybuffer' && xhr.response) {
            responseBody = `[ArrayBuffer response: ${self._formatBytes(xhr.response.byteLength)}]`;
          } else if (xhr.responseType === 'blob' && xhr.response) {
            responseBody = `[Blob response: ${xhr.response.type || 'unknown type'}, ${self._formatBytes(xhr.response.size)}]`;
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
            url: self._maskUrl(url),
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
   * Store network request data with FIFO eviction.
   * Every capture path funnels through here, so masking is applied once and the
   * cache itself never holds an unredacted credential.
   */
  _storeNetworkRequest(id, data) {
    if (this._networkCache.size >= this._maxNetworkCache) {
      const firstKey = this._networkCache.keys().next().value;
      this._networkCache.delete(firstKey);
    }
    this._networkCache.set(id, this._sanitizeNetworkRecord(data));
  }

  _sanitizeNetworkRecord(data) {
    if (!this.security.maskSensitiveData || !data) {
      return data;
    }
    return {
      ...data,
      url: this._maskUrl(data.url),
      requestHeaders: this._maskHeaders(data.requestHeaders),
      responseHeaders: this._maskHeaders(data.responseHeaders),
      requestBody: this._maskBody(data.requestBody),
      responseBody: this._maskBody(data.responseBody)
    };
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
    container.style.color = BrandColors.text;
    container.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    // Status element
    const statusElement = document.createElement('div');
    statusElement.id = 'vconsole-remote-status';
    statusElement.textContent = 'Status: Connecting... 🟡';
    statusElement.style.padding = '10px 14px';
    statusElement.style.marginBottom = '14px';
    statusElement.style.borderRadius = '6px';
    statusElement.style.backgroundColor = BrandColors.bgElevated;
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
    pinElement.style.color = BrandColors.primary;
    pinElement.style.backgroundColor = BrandColors.bgElevated;
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
    qrWrapper.style.backgroundColor = '#FFFFFF';
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
    qrHint.style.color = BrandColors.textSecondary;
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

    const targetUrl = this._pairingUrl(pin);
    QRCode.toCanvas(canvas, targetUrl, { width: 180, margin: 2 }, (error) => {
      if (error && this._originalConsole && this._originalConsole.error) {
        this._originalConsole.error('[vConsole-Remote] QR Code render error:', error);
      }
    });
  }

  /**
   * Render the full-screen Allow / Reject prompt. Until the device owner taps
   * Allow, the server streams nothing to the waiting developer, so this prompt
   * is the gate that a guessed PIN alone cannot pass.
   */
  _showAuthPrompt(data) {
    if (typeof document === 'undefined' || !document.body) return;

    this._dismissAuthPrompt();

    const authId = data.authId || '';
    const client = data.client || {};
    const expiresIn = Number(data.expiresIn) > 0 ? Number(data.expiresIn) : 60;

    const overlay = document.createElement('div');
    overlay.setAttribute('data-vconsole-remote-auth', authId);
    this._applyStyles(overlay, {
      position: 'fixed',
      inset: '0',
      top: '0',
      left: '0',
      right: '0',
      bottom: '0',
      zIndex: '2147483647',
      backgroundColor: BrandColors.overlay,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      boxSizing: 'border-box',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    });

    const card = document.createElement('div');
    this._applyStyles(card, {
      width: '100%',
      maxWidth: '340px',
      backgroundColor: BrandColors.bgContainer,
      color: BrandColors.text,
      borderRadius: '12px',
      padding: '20px',
      boxSizing: 'border-box',
      boxShadow: '0 18px 48px rgba(31, 30, 28, 0.28)'
    });

    const title = document.createElement('div');
    title.textContent = '⚠️ Incoming Debug Connection';
    this._applyStyles(title, {
      fontSize: '16px',
      fontWeight: '700',
      marginBottom: '12px'
    });
    card.appendChild(title);

    const body = document.createElement('div');
    this._applyStyles(body, {
      fontSize: '13.5px',
      lineHeight: '1.6',
      color: BrandColors.textSecondary,
      marginBottom: '14px'
    });
    // textContent throughout: the description is derived from a request header
    // and must never be parsed as markup.
    body.textContent = `${client.description || 'An unknown client'} wants to view this device's logs.`;
    card.appendChild(body);

    const detail = document.createElement('div');
    this._applyStyles(detail, {
      fontSize: '12px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      color: BrandColors.textSecondary,
      backgroundColor: BrandColors.bgElevated,
      borderRadius: '10px',
      padding: '10px 12px',
      marginBottom: '16px',
      wordBreak: 'break-word'
    });
    detail.textContent = `IP: ${client.ip || 'unknown'}`;
    card.appendChild(detail);

    const countdown = document.createElement('div');
    this._applyStyles(countdown, {
      fontSize: '12px',
      color: BrandColors.textTertiary,
      textAlign: 'center',
      marginBottom: '14px'
    });
    countdown.textContent = `Expires in ${expiresIn}s`;
    card.appendChild(countdown);

    const buttonRow = document.createElement('div');
    this._applyStyles(buttonRow, { display: 'flex', gap: '10px' });

    const rejectButton = document.createElement('button');
    rejectButton.type = 'button';
    rejectButton.textContent = 'Reject';
    this._applyStyles(rejectButton, {
      flex: '1',
      height: '44px',
      borderRadius: '8px',
      border: `1px solid ${BrandColors.border}`,
      backgroundColor: BrandColors.bgBase,
      color: BrandColors.text,
      fontSize: '15px',
      fontWeight: '600',
      cursor: 'pointer'
    });
    rejectButton.addEventListener('click', () => this._respondToAuth(authId, false));

    const allowButton = document.createElement('button');
    allowButton.type = 'button';
    allowButton.textContent = 'Allow';
    this._applyStyles(allowButton, {
      flex: '1',
      height: '44px',
      borderRadius: '8px',
      border: 'none',
      backgroundColor: BrandColors.primary,
      color: BrandColors.onPrimary,
      fontSize: '15px',
      fontWeight: '600',
      cursor: 'pointer'
    });
    allowButton.addEventListener('click', () => this._respondToAuth(authId, true));

    buttonRow.appendChild(rejectButton);
    buttonRow.appendChild(allowButton);
    card.appendChild(buttonRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    this._authPrompt = overlay;
    this.updateConnectionStatus('Authorization Requested 🟡');

    let remaining = expiresIn;
    this._authCountdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        this._dismissAuthPrompt();
        this.updateConnectionStatus('Waiting for Developer 🟡');
        return;
      }
      countdown.textContent = `Expires in ${remaining}s`;
    }, 1000);
  }

  _applyStyles(element, styles) {
    for (const [property, value] of Object.entries(styles)) {
      element.style[property] = value;
    }
  }

  _respondToAuth(authId, approved) {
    this._dismissAuthPrompt();
    this._send({
      type: 'auth_response',
      authId,
      approved,
      timestamp: Date.now()
    });
    this.updateConnectionStatus(approved ? 'Developer Connected 🟢' : 'Connection Rejected 🟥');
  }

  _dismissAuthPrompt() {
    if (this._authCountdownTimer) {
      clearInterval(this._authCountdownTimer);
      this._authCountdownTimer = null;
    }
    if (this._authPrompt && this._authPrompt.parentNode) {
      this._authPrompt.parentNode.removeChild(this._authPrompt);
    }
    this._authPrompt = null;
  }

  /**
   * Build the dashboard URL for a room. The room key is included when the
   * server issued one, so scanning the QR carries both factors.
   */
  _pairingUrl(pin) {
    const base = `${this.serverOrigin}/#/room/${pin}`;
    return this.roomKey ? `${base}?key=${encodeURIComponent(this.roomKey)}` : base;
  }

  /**
   * Render a PIN as plain digits. The separator that used to sit in the middle
   * looked tidier but had to be stripped by hand whenever someone copied the
   * PIN across to the dashboard.
   */
  _formatPin(pin) {
    if (!pin) return '';
    return String(pin).replace(/\D/g, '');
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
    if (status.includes('Connected') || status.includes('🟢')) return BrandColors.success;
    if (status.includes('Waiting') || status.includes('🟡')) return BrandColors.warning;
    return BrandColors.error;
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
        this.roomKey = data.key || (data.message && data.message.key) || null;
        this.updatePinDisplay();
        this.updateConnectionStatus('Waiting for Developer 🟡');
        break;

      case 'auth_request':
        this._showAuthPrompt(data);
        break;

      case 'auth_cancelled':
        this._dismissAuthPrompt();
        this.updateConnectionStatus('Waiting for Developer 🟡');
        break;

      case 'session_expired':
        this._dismissAuthPrompt();
        this._destroyed = true;
        this.updateConnectionStatus('Session Expired 🟥');
        break;

      case 'rate_limited':
        this.updateConnectionStatus('Blocked: too many attempts 🟥');
        break;

      case 'dev_connected':
      case 'room_connected':
        this.updateConnectionStatus('Developer Connected 🟢');
        break;

      case 'dev_disconnected':
        this._dismissAuthPrompt();
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
          lsMap[key] = this._maskStorageValue(key, localStorage.getItem(key));
        }
      }
    } catch (_) {}

    try {
      if (typeof sessionStorage !== 'undefined') {
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          ssMap[key] = this._maskStorageValue(key, sessionStorage.getItem(key));
        }
      }
    } catch (_) {}

    try {
      if (typeof document !== 'undefined') {
        cookiesStr = this._maskCookieString(document.cookie || '');
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
   * Redact a storage entry whose key names a credential; values that are JSON
   * objects are walked so a nested token is caught too.
   */
  _maskStorageValue(key, value) {
    if (!this.security.maskSensitiveData) {
      return value;
    }
    if (this._isSensitiveKey(key) || this._isSensitiveHeader(key)) {
      return REDACTED_VALUE;
    }
    return this._maskBody(value);
  }

  /**
   * Cookies are session credentials; every value is redacted unless masking is
   * explicitly turned off.
   */
  _maskCookieString(cookies) {
    if (!this.security.maskSensitiveData || !cookies) {
      return cookies;
    }
    return cookies
      .split('; ')
      .filter(Boolean)
      .map(pair => {
        const idx = pair.indexOf('=');
        return idx === -1 ? pair : `${pair.slice(0, idx)}=${REDACTED_VALUE}`;
      })
      .join('; ');
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
        ctx.fillStyle = '#1A1917';
        ctx.fillRect(0, 0, width, height);

        ctx.fillStyle = '#F4F3EE';
        ctx.font = 'bold 20px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('vConsole Remote Snapshot', width / 2, 80);

        ctx.font = '14px monospace';
        ctx.fillStyle = '#B1ADA1';
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

    if (!this.security.allowRemoteEval) {
      const refusal = 'Remote evaluation is disabled on this device (security.allowRemoteEval is false)';
      this._send({
        type: 'exec_result',
        error: refusal,
        output: refusal,
        isError: true
      });
      return;
    }

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

    this._dismissAuthPrompt();

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