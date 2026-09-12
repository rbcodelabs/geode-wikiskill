import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: 'test/screenshots', use: { viewport: { width: 1280, height: 800 } } });
