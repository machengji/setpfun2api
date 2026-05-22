import { defineConfig } from 'tsup';
import pkg from './package.json';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  publicDir: 'public',
  // 将除了 playwright 之外的所有依赖都打包到单个文件中，完美解决 pkg 打包时的 ESM 兼容性和相对路径加载问题
  noExternal: Object.keys(pkg.dependencies).filter(dep => dep !== 'playwright'),
  external: ['playwright'],
});
