<?php
/**
 * Cookie Settings Shortcode — [faz_cookie_settings]
 *
 * Renders a button that re-opens the consent preference center, so visitors can
 * change their choices from anywhere on the site (e.g. inside the generated
 * cookie policy). The CookieYes equivalent is [cookie_settings].
 *
 * The button carries `data-faz-open-preferences` and the `faz-cookie-settings-btn`
 * class; the frontend script (script.js) binds a delegated click handler that
 * calls the same preference-center opener the banner's "settings" button uses.
 * No inline JS and no extra asset — it relies on the banner script that is
 * already enqueued on the front end.
 *
 * Attributes:
 *   - text  (string) custom button label (default: localized "Manage consent preferences")
 *   - class (string) extra CSS classes (sanitized)
 *
 * @package FazCookie\Includes
 */

namespace FazCookie\Includes;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Cookie_Settings_Shortcode {

	/**
	 * Register the shortcode.
	 */
	public function __construct() {
		add_shortcode( 'faz_cookie_settings', array( $this, 'render' ) );
	}

	/**
	 * Render the "manage consent" button.
	 *
	 * @param array<string,string>|string $atts Shortcode attributes.
	 * @return string Button HTML.
	 */
	public function render( $atts ) {
		$atts = shortcode_atts(
			array(
				'text'  => '',
				'class' => '',
			),
			(array) $atts,
			'faz_cookie_settings'
		);

		$label = '' !== trim( (string) $atts['text'] )
			? sanitize_text_field( $atts['text'] )
			: __( 'Manage consent preferences', 'faz-cookie-manager' );

		// Whitelist extra classes (sanitize_html_class drops anything unsafe).
		$classes = array( 'faz-cookie-settings-btn' );
		foreach ( preg_split( '/\s+/', (string) $atts['class'] ) as $candidate ) {
			$clean = sanitize_html_class( (string) $candidate );
			if ( '' !== $clean ) {
				$classes[] = $clean;
			}
		}

		return sprintf(
			'<button type="button" class="%s" data-faz-open-preferences="1">%s</button>',
			esc_attr( implode( ' ', $classes ) ),
			esc_html( $label )
		);
	}
}
