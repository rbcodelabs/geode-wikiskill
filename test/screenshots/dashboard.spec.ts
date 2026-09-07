import { expect, test } from '@playwright/test';
import { renderDashboard } from '../../src/dashboard';
import { readFileSync } from 'node:fs';

const model = { status: 'full' as const, imported: 24, redactions: 5, patterns: [{ id: 'p1', skill: 'integration-routing', action: 'Resolve each capability independently', confidence: 'strong' as const, evidence: ['a', 'b', 'c'], counterexamples: ['d'], updatedAt: '2026-09-07' }], candidates: [], evaluations: [] };
const theme = `body{margin:0;background:#17191d;color:#e8ecec;font:14px system-ui;--text-normal:#e8ecec;--text-muted:#aeb7bf;--text-error:#ff7b86;--background-primary:#17191d;--background-primary-alt:#1c2025;--background-secondary:#22262c;--background-modifier-border:#343941;--background-modifier-hover:#2d3239}`;
const css = `<style>${theme}${readFileSync('styles.css', 'utf8')}</style>`;

test('dashboard renders complete desktop information architecture', async ({ page }) => {
  await page.setContent(css + renderDashboard(model));
  await expect(page.getByRole('heading', { name: 'WikiSkill Evolution' })).toBeVisible();
  await expect(page.locator('section')).toHaveCount(6);
  await expect(page.locator('.wikiskill-shell')).toHaveScreenshot('dashboard-desktop.png', { animations: 'disabled' });
});

test('dashboard remains single-column and usable on a narrow host', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(css + renderDashboard({ ...model, status: 'offline' }));
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  const columns = await page.locator('main').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(1);
});
