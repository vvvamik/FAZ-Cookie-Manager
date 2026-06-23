import { test, expect } from '../fixtures/wp-fixture';
import type { Page } from '@playwright/test';

/**
 * Cache Compatibility Mode (issue #158) — end-to-end header behaviour.
 *
 * The plugin only cache-busts a page whose banner output varies by visitor
 * country (IAB TCF, geo-targeting, country-targeted banners, runtime geo). The
 * new banner_control.cache_compatibility toggle forces the output to be treated
 * as NON country-dependent, so the server stops emitting the no-cache/no-store
 * stack and the DONOTCACHEPAGE constant — keeping the HTML cacheable by
 * LiteSpeed/QUIC.cloud/Varnish while the banner runs client-side.
 *
 * This suite drives the REAL header path: it flips IAB on (a country-dependent
 * trigger) and reads the front-end response headers from an ANONYMOUS context,
 * with the toggle off (cache-bust active) and on (cacheable). Serial + restores
 * the original settings in afterAll, so it is reusable in isolation or in-suite.
 */

const BASE = process.env.WP_BASE_URL ?? 'http://127.0.0.1:9998';

type FazSettings = Record<string, unknown>;

async function getAdminNonce(page: Page): Promise<string> {
  return page.evaluate(() => window.fazConfig?.api?.nonce ?? '');
}
async function getSettings(page: Page, nonce: string): Promise<FazSettings> {
  const res = await page.request.get('/?rest_route=/faz/v1/settings/', { headers: { 'X-WP-Nonce': nonce } });
  expect(res.status()).toBe(200);
  return (await res.json()) as FazSettings;
}
async function postSettings(page: Page, nonce: string, payload: FazSettings): Promise<void> {
  const res = await page.request.post('/?rest_route=/faz/v1/settings/', {
    headers: { 'X-WP-Nonce': nonce, 'Content-Type': 'application/json' },
    data: payload,
  });
  expect(res.status(), `settings update status ${res.status()}`).toBe(200);
}

/** Read front-end response headers as an anonymous visitor (no admin cookies). */
async function anonHeaders(browser: import('@playwright/test').Browser): Promise<Record<string, string>> {
  const ctx = await browser.newContext();
  try {
    const res = await ctx.request.get(BASE + '/', { headers: { 'User-Agent': 'Mozilla/5.0 (cache-compat-e2e)' } });
    return res.headers();
  } finally {
    await ctx.close();
  }
}

test.describe('Cache Compatibility Mode (issue #158)', () => {
  test.describe.configure({ mode: 'serial' });

  let admin: Page;
  let nonce = '';
  let originalBannerControl: Record<string, unknown> = {};
  let originalIab: Record<string, unknown> = {};

  async function applyState(opts: { cacheCompat: boolean; iab: boolean }): Promise<void> {
    await postSettings(admin, nonce, {
      banner_control: { ...originalBannerControl, status: true, cache_compatibility: opts.cacheCompat },
      iab: { ...originalIab, enabled: opts.iab },
    });
  }

  test.beforeAll(async ({ browser, loginAsAdmin }) => {
    admin = await browser.newPage();
    await loginAsAdmin(admin);
    await admin.goto('/wp-admin/admin.php?page=faz-cookie-manager-settings', { waitUntil: 'domcontentloaded' });
    nonce = await getAdminNonce(admin);
    expect(nonce.length).toBeGreaterThan(0);
    const current = await getSettings(admin, nonce);
    originalBannerControl = { ...(current.banner_control as Record<string, unknown> | undefined) };
    originalIab = { ...(current.iab as Record<string, unknown> | undefined) };
  });

  test.afterAll(async () => {
    if (nonce) {
      await postSettings(admin, nonce, { banner_control: originalBannerControl, iab: originalIab });
    }
    await admin.close();
  });

  test('1. default (no country-dependent trigger) is already cacheable', async ({ browser }) => {
    await applyState({ cacheCompat: false, iab: false });
    const h = await anonHeaders(browser);
    expect(h['x-litespeed-cache-control']).toBeUndefined();
    expect(h['cache-control'] ?? '').not.toContain('no-store');
  });

  test('2. IAB on + cache-compat OFF → cache-bust headers ARE emitted (control)', async ({ browser }) => {
    await applyState({ cacheCompat: false, iab: true });
    const h = await anonHeaders(browser);
    expect(h['x-litespeed-cache-control']).toBe('no-cache');
    expect(h['cache-control'] ?? '').toContain('no-store');
    expect(h['pragma'] ?? '').toContain('no-cache');
  });

  test('3. IAB on + cache-compat ON → NO X-LiteSpeed no-cache header (cacheable)', async ({ browser }) => {
    await applyState({ cacheCompat: true, iab: true });
    const h = await anonHeaders(browser);
    expect(h['x-litespeed-cache-control']).toBeUndefined();
  });

  test('4. IAB on + cache-compat ON → Cache-Control has no no-store/no-cache', async ({ browser }) => {
    await applyState({ cacheCompat: true, iab: true });
    const h = await anonHeaders(browser);
    const cc = h['cache-control'] ?? '';
    expect(cc).not.toContain('no-store');
    expect(h['pragma'] ?? '').not.toContain('no-cache');
  });

  test('5. cache-compat ON still ships the banner (consent stays client-side)', async ({ browser }) => {
    await applyState({ cacheCompat: true, iab: true });
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.documentElement.classList.contains('faz-ready'), { timeout: 8000 });
      // The banner config is localized and the consent runtime is present — the
      // cacheable HTML still carries everything the client needs.
      const hasConfig = await page.evaluate(() => typeof (window as unknown as { _fazConfig?: unknown })._fazConfig === 'object');
      expect(hasConfig).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test('6. toggling cache-compat back OFF restores the cache-bust (reversible)', async ({ browser }) => {
    await applyState({ cacheCompat: false, iab: true });
    const h = await anonHeaders(browser);
    expect(h['x-litespeed-cache-control']).toBe('no-cache');
  });
});
