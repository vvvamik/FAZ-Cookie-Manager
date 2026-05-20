<?php
/**
 * Module bootstrap for Cookie Policy Generator (Spec 002).
 *
 * Singleton; registers:
 *  - the `[faz_cookie_policy]` shortcode (frontend, FR-03)
 *  - the admin menu entry "Cookie Policy" (via class-admin.php hook)
 *  - the REST endpoints under faz/v1/cookie-policy/*  (admin form)
 *
 * @package FazCookie\Admin\Modules\Cookie_Policy_Generator
 * @since   1.16.0
 */

namespace FazCookie\Admin\Modules\Cookie_Policy_Generator;

use FazCookie\Admin\Modules\Cookie_Policy_Generator\Includes\Renderer;
use FazCookie\Admin\Modules\Cookie_Policy_Generator\Api\Cookie_Policy_Api;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * @class Cookie_Policy_Generator
 * @since 1.16.0
 */
class Cookie_Policy_Generator {

	const SHORTCODE = 'faz_cookie_policy';

	/**
	 * @var self|null
	 */
	private static $instance = null;

	/**
	 * @return self
	 */
	public static function get_instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Wire shortcode + REST API into WordPress.
	 *
	 * Called once from the main plugin bootstrap (faz-cookie-manager.php).
	 *
	 * @return void
	 */
	public function init() {
		add_shortcode( self::SHORTCODE, array( $this, 'render_shortcode' ) );
		// Also register the REST endpoints.
		Cookie_Policy_Api::get_instance()->init();
	}

	/**
	 * `[faz_cookie_policy]` shortcode callback.
	 *
	 * Attributes:
	 *   - lang         (en, it, fr, de, es, pt-BR) — override visitor locale
	 *   - jurisdiction (gdpr-strict, ccpa-california, lgpd-brazil)
	 *
	 * Both are optional. Without them the renderer falls back to WP get_locale
	 * + admin default jurisdiction.
	 *
	 * @param array<string,string> $atts Raw attributes from WP shortcode parser.
	 * @return string HTML.
	 */
	public function render_shortcode( $atts ) {
		$atts = shortcode_atts(
			array(
				'lang'         => '',
				'jurisdiction' => '',
			),
			(array) $atts,
			self::SHORTCODE
		);
		return Renderer::render( $atts );
	}
}
