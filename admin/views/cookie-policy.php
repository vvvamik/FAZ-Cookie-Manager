<?php
/**
 * Admin view — Cookie Policy generator (Spec 002 FR-02).
 *
 * Server-renders the page skeleton + nonces. All dynamic data (form
 * fields, preview render) flows through REST faz/v1/cookie-policy/*
 * driven by admin/assets/js/pages/cookie-policy.js.
 *
 * @package FazCookie\Admin\Views
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$rest_nonce = wp_create_nonce( 'wp_rest' );
$rest_url   = esc_url( rest_url( 'faz/v1/cookie-policy/' ) );
?>
<div class="wrap faz-admin-page faz-cookie-policy-page" id="faz-cookie-policy-app"
     data-faz-rest-url="<?php echo esc_url( $rest_url ); ?>"
     data-faz-rest-nonce="<?php echo esc_attr( $rest_nonce ); ?>">

	<h1><?php esc_html_e( 'Cookie Policy', 'faz-cookie-manager' ); ?></h1>
	<p class="faz-page-intro">
		<?php esc_html_e( 'Generate a jurisdiction-aware Cookie Policy from a template scaffold. Fill in your company details below, choose a jurisdiction, and embed the policy in any WordPress page via the shortcode [faz_cookie_policy]. Templates are starting points, not legal advice — the disclaimer at the bottom of every generated policy makes this explicit.', 'faz-cookie-manager' ); ?>
	</p>

	<form id="faz-cookie-policy-form" novalidate>

		<section class="faz-cp-section">
			<h2><?php esc_html_e( '1. Company details', 'faz-cookie-manager' ); ?></h2>
			<p>
				<label for="cp-company-name"><?php esc_html_e( 'Legal entity name', 'faz-cookie-manager' ); ?></label><br>
				<input type="text" id="cp-company-name" name="company.name" class="regular-text" required>
			</p>
			<p>
				<label for="cp-company-address"><?php esc_html_e( 'Postal address', 'faz-cookie-manager' ); ?></label><br>
				<textarea id="cp-company-address" name="company.address" rows="2" cols="60"></textarea>
			</p>
			<p>
				<label for="cp-company-email"><?php esc_html_e( 'Privacy contact email', 'faz-cookie-manager' ); ?></label><br>
				<input type="email" id="cp-company-email" name="company.email" class="regular-text" required>
			</p>
			<p>
				<label for="cp-company-registry"><?php esc_html_e( 'Registry / VAT / CNPJ (optional)', 'faz-cookie-manager' ); ?></label><br>
				<input type="text" id="cp-company-registry" name="company.registry" class="regular-text">
			</p>
		</section>

		<section class="faz-cp-section">
			<h2><?php esc_html_e( '2. Privacy officer', 'faz-cookie-manager' ); ?></h2>
			<p>
				<label for="cp-dpo-name"><?php esc_html_e( 'DPO / Encarregado / Privacy Officer name', 'faz-cookie-manager' ); ?></label><br>
				<input type="text" id="cp-dpo-name" name="dpo.name" class="regular-text">
			</p>
			<p>
				<label for="cp-dpo-email"><?php esc_html_e( 'DPO email', 'faz-cookie-manager' ); ?></label><br>
				<input type="email" id="cp-dpo-email" name="dpo.email" class="regular-text">
				<span class="description"><?php esc_html_e( 'Mandatory for LGPD (Art. 41) and recommended for GDPR.', 'faz-cookie-manager' ); ?></span>
			</p>
		</section>

		<section class="faz-cp-section">
			<h2><?php esc_html_e( '3. Jurisdiction', 'faz-cookie-manager' ); ?></h2>
			<p>
				<label for="cp-jurisdiction"><?php esc_html_e( 'Primary jurisdiction', 'faz-cookie-manager' ); ?></label><br>
				<select id="cp-jurisdiction" name="jurisdiction">
					<option value="gdpr-strict"><?php esc_html_e( 'GDPR (EU / EEA / UK)', 'faz-cookie-manager' ); ?></option>
					<option value="ccpa-california"><?php esc_html_e( 'CCPA / CPRA (California, USA)', 'faz-cookie-manager' ); ?></option>
					<option value="lgpd-brazil"><?php esc_html_e( 'LGPD (Brazil)', 'faz-cookie-manager' ); ?></option>
				</select>
				<span class="description"><?php esc_html_e( 'Override per shortcode call with [faz_cookie_policy jurisdiction="..."]', 'faz-cookie-manager' ); ?></span>
			</p>
		</section>

		<section class="faz-cp-section">
			<h2><?php esc_html_e( '4. Third-party services', 'faz-cookie-manager' ); ?></h2>
			<p><?php esc_html_e( 'Tick the services that load on your site so the policy can name them.', 'faz-cookie-manager' ); ?></p>
			<div id="cp-services-list"></div>
		</section>

		<section class="faz-cp-section">
			<h2><?php esc_html_e( '5. Cookies on this site', 'faz-cookie-manager' ); ?></h2>
			<p class="description">
				<?php
				echo wp_kses_post(
					sprintf(
						/* translators: %s: URL of the Cookies admin page */
						__( 'The cookie list is auto-populated from the <a href="%s">Cookies admin page</a>. Add or scan cookies there; the generator reads the latest snapshot at render time.', 'faz-cookie-manager' ),
						esc_url( admin_url( 'admin.php?page=faz-cookie-manager-cookies' ) )
					)
				);
				?>
			</p>
		</section>

		<section class="faz-cp-section">
			<h2><?php esc_html_e( '6. Retention', 'faz-cookie-manager' ); ?></h2>
			<p>
				<label for="cp-retention-months"><?php esc_html_e( 'Default retention period (months)', 'faz-cookie-manager' ); ?></label><br>
				<input type="number" id="cp-retention-months" name="retention_months" min="1" max="120" step="1" value="12">
			</p>
			<p>
				<label for="cp-privacy-policy-url"><?php esc_html_e( 'Separate Privacy Policy URL (optional)', 'faz-cookie-manager' ); ?></label><br>
				<input type="url" id="cp-privacy-policy-url" name="privacy_policy_url" class="regular-text">
			</p>
		</section>

		<section class="faz-cp-section">
			<h2><?php esc_html_e( '7. Default language', 'faz-cookie-manager' ); ?></h2>
			<p>
				<label for="cp-default-lang"><?php esc_html_e( 'Force a specific language (otherwise follows visitor locale)', 'faz-cookie-manager' ); ?></label><br>
				<select id="cp-default-lang" name="default_lang">
					<option value=""><?php esc_html_e( 'Follow visitor locale (recommended)', 'faz-cookie-manager' ); ?></option>
					<option value="en">English</option>
					<option value="it">Italiano</option>
					<option value="fr">Français</option>
					<option value="de">Deutsch</option>
					<option value="es">Español</option>
					<option value="pt-BR">Português (Brasil)</option>
				</select>
			</p>
		</section>

		<p>
			<button type="submit" class="button button-primary"><?php esc_html_e( 'Save settings', 'faz-cookie-manager' ); ?></button>
			<button type="button" id="cp-preview-btn" class="button"><?php esc_html_e( 'Preview', 'faz-cookie-manager' ); ?></button>
			<span id="cp-save-status" class="description"></span>
		</p>

	</form>

	<section class="faz-cp-section">
		<h2><?php esc_html_e( 'Embed shortcode', 'faz-cookie-manager' ); ?></h2>
		<p><?php esc_html_e( 'Paste this on any page or post:', 'faz-cookie-manager' ); ?></p>
		<p><code>[faz_cookie_policy]</code></p>
		<p><?php esc_html_e( 'With explicit language or jurisdiction:', 'faz-cookie-manager' ); ?></p>
		<p>
			<code>[faz_cookie_policy lang="it"]</code><br>
			<code>[faz_cookie_policy jurisdiction="ccpa-california"]</code><br>
			<code>[faz_cookie_policy lang="pt-BR" jurisdiction="lgpd-brazil"]</code>
		</p>
	</section>

	<div id="cp-preview-modal" class="faz-cp-modal" hidden>
		<div class="faz-cp-modal-inner">
			<button type="button" class="faz-cp-modal-close" aria-label="<?php esc_attr_e( 'Close preview', 'faz-cookie-manager' ); ?>">&times;</button>
			<div id="cp-preview-content"></div>
		</div>
	</div>

</div>

<style>
.faz-cookie-policy-page { max-width: 900px; }
.faz-cp-section { background:#fff; border:1px solid #ccd0d4; border-radius:4px; padding:18px 22px; margin-bottom:18px; }
.faz-cp-section h2 { margin-top: 0; }
.faz-cp-modal { position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:99999; display:flex; align-items:center; justify-content:center; padding:24px; }
.faz-cp-modal[hidden] { display:none; }
.faz-cp-modal-inner { background:#fff; border-radius:6px; max-width:820px; width:100%; max-height:88vh; overflow:auto; position:relative; padding:24px; }
.faz-cp-modal-close { position:absolute; top:8px; right:14px; background:none; border:none; font-size:28px; cursor:pointer; }
.faz-cookie-policy article.faz-cookie-policy h1,
#cp-preview-content article.faz-cookie-policy h1 { margin-top: 0; }
.faz-cookie-policy-disclaimer { margin-top: 32px; padding:14px 16px; background:#fff5d6; border-left:3px solid #d4a017; font-size:13px; }
</style>
