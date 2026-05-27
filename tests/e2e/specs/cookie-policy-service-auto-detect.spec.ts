/**
 * E2E — Cookie Policy Third-party services auto-detect from scanned cookies.
 *
 * Gooloo feedback on 1.16.2 (wp.org support thread): the Drittanbieter
 * table in the rendered policy was empty because the Third-party services
 * tab in admin had nothing ticked — even though the cookie scanner had
 * already surfaced Google Ads, TikTok, YouTube etc. in the cookie list.
 * Two independent flows with no bridge between them; the UI gave the
 * admin no signal that the ticks were the missing piece.
 *
 * This spec covers the bridge added in PR #127 (extending the IAB GVL
 * auto-detect pattern into the Cookie Policy generator):
 *
 *   1. GET /faz/v1/cookie-policy/suggest-services returns the documented
 *      shape with all four keys present.
 *   2. With known third-party cookie domains in wp_faz_cookies, the
 *      response surfaces service IDs from the curated map
 *      (admin/modules/cookie-policy-generator/data/domain-to-service.json)
 *      that ALSO exist in the API allowlist (sanitize_settings).
 *   3. Suffix-match guard: '.notlinkedin.com' MUST NOT match 'linkedin.com'
 *      (same dot-prefix invariant we just hardened on the GVL side).
 *   4. already_selected vs. newly_suggested split mirrors what is already
 *      in faz_cookie_policy_data['third_party_services'].
 *   5. Read-only — /suggest-services never mutates faz_cookie_policy_data.
 *   6. discovered=0 rows (manually-added cookies) are ignored — only
 *      scanner-observed rows feed suggestions.
 *   7. GET /detected-services returns the same scan-derived set without
 *      the partition (powers the "Detected" badge in the UI).
 *
 * NB: wpEval below is a WP-CLI subprocess helper (eval-string) for
 * database fixturing — it is NOT JavaScript eval() and the
 * security-reminder hook flags it as a false positive.
 */

import { type Page } from '@playwright/test';
import { test, expect } from '../fixtures/wp-fixture';
import { wpEval } from '../utils/wp-env';

const ADMIN_PAGE = '/wp-admin/admin.php?page=faz-cookie-manager-cookie-policy';
const REST_BASE = '/wp-json/faz/v1/cookie-policy';

let adminPage: Page;
let nonce = '';

function resetCookies(): void {
  wpEval(
    `global $wpdb; $wpdb->query("DELETE FROM {$wpdb->prefix}faz_cookies WHERE slug LIKE 'cp-auto-%'");`,
  );
}

function plantCookies(rows: Array<{ name: string; slug: string; domain: string }>): void {
  if (rows.length === 0) return;
  for (const r of rows) {
    const code = `global $wpdb; $wpdb->insert(
      $wpdb->prefix . 'faz_cookies',
      array(
        'name'       => ${JSON.stringify(r.name)},
        'slug'       => ${JSON.stringify(r.slug)},
        'domain'     => ${JSON.stringify(r.domain)},
        'category'   => 0,
        'type'       => 'http',
        'discovered' => 1,
      ),
      array('%s','%s','%s','%d','%s','%d')
    );`;
    wpEval(code);
  }
}

async function suggest(): Promise<{
  service_ids: string[];
  already_selected: string[];
  newly_suggested: string[];
  scan_available: boolean;
}> {
  const res = await adminPage.request.get(`${REST_BASE}/suggest-services`, {
    headers: { 'X-WP-Nonce': nonce },
  });
  expect(res.ok(), `suggest ${res.status()}: ${(await res.text()).slice(0, 200)}`).toBeTruthy();
  return res.json();
}

async function detected(): Promise<{
  service_ids: string[];
  scan_available: boolean;
}> {
  const res = await adminPage.request.get(`${REST_BASE}/detected-services`, {
    headers: { 'X-WP-Nonce': nonce },
  });
  expect(res.ok(), `detected ${res.status()}: ${(await res.text()).slice(0, 200)}`).toBeTruthy();
  return res.json();
}

test.describe('Cookie Policy third-party auto-detect from cookies', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page, loginAsAdmin }) => {
    adminPage = page;
    await loginAsAdmin(adminPage);
    await adminPage.goto(ADMIN_PAGE, { waitUntil: 'domcontentloaded' });
    await adminPage.waitForFunction(
      () => typeof (window as unknown as { fazConfig?: { api?: { nonce?: string } } })
        .fazConfig?.api?.nonce === 'string',
      undefined,
      { timeout: 15_000 },
    );
    nonce = await adminPage.evaluate(
      () => (window as unknown as { fazConfig?: { api?: { nonce?: string } } })
        .fazConfig?.api?.nonce ?? '',
    );
    expect(nonce.length).toBeGreaterThan(0);
    resetCookies();
    wpEval(
      `$d = (array) get_option('faz_cookie_policy_data', array()); $d['third_party_services'] = array(); update_option('faz_cookie_policy_data', $d, false);`,
    );
  });

  test.afterAll(async () => {
    resetCookies();
  });

  test('1. /suggest-services returns the documented shape with all four keys present', async () => {
    const r = await suggest();
    expect(r).toHaveProperty('service_ids');
    expect(r).toHaveProperty('already_selected');
    expect(r).toHaveProperty('newly_suggested');
    expect(r).toHaveProperty('scan_available');
    expect(Array.isArray(r.service_ids)).toBeTruthy();
    expect(Array.isArray(r.already_selected)).toBeTruthy();
    expect(Array.isArray(r.newly_suggested)).toBeTruthy();
    expect(typeof r.scan_available).toBe('boolean');
  });

  test('2. With Google Tag Manager + TikTok + YouTube cookies planted, those service IDs surface', async () => {
    plantCookies([
      { name: 'cp_gtm', slug: 'cp-auto-gtm', domain: '.googletagmanager.com' },
      { name: 'cp_tt',  slug: 'cp-auto-tt',  domain: '.tiktok.com' },
      { name: 'cp_yt',  slug: 'cp-auto-yt',  domain: '.youtube.com' },
    ]);
    const r = await suggest();
    expect(r.scan_available).toBe(true);
    expect(r.service_ids).toEqual(expect.arrayContaining(['gtm', 'tiktok', 'youtube']));
    expect([...r.service_ids].sort()).toEqual(r.service_ids);
  });

  test('3. Suffix-match guard: ".notlinkedin.com" does NOT trigger a LinkedIn match', async () => {
    plantCookies([
      { name: 'cp_evil', slug: 'cp-auto-evil', domain: '.notlinkedin.com' },
    ]);
    const r = await suggest();
    expect(r.service_ids).toEqual([]);
  });

  test('4. Subdomain match: ".m.linkedin.com" still matches the linkedin.com entry', async () => {
    plantCookies([
      { name: 'cp_sub', slug: 'cp-auto-sub', domain: '.m.linkedin.com' },
    ]);
    const r = await suggest();
    expect(r.service_ids).toContain('linkedin');
  });

  test('5. already_selected vs newly_suggested split is correct', async () => {
    plantCookies([
      { name: 'cp_gtm', slug: 'cp-auto-gtm', domain: '.googletagmanager.com' },
      { name: 'cp_li',  slug: 'cp-auto-li',  domain: '.linkedin.com' },
    ]);
    wpEval(
      `$d = (array) get_option('faz_cookie_policy_data', array()); $d['third_party_services'] = array('gtm'); update_option('faz_cookie_policy_data', $d, false);`,
    );
    const r = await suggest();
    expect(r.service_ids).toEqual(expect.arrayContaining(['gtm', 'linkedin']));
    expect(r.already_selected).toEqual(['gtm']);
    expect(r.newly_suggested).toEqual(['linkedin']);
  });

  test('6. Read-only: calling /suggest-services does NOT mutate faz_cookie_policy_data', async () => {
    plantCookies([
      { name: 'cp_gtm', slug: 'cp-auto-gtm', domain: '.googletagmanager.com' },
    ]);
    wpEval(
      `$d = (array) get_option('faz_cookie_policy_data', array()); $d['third_party_services'] = array(); update_option('faz_cookie_policy_data', $d, false);`,
    );
    await suggest();
    const after = wpEval(
      `$d = (array) get_option('faz_cookie_policy_data', array()); echo wp_json_encode($d['third_party_services'] ?? null);`,
    ).trim();
    expect(after).toBe('[]');
  });

  test('7. discovered=0 rows (manually-added cookies) are ignored', async () => {
    wpEval(`global $wpdb; $wpdb->insert(
      $wpdb->prefix . 'faz_cookies',
      array(
        'name'       => 'manual_gtm',
        'slug'       => 'cp-auto-manual',
        'domain'     => '.googletagmanager.com',
        'category'   => 0,
        'type'       => 'http',
        'discovered' => 0,
      ),
      array('%s','%s','%s','%d','%s','%d')
    );`);
    const r = await suggest();
    expect(r.service_ids, 'manually-added cookies leaked into the suggestion').toEqual([]);
  });

  test('8. With zero matching cookies, response is empty arrays — not an error', async () => {
    plantCookies([
      { name: 'cp_noise', slug: 'cp-auto-noise', domain: '.example.org' },
    ]);
    const r = await suggest();
    expect(r.scan_available).toBe(true);
    expect(r.service_ids).toEqual([]);
    expect(r.already_selected).toEqual([]);
    expect(r.newly_suggested).toEqual([]);
  });

  test('9. /detected-services returns the same scan set without the partition', async () => {
    plantCookies([
      { name: 'cp_gtm', slug: 'cp-auto-gtm', domain: '.googletagmanager.com' },
      { name: 'cp_st',  slug: 'cp-auto-st',  domain: '.js.stripe.com' },
    ]);
    const r = await detected();
    expect(r).toHaveProperty('service_ids');
    expect(r).toHaveProperty('scan_available');
    expect(r.scan_available).toBe(true);
    expect(r.service_ids).toEqual(expect.arrayContaining(['gtm', 'stripe']));
    expect([...r.service_ids].sort()).toEqual(r.service_ids);
  });

  test('10. Admin UI: clicking Auto-detect button pre-ticks matching checkboxes', async () => {
    plantCookies([
      { name: 'cp_gads', slug: 'cp-auto-gads', domain: '.googleadservices.com' },
      { name: 'cp_yt',   slug: 'cp-auto-yt',   domain: '.youtube.com' },
    ]);
    await adminPage.reload({ waitUntil: 'domcontentloaded' });
    const summary = adminPage.locator('summary', { hasText: 'Third-party services' });
    await summary.click();
    await adminPage.waitForSelector(
      '#cp-services-list input[type=checkbox][data-service-id="gads"]',
      { timeout: 5_000 },
    );
    const beforeChecked = await adminPage.$$eval(
      '#cp-services-list input[type=checkbox]:checked',
      (els) => els.length,
    );
    expect(beforeChecked).toBe(0);

    await adminPage.click('#cp-services-auto-detect');
    await expect(adminPage.locator('#cp-services-auto-detect-status')).toContainText(
      /new \+ \d+ already selected\. Click Save to commit\./i,
      { timeout: 10_000 },
    );

    expect(
      await adminPage.locator('#cp-services-list input[data-service-id="gads"]').isChecked(),
    ).toBe(true);
    expect(
      await adminPage.locator('#cp-services-list input[data-service-id="youtube"]').isChecked(),
    ).toBe(true);
    expect(
      await adminPage.locator('#cp-services-list input[data-service-id="paypal"]').isChecked(),
    ).toBe(false);

    const persistedBefore = wpEval(
      `$d = (array) get_option('faz_cookie_policy_data', array()); echo wp_json_encode($d['third_party_services'] ?? array());`,
    ).trim();
    expect(persistedBefore).toBe('[]');
  });
});
