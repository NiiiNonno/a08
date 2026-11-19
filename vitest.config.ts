import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    // obsidian パッケージは型だけなので、テストでは最小限の代わりを使う
    alias: { obsidian: fileURLToPath(new URL('./packages/obsidian-plugin/test/obsidian-stub.ts', import.meta.url)) },
  },
});
