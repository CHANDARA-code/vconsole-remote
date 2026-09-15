import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

const plugins = [
  resolve({
    browser: true,
    preferBuiltins: false
  }),
  commonjs()
];

export default {
  input: 'src/index.js',
  output: [
    {
      file: 'dist/vconsole-remote.js',
      format: 'umd',
      name: 'VConsoleRemote',
      exports: 'auto',
      sourcemap: false
    },
    // Minified UMD build. This is what the documented CDN URL points at, and
    // what mobile pages should load — the SDK ships on real user devices, so
    // the unminified bundle is a meaningful amount of dead weight.
    {
      file: 'dist/vconsole-remote.min.js',
      format: 'umd',
      name: 'VConsoleRemote',
      exports: 'auto',
      // No sourcemap: the unminified UMD build ships alongside this one and
      // serves the same purpose without adding ~850kB to every install.
      sourcemap: false,
      plugins: [terser()]
    },
    {
      file: 'dist/vconsole-remote.esm.js',
      format: 'es',
      sourcemap: false
    }
  ],
  plugins
};
