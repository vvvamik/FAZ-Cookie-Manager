import { expect, test } from '../fixtures/wp-fixture';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { wp, wpEval, WP_PATH } from '../utils/wp-env';

/**
 * Plugin lifecycle tests — upgrade (deactivate → activate) and fresh install
 * (deactivate → delete → re-upload → activate).
 *
 * These tests verify that:
 * - Migrations run correctly on re-activation (upgrade path)
 * - A clean install from scratch creates all DB tables and default data
 * - The frontend banner works after both paths
 */

const PLUGIN_SLUG = 'faz-cookie-manager';
const PLUGIN_FILE = `${PLUGIN_SLUG}/faz-cookie-manager.php`;
const PLUGINS_PAGE = '/wp-admin/plugins.php';

// Source and deploy paths — configurable via env vars for CI portability.
const SOURCE_PATH = process.env.FAZ_PLUGIN_SOURCE_PATH ?? `${process.cwd()}/`;
const DEPLOY_PATH = process.env.FAZ_PLUGIN_DEPLOY_PATH ?? '';

if (!DEPLOY_PATH) {
  throw new Error(
    'FAZ_PLUGIN_DEPLOY_PATH environment variable is required for lifecycle tests.\n' +
    'Example: FAZ_PLUGIN_DEPLOY_PATH=/path/to/wp-content/plugins/faz-cookie-manager/',
  );
}

/** Helper: check if the plugin row has WordPress "active" class (not "inactive"). */
function isPluginActive(rowClass: string | null): boolean {
  if (!rowClass) return false;
  // WP uses "active" for active, "inactive" for deactivated.
  // Split on whitespace and check for exact match.
  return rowClass.split(/\s+/).includes('active');
}

/** Validate DEPLOY_PATH before destructive filesystem ops. */
function assertSafeDeployPath(): void {
  const base = basename(DEPLOY_PATH.replace(/\/+$/, ''));
  if (!DEPLOY_PATH || DEPLOY_PATH === '/' || !DEPLOY_PATH.includes('plugins') || base !== PLUGIN_SLUG) {
    throw new Error(`Refusing to delete: DEPLOY_PATH appears unsafe: "${DEPLOY_PATH}"`);
  }
}

/** Helper: ensure the plugin is present and activated, handling any prior state. */
async function ensurePluginActive(page: import('@playwright/test').Page, wpBaseURL: string): Promise<void> {
  // Re-deploy in case a previous run deleted the plugin files
  try {
    execFileSync('rsync', ['-a', '--delete', SOURCE_PATH, DEPLOY_PATH], { timeout: 30000 });
  } catch (error) {
    throw new Error(
      `Failed to deploy plugin files via rsync.\n` +
      `SOURCE_PATH: ${SOURCE_PATH}\nDEPLOY_PATH: ${DEPLOY_PATH}\n` +
      `Original error: ${error}`,
    );
  }

  await page.goto(`${wpBaseURL}${PLUGINS_PAGE}`, { waitUntil: 'domcontentloaded' });
  const pluginRow = page.locator(`tr[data-plugin="${PLUGIN_FILE}"]`);

  if (await pluginRow.count() === 0) {
    // Plugin files missing — reload after rsync
    await page.reload({ waitUntil: 'domcontentloaded' });
  }

  await expect(pluginRow).toBeVisible();
  const rowClass = await pluginRow.getAttribute('class');
  if (!isPluginActive(rowClass)) {
    await pluginRow.locator('span.activate a').click();
    await page.waitForLoadState('domcontentloaded');
  }
}

test.describe.serial('Plugin lifecycle', () => {

  // These tests are slow because they deactivate/delete/reinstall the plugin.
  test.setTimeout(120_000);

  test('upgrade path: deactivate → reactivate preserves data and runs migrations', async ({
    page, wpBaseURL, loginAsAdmin,
  }) => {
    await loginAsAdmin(page);

    // --- Ensure plugin is active before starting ---
    await ensurePluginActive(page, wpBaseURL);

    // --- Verify we have data: at least one cookie category exists ---
    await page.goto(`${wpBaseURL}/wp-admin/admin.php?page=faz-cookie-manager-cookies`, { waitUntil: 'domcontentloaded' });
    const categoriesBefore = await page.evaluate(async (base) => {
      const nonce = window.fazConfig?.api?.nonce ?? '';
      const res = await fetch(`${base}/?rest_route=/faz/v1/cookies/categories/`, {
        headers: { 'X-WP-Nonce': nonce },
      });
      if (!res.ok) return null;
      return res.json();
    }, wpBaseURL);
    expect(Array.isArray(categoriesBefore)).toBeTruthy();
    expect(categoriesBefore!.length).toBeGreaterThan(0);
    const categoryCountBefore = categoriesBefore!.length;

    // --- Deactivate ---
    await page.goto(`${wpBaseURL}${PLUGINS_PAGE}`, { waitUntil: 'domcontentloaded' });
    const deactivateLink = page.locator(`tr[data-plugin="${PLUGIN_FILE}"] a[href*="action=deactivate"]`);
    await deactivateLink.click();
    await page.waitForLoadState('domcontentloaded');

    // Verify deactivated — WP class should be "inactive", NOT "active"
    await page.goto(`${wpBaseURL}${PLUGINS_PAGE}`, { waitUntil: 'domcontentloaded' });
    const rowClassAfterDeactivate = await page.locator(`tr[data-plugin="${PLUGIN_FILE}"]`).getAttribute('class');
    expect(isPluginActive(rowClassAfterDeactivate)).toBe(false);

    // --- Reactivate ---
    const activateLink = page.locator(`tr[data-plugin="${PLUGIN_FILE}"] span.activate a`);
    await activateLink.click();
    await page.waitForLoadState('domcontentloaded');

    // Verify activated
    await page.goto(`${wpBaseURL}${PLUGINS_PAGE}`, { waitUntil: 'domcontentloaded' });
    const rowClassAfterActivate = await page.locator(`tr[data-plugin="${PLUGIN_FILE}"]`).getAttribute('class');
    expect(isPluginActive(rowClassAfterActivate)).toBe(true);

    // --- Verify data is still there (categories preserved) ---
    await page.goto(`${wpBaseURL}/wp-admin/admin.php?page=faz-cookie-manager-cookies`, { waitUntil: 'domcontentloaded' });
    const categoriesAfter = await page.evaluate(async (base) => {
      const nonce = window.fazConfig?.api?.nonce ?? '';
      const res = await fetch(`${base}/?rest_route=/faz/v1/cookies/categories/`, {
        headers: { 'X-WP-Nonce': nonce },
      });
      if (!res.ok) return null;
      return res.json();
    }, wpBaseURL);
    expect(Array.isArray(categoriesAfter)).toBeTruthy();
    // Activation may restore previously-deleted required categories (e.g.
    // wordpress-internal), so the count can be >= the pre-deactivation count.
    expect(categoriesAfter!.length).toBeGreaterThanOrEqual(categoryCountBefore);
    // All slugs that existed before must still be present after reactivation.
    const slugsBefore = new Set(categoriesBefore!.map((c: { slug?: string }) => c.slug).filter(Boolean));
    const slugsAfter  = new Set(categoriesAfter!.map((c: { slug?: string }) => c.slug).filter(Boolean));
    for (const slug of slugsBefore) {
      expect(slugsAfter.has(slug), `Category slug "${slug}" lost after reactivation`).toBe(true);
    }

    // --- Verify admin pages load ---
    await page.goto(`${wpBaseURL}/wp-admin/admin.php?page=faz-cookie-manager`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#wpadminbar')).toBeVisible();

    // --- Verify frontend banner works ---
    // Use the same page — PHP built-in server is single-threaded and can't
    // serve two concurrent requests (admin page + frontend page).
    await page.context().clearCookies();
    await page.goto(wpBaseURL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#fazBannerTemplate')).toBeAttached();
  });

  test('fresh install: deactivate → delete → reinstall works from scratch', async ({
    page, wpBaseURL, loginAsAdmin,
  }) => {
    await loginAsAdmin(page);

    // --- Ensure plugin is present and active first ---
    await ensurePluginActive(page, wpBaseURL);

    // --- Step 1: Deactivate via WP admin ---
    await page.goto(`${wpBaseURL}${PLUGINS_PAGE}`, { waitUntil: 'domcontentloaded' });
    const deactivateLink = page.locator(`tr[data-plugin="${PLUGIN_FILE}"] a[href*="action=deactivate"]`);
    await expect(deactivateLink).toBeVisible();
    await deactivateLink.click();
    await page.waitForLoadState('domcontentloaded');

    // Verify deactivated
    await page.goto(`${wpBaseURL}${PLUGINS_PAGE}`, { waitUntil: 'domcontentloaded' });
    const rowAfterDeactivate = await page.locator(`tr[data-plugin="${PLUGIN_FILE}"]`).getAttribute('class');
    expect(isPluginActive(rowAfterDeactivate)).toBe(false);

    // --- Step 2: Delete plugin files from disk ---
    // This only removes files — it does NOT exercise uninstall.php (which requires
    // WP's filesystem-delete flow and wp-cli). DB tables/options from the previous
    // install will persist, which is intentional: this test verifies the activation
    // hook handles re-activation with pre-existing DB state (the most common
    // real-world upgrade scenario).
    assertSafeDeployPath();
    execFileSync('rm', ['-rf', DEPLOY_PATH], { timeout: 10000 });

    // --- Step 3: Verify plugin is gone ---
    await page.goto(`${wpBaseURL}${PLUGINS_PAGE}`, { waitUntil: 'domcontentloaded' });
    const pluginGone = await page.locator(`tr[data-plugin="${PLUGIN_FILE}"]`).count();
    expect(pluginGone).toBe(0);

    // --- Step 4: Re-deploy plugin files via rsync (simulates upload/install) ---
    execFileSync('rsync', ['-a', '--delete', SOURCE_PATH, DEPLOY_PATH], {
      timeout: 30000,
    });

    // --- Step 5: Verify plugin appears in list (inactive) ---
    await page.goto(`${wpBaseURL}${PLUGINS_PAGE}`, { waitUntil: 'domcontentloaded' });
    const reinstalledRow = page.locator(`tr[data-plugin="${PLUGIN_FILE}"]`);
    await expect(reinstalledRow).toBeVisible();
    const rowClass = await reinstalledRow.getAttribute('class');
    expect(isPluginActive(rowClass)).toBe(false);

    // --- Step 6: Activate ---
    await reinstalledRow.locator('span.activate a').click();
    await page.waitForLoadState('domcontentloaded');

    // Verify activated
    await page.goto(`${wpBaseURL}${PLUGINS_PAGE}`, { waitUntil: 'domcontentloaded' });
    const activatedClass = await page.locator(`tr[data-plugin="${PLUGIN_FILE}"]`).getAttribute('class');
    expect(isPluginActive(activatedClass)).toBe(true);

    // --- Step 7: Verify DB tables created and default categories present ---
    await page.goto(`${wpBaseURL}/wp-admin/admin.php?page=faz-cookie-manager-cookies`, { waitUntil: 'domcontentloaded' });
    const categories = await page.evaluate(async (base) => {
      const nonce = window.fazConfig?.api?.nonce ?? '';
      const res = await fetch(`${base}/?rest_route=/faz/v1/cookies/categories/`, {
        headers: { 'X-WP-Nonce': nonce },
      });
      if (!res.ok) return null;
      return res.json();
    }, wpBaseURL);
    expect(categories).not.toBeNull();
    expect(Array.isArray(categories)).toBeTruthy();

    // Verify all default category slugs from en.json are present
    const slugs = new Set(
      categories!.map((c: { slug?: string }) => c.slug).filter(Boolean),
    );
    for (const expected of [
      'necessary', 'functional', 'analytics', 'performance',
      'uncategorized', 'wordpress-internal', 'marketing',
    ]) {
      expect(slugs.has(expected), `Missing default category: ${expected}`).toBe(true);
    }

    // --- Step 8: Verify admin dashboard loads ---
    await page.goto(`${wpBaseURL}/wp-admin/admin.php?page=faz-cookie-manager`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#wpadminbar')).toBeVisible();

    // --- Step 9: Verify frontend banner works from scratch ---
    await page.context().clearCookies();
    await page.goto(wpBaseURL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#fazBannerTemplate')).toBeAttached();

    // --- Step 10: Verify settings API works ---
    // Re-login since we cleared cookies
    await loginAsAdmin(page);
    await page.goto(`${wpBaseURL}/wp-admin/admin.php?page=faz-cookie-manager-settings`, { waitUntil: 'domcontentloaded' });
    const settingsOk = await page.evaluate(async (base) => {
      const nonce = window.fazConfig?.api?.nonce ?? '';
      const res = await fetch(`${base}/?rest_route=/faz/v1/settings/`, {
        headers: { 'X-WP-Nonce': nonce },
      });
      return res.ok;
    }, wpBaseURL);
    expect(settingsOk).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Deeper lifecycle paths — true fresh install on a clean DB, cross-version
// upgrade, and uninstall.php execution.
//
// The pre-existing "Plugin lifecycle" describe above only covers the
// reactivation-with-pre-existing-data path (the common upgrade case). These
// three tests fill the remaining gaps that historically bit users on slow
// bootstraps (1.13.13 / 1.13.14 Playground crashes — wp_salt() not yet
// available when maybe_create_table() fired) and on the wp.org "first
// install" path where no `wp_faz_*` table or `faz_*` option exists yet.
//
// Each test mutates global plugin state (tables, options, files) and then
// restores it in afterAll so the remaining ~540 tests in the suite see a
// healthy active plugin afterwards.
// ─────────────────────────────────────────────────────────────────────────────

test.describe.serial('Plugin lifecycle — deep paths', () => {
  test.setTimeout(180_000);

  // Snapshots captured in beforeAll, restored in afterAll. Without these,
  // a mid-run failure would leave the test site without the plugin
  // active or with FAZ_VERSION out of sync.
  let snapshotFazVersion = '';
  let snapshotRemoveDataOnUninstall = false;
  let snapshotCookieScriptsMapPresent = false;
  let originalActivePluginsBefore: string[] = [];

  test.beforeAll(() => {
    // Verify wp-cli is reachable before we touch anything.
    if (!WP_PATH) {
      throw new Error('WP_PATH env var is required for deep-lifecycle tests.');
    }
    snapshotFazVersion = wpEval(`echo (string) get_option( 'faz_version', '' );`).trim();
    snapshotRemoveDataOnUninstall = wpEval(`
      $s = get_option( 'faz_settings', array() );
      echo ! empty( $s['general']['remove_data_on_uninstall'] ) ? '1' : '0';
    `).trim() === '1';
    snapshotCookieScriptsMapPresent = wpEval(`echo false !== get_transient( 'faz_cookie_scripts_map' ) ? '1' : '0';`).trim() === '1';
    originalActivePluginsBefore = wp(['plugin', 'list', '--status=active', '--field=name']).split('\n').map((s) => s.trim()).filter(Boolean);
  });

  test.afterAll(() => {
    // Re-install + re-activate so the rest of the suite sees a clean state.
    // execSync — not Playwright — because we may be in a state where the
    // plugin is fully uninstalled (no admin pages, no REST endpoints).
    try {
      execFileSync('rsync', ['-a', '--delete', SOURCE_PATH, DEPLOY_PATH], { timeout: 30000 });
    } catch (_e) { /* best-effort */ }
    try {
      wp(['plugin', 'activate', PLUGIN_SLUG]);
    } catch (_e) { /* may already be active */ }
    // Force-run the activator so DB tables are guaranteed present.
    wpEval(`
      if ( class_exists( '\\\\FazCookie\\\\Includes\\\\Activator' ) ) {
        \\FazCookie\\Includes\\Activator::install();
      }
    `);
    // Restore remove_data_on_uninstall to its pre-test value.
    wpEval(`
      $s = get_option( 'faz_settings', array() );
      if ( ! isset( $s['general'] ) || ! is_array( $s['general'] ) ) { $s['general'] = array(); }
      $s['general']['remove_data_on_uninstall'] = ${snapshotRemoveDataOnUninstall ? 'true' : 'false'};
      update_option( 'faz_settings', $s );
    `);
    // Best-effort restore of the third-party plugin set the suite expects.
    // Don't fail afterAll on a flaky WP-CLI activate (e.g. pixel-manager's
    // activation_redirect timeout).
    for (const plugin of originalActivePluginsBefore) {
      try { wp(['plugin', 'activate', plugin]); } catch (_e) { /* ignore */ }
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. True fresh install — drop every `wp_faz_*` table + delete every
  //    `faz_*` option, then re-run `Activator::install()` and verify the
  //    activator creates the schema from scratch.
  //
  //    This is the wp.org "fresh install on a brand-new WordPress site"
  //    path: no prior tables, no settings, no banner template cache.
  //    The pre-existing "fresh install" test deletes files only, so DB
  //    state survives — masking any "table not yet created" regression.
  //    Caught the 1.13.13/14 Playground crashes were exactly this shape.
  // ───────────────────────────────────────────────────────────────────────────
  test('true fresh install: dropping wp_faz_* tables + faz_* options and re-running Activator::install() creates the schema from scratch', () => {
    // Deactivate the plugin first. Two-process WP-CLI invocations work like
    // this: each `wpEval` spawns a new wp-cli process → WP bootstraps →
    // active plugins fire `plugins_loaded` → controllers that have
    // `maybe_create_table()` on `plugins_loaded` (the 1.13.14 fix) silently
    // recreate the tables we just dropped, before we get a chance to assert
    // they're gone. Deactivating the plugin removes its `plugins_loaded`
    // listeners, so the DROP TABLE actually sticks across wpEval calls.
    wp(['plugin', 'deactivate', PLUGIN_SLUG]);

    // Drop every plugin table + delete every plugin option in one wpEval call.
    // We use $wpdb->query() directly because dbDelta can't drop tables; the
    // operation is intentional and bounded to plugin-prefixed names.
    wpEval(`
      global $wpdb;
      $tables = array( 'banners', 'cookies', 'cookie_categories', 'consent_logs', 'pageviews' );
      foreach ( $tables as $t ) {
        $wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}faz_{$t}" );
      }
      // Clean every faz_* option so Activator runs on an empty slate.
      $opts = $wpdb->get_col( "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE 'faz_%'" );
      foreach ( $opts as $opt ) { delete_option( $opt ); }
      // Clear scripts-map / banner-template transients so the next install
      // can't pick up stale serialised data.
      delete_transient( 'faz_cookie_scripts_map' );
      delete_option( 'faz_banner_template' );
    `);

    // Confirm the slate is actually clean before we run the activator.
    const beforeInstall = JSON.parse(wpEval(`
      global $wpdb;
      $tables = array_map( function( $t ) use ( $wpdb ) { return $wpdb->prefix . 'faz_' . $t; }, array( 'banners', 'cookies', 'cookie_categories', 'consent_logs', 'pageviews' ) );
      $exist = array();
      foreach ( $tables as $t ) {
        $exist[ $t ] = (bool) $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $t ) );
      }
      $opts_count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE 'faz_%'" );
      echo wp_json_encode( array( 'tables' => $exist, 'opts_count' => $opts_count ) );
    `).trim()) as { tables: Record<string, boolean>; opts_count: number };
    for (const [tbl, present] of Object.entries(beforeInstall.tables)) {
      expect(present, `pre-install: ${tbl} must be DROPPED`).toBe(false);
    }
    expect(beforeInstall.opts_count, 'pre-install: no faz_* option must remain').toBe(0);

    // Re-activate via WP-CLI. `plugin activate` triggers the WordPress
    // activation lifecycle: register_activation_hook → Activator::install
    // (which in turn calls install_all_tables, seeds default categories,
    // bumps faz_version, and fires faz_after_activate). This is the
    // canonical "fresh install" code path — same one the wp.org install
    // / Playground / manual upload all hit.
    wp(['plugin', 'activate', PLUGIN_SLUG]);
    const fazVersionAfter = wpEval(`echo (string) get_option( 'faz_version', '' );`).trim();
    expect(fazVersionAfter, 'Activator::install() must bump faz_version').not.toBe('');

    // The constant must match — i.e. the install picked up the CURRENT
    // FAZ_VERSION (not a stale value snuck into the DB).
    const constVersion = wpEval(`echo defined( 'FAZ_VERSION' ) ? FAZ_VERSION : '';`).trim();
    expect(fazVersionAfter, 'faz_version option must match FAZ_VERSION const').toBe(constVersion);

    // Verify every plugin table now exists.
    const afterInstall = JSON.parse(wpEval(`
      global $wpdb;
      $tables = array_map( function( $t ) use ( $wpdb ) { return $wpdb->prefix . 'faz_' . $t; }, array( 'banners', 'cookies', 'cookie_categories', 'consent_logs', 'pageviews' ) );
      $exist = array();
      foreach ( $tables as $t ) {
        $exist[ $t ] = (bool) $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $t ) );
      }
      echo wp_json_encode( $exist );
    `).trim()) as Record<string, boolean>;
    for (const [tbl, present] of Object.entries(afterInstall)) {
      expect(present, `${tbl} must be CREATED by Activator::install()`).toBe(true);
    }

    // Verify the seven canonical default categories are seeded.
    const categories = JSON.parse(wpEval(`
      global $wpdb;
      $rows = $wpdb->get_col( "SELECT slug FROM {$wpdb->prefix}faz_cookie_categories" );
      echo wp_json_encode( $rows );
    `).trim()) as string[];
    for (const expected of ['necessary', 'functional', 'analytics', 'performance', 'uncategorized', 'wordpress-internal', 'marketing']) {
      expect(categories, `default category ${expected} must be seeded`).toContain(expected);
    }

    // Verify settings exist with a default banner_control.status.
    const settingsShape = wpEval(`
      $s = get_option( 'faz_settings', null );
      echo is_array( $s ) && isset( $s['banner_control'] ) ? 'ok' : 'fail';
    `).trim();
    expect(settingsShape, 'faz_settings must be seeded with a banner_control section').toBe('ok');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Cross-version upgrade — set faz_version to an older version, then
  //    call `Activator::check_version()` (the hook that runs on every
  //    admin request and detects a version skew). The check must trigger
  //    `Activator::install()`, which bumps `faz_version` to the current
  //    `FAZ_VERSION` constant. Pre-existing data must survive intact.
  // ───────────────────────────────────────────────────────────────────────────
  test('cross-version upgrade: setting faz_version to 1.12.0 triggers check_version → install on the next admin request', () => {
    // Everything happens inside ONE wpEval. Two reasons:
    //
    // 1. `Activator::init()` registers `check_version` on the `init` hook
    //    with priority 5 (see class-activator.php). The hook fires on
    //    every WordPress bootstrap — including the one wp-cli does to
    //    run a second wpEval. If we set faz_version=1.12.0 in one call
    //    and read it back in a second, the second's `init` hook detects
    //    the version skew, runs install(), and bumps the option BEFORE
    //    our read can see the stale value — we'd never get to assert
    //    on `1.12.0`.
    //
    // 2. The test is fundamentally about state-flow inside one request,
    //    so collapsing everything inline mirrors the real-world boot
    //    order: set option → bootstrap hooks see skew → install() runs
    //    → option bumped.
    //
    // The PHP script:
    //   a. captures the FAZ_VERSION const + current category count + adds
    //      a marker category row (proves user data survives the migration)
    //   b. writes faz_version=1.12.0
    //   c. captures the "before" state to prove we set the stale value
    //   d. calls Activator::check_version() (same path the init hook uses)
    //   e. captures the "after" state
    //   f. cleans up the marker row
    //   g. calls check_version() once more to assert idempotence
    //   h. emits JSON for the TS assertions
    const markerCategorySlug = '_faz_e2e_upgrade_marker';
    const out = wpEval(`
      global $wpdb;
      $current_const = defined( 'FAZ_VERSION' ) ? FAZ_VERSION : '';
      $cats_before = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}faz_cookie_categories" );
      $wpdb->insert(
        $wpdb->prefix . 'faz_cookie_categories',
        array( 'name' => 'E2E Upgrade Marker', 'slug' => '${markerCategorySlug}' ),
        array( '%s', '%s' )
      );

      update_option( 'faz_version', '1.12.0' );
      $stale = (string) get_option( 'faz_version' );

      \\FazCookie\\Includes\\Activator::check_version();
      $upgraded = (string) get_option( 'faz_version' );
      $cats_total_after = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}faz_cookie_categories" );
      $marker_count = (int) $wpdb->get_var( $wpdb->prepare(
        "SELECT COUNT(*) FROM {$wpdb->prefix}faz_cookie_categories WHERE slug = %s",
        '${markerCategorySlug}'
      ) );

      // Clean up the marker before asserting so the next test runs on
      // the same default-seed shape it started with.
      $wpdb->delete(
        $wpdb->prefix . 'faz_cookie_categories',
        array( 'slug' => '${markerCategorySlug}' ),
        array( '%s' )
      );

      // Idempotence — second call must NOT change faz_version.
      \\FazCookie\\Includes\\Activator::check_version();
      $idempotent_after = (string) get_option( 'faz_version' );

      echo wp_json_encode( array(
        'current_const'       => $current_const,
        'cats_before'         => $cats_before,
        'stale'               => $stale,
        'upgraded'            => $upgraded,
        'cats_total_after'    => $cats_total_after,
        'marker_count'        => $marker_count,
        'idempotent_after'    => $idempotent_after,
      ) );
    `).trim();

    const r = JSON.parse(out) as {
      current_const: string;
      cats_before: number;
      stale: string;
      upgraded: string;
      cats_total_after: number;
      marker_count: number;
      idempotent_after: string;
    };

    expect(r.current_const, 'FAZ_VERSION const must be defined').not.toBe('');
    expect(r.cats_before, 'pre-condition: default categories must exist').toBeGreaterThan(0);
    expect(r.stale, 'pre-condition: faz_version must be the stale value before check_version()').toBe('1.12.0');
    expect(r.upgraded, 'cross-version upgrade must bump faz_version to FAZ_VERSION').toBe(r.current_const);
    expect(r.marker_count, 'user-created category must survive the upgrade migration').toBe(1);
    expect(r.cats_total_after, 'category count must stay >= pre-upgrade (defaults may be re-ensured)').toBeGreaterThanOrEqual(r.cats_before + 1);
    expect(r.idempotent_after, 'check_version() must be idempotent at FAZ_VERSION').toBe(r.current_const);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. uninstall.php execution — flip `remove_data_on_uninstall` to true,
  //    run `wp plugin uninstall faz-cookie-manager`, and verify every
  //    `wp_faz_*` table is dropped and every `faz_*` option is deleted.
  //    The afterAll above re-installs the plugin so the rest of the suite
  //    sees a clean active state.
  // ───────────────────────────────────────────────────────────────────────────
  test('uninstall.php with remove_data_on_uninstall=true drops every wp_faz_* table and deletes every faz_* option', () => {
    // Ensure the plugin is currently active. uninstall.php runs only when
    // WP-CLI's `plugin uninstall` is invoked on a deactivated plugin
    // (WP guards against uninstall of active plugins). The default state
    // at the start of this describe is "active and installed".
    const stateBefore = JSON.parse(wpEval(`
      global $wpdb;
      $tables = array_map( function( $t ) use ( $wpdb ) { return $wpdb->prefix . 'faz_' . $t; }, array( 'banners', 'cookies', 'cookie_categories', 'consent_logs', 'pageviews' ) );
      $exist = array();
      foreach ( $tables as $t ) {
        $exist[ $t ] = (bool) $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $t ) );
      }
      $opts_count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE 'faz_%'" );
      echo wp_json_encode( array( 'tables' => $exist, 'opts_count' => $opts_count ) );
    `).trim()) as { tables: Record<string, boolean>; opts_count: number };
    for (const [tbl, present] of Object.entries(stateBefore.tables)) {
      expect(present, `pre-uninstall: ${tbl} must exist`).toBe(true);
    }
    expect(stateBefore.opts_count, 'pre-uninstall: faz_* options must exist').toBeGreaterThan(0);

    // Flip the opt-in. Default is false (per `class-settings.php`) which is
    // why the wp.org submission spec requires explicit consent for cleanup.
    wpEval(`
      $s = get_option( 'faz_settings', array() );
      if ( ! isset( $s['general'] ) || ! is_array( $s['general'] ) ) { $s['general'] = array(); }
      $s['general']['remove_data_on_uninstall'] = true;
      update_option( 'faz_settings', $s );
    `);

    // Deactivate via WP-CLI, then uninstall. wp-cli's `plugin uninstall`
    // runs uninstall.php in the same PHP process so all option-delete /
    // table-drop calls land before we read the DB state.
    wp(['plugin', 'deactivate', PLUGIN_SLUG]);
    wp(['plugin', 'uninstall', PLUGIN_SLUG, '--skip-delete']);
    // `--skip-delete` keeps the files on disk so the afterAll re-rsync
    // doesn't have to re-clone the source — the goal of THIS test is the
    // DB-side uninstall.php side-effects, not file removal (which the
    // pre-existing "fresh install" test already covers).

    // Verify every plugin table is gone.
    const stateAfter = JSON.parse(wpEval(`
      global $wpdb;
      $tables = array_map( function( $t ) use ( $wpdb ) { return $wpdb->prefix . 'faz_' . $t; }, array( 'banners', 'cookies', 'cookie_categories', 'consent_logs', 'pageviews' ) );
      $exist = array();
      foreach ( $tables as $t ) {
        $exist[ $t ] = (bool) $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $t ) );
      }
      $opts_count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE 'faz_%'" );
      // Locks created by Do_Not_Sell_Shortcode / DSAR_Shortcode also live
      // as options, so they must be gone too.
      $lock_count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE 'faz_dnsmpi_%' OR option_name LIKE 'faz_dsar_%'" );
      echo wp_json_encode( array( 'tables' => $exist, 'opts_count' => $opts_count, 'lock_count' => $lock_count ) );
    `).trim()) as { tables: Record<string, boolean>; opts_count: number; lock_count: number };

    for (const [tbl, present] of Object.entries(stateAfter.tables)) {
      expect(present, `post-uninstall: ${tbl} must be DROPPED`).toBe(false);
    }
    expect(stateAfter.opts_count, 'post-uninstall: every faz_* option must be deleted').toBe(0);
    expect(stateAfter.lock_count, 'post-uninstall: DNSMPI / DSAR rate-limit locks must be cleaned up').toBe(0);
  });
});
