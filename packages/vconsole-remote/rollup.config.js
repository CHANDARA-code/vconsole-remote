import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

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
    {
      file: 'dist/vconsole-remote.esm.js',
      format: 'es',
      sourcemap: false
    }
  ],
  plugins: [
    resolve({
      browser: true,
      preferBuiltins: false
    }),
    commonjs()
  ]
};