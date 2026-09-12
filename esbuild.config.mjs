import esbuild from 'esbuild';
import fs from 'node:fs';
fs.mkdirSync('dist', { recursive: true });
await esbuild.build({ entryPoints: ['src/main.ts'], bundle: true, platform: 'node', target: 'es2020', format: 'cjs', external: ['obsidian'], outfile: 'dist/main.js', sourcemap: 'inline' });
fs.copyFileSync('manifest.json', 'dist/manifest.json');
if (fs.existsSync('styles.css')) fs.copyFileSync('styles.css', 'dist/styles.css');
