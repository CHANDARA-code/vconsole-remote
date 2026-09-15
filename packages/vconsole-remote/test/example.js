// Example usage of vConsoleRemote
if (typeof window === 'undefined') {
  global.window = {
    location: { origin: 'http://localhost:3000' },
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: () => {},
    localStorage: { length: 0, getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    sessionStorage: { length: 0, getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    console: global.console
  };
  global.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: () => ({
      appendChild: () => {},
      setAttribute: () => {},
      style: {},
      getContext: () => ({ fillStyle: '', fillRect: () => {}, fillText: () => {} }),
      toDataURL: () => ''
    }),
    getElementById: () => null
  };
  global.WebSocket = class {
    constructor() { this.readyState = 1; }
    send() {}
    close() {}
  };
  global.XMLHttpRequest = class {};
}

const VConsoleRemote = typeof require !== 'undefined' ? require('../dist/vconsole-remote.js') : window.VConsoleRemote;

// Initialize with default settings
const vConsole = new VConsoleRemote({
  server: 'http://localhost:8080',
  theme: 'dark',
  autoConnect: false
});

// Test that the class is properly exported
console.log('vConsoleRemote initialized successfully');
console.log('vConsole instance exists:', !!vConsole);

// Simulate some log messages
vConsole.sendLog('info', 'Test info message');
vConsole.sendLog('error', 'Test error message');
vConsole.sendLog('warn', 'Test warning message');
console.log('Example completed successfully');