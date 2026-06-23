<?php
/**
 * Standalone unit tests for "Cache Compatibility Mode" (issue #158).
 *
 * Subsystem: cache-compatibility-php
 *
 * Covers the two server-side seams the feature touches:
 *   - Settings::sanitize_option(): banner_control.cache_compatibility is a plain
 *     boolean (string/int inputs coerce), so a settings PUT can't smuggle a
 *     non-bool into the option.
 *   - Frontend::is_country_dependent_output(): when the toggle is ON it
 *     SHORT-CIRCUITS to false, so send_geo_cache_headers() emits no no-cache /
 *     no-store headers and maybe_disable_country_page_cache() never defines
 *     DONOTCACHEPAGE — even when IAB TCF or geo-targeting would otherwise force
 *     the page country-dependent. The OFF path is unchanged (still country-aware).
 *
 * Pure-logic tests: no browser, DB, or live WordPress. Settings::sanitize is
 * static; the Frontend object is built with newInstanceWithoutConstructor() and
 * its private settings cache is seeded via reflection (so get_option is never
 * touched), then is_country_dependent_output() is invoked via reflection. The
 * Controller / Geo_Runtime collaborators are stubbed so the OFF path is reachable
 * without a live install. The end-to-end header behaviour is asserted by
 * tests/e2e/specs/cache-compatibility-mode.spec.ts.
 *
 * Run from project root:
 *   php tests/unit/test-cache-compatibility-php.php
 *
 * @package FazCookie\Tests\Unit
 */

namespace FazCookie\Includes {
	class Store {}
	class Known_Providers {
		public static function get_all() {
			return array();
		}
		public static function get_cookie_map() {
			return array();
		}
		public static function get_pattern_map() {
			return array();
		}
	}
}

namespace FazCookie\Frontend\Includes {
	// Stub so the OFF path (which calls Geo_Runtime::is_enabled()) is reachable.
	class Geo_Runtime {
		public static $enabled = false;
		public static function is_enabled() {
			return self::$enabled;
		}
	}
}

namespace FazCookie\Admin\Modules\Banners\Includes {
	// Stub so the OFF path (which calls Controller::get_instance()
	// ->has_country_dependent_banners()) is reachable without a DB.
	class Controller {
		public static $countryDependent = false;
		private static $instance        = null;
		public static function get_instance() {
			if ( null === self::$instance ) {
				self::$instance = new self();
			}
			return self::$instance;
		}
		public function has_country_dependent_banners() {
			return self::$countryDependent;
		}
	}
}

namespace {

	if ( ! defined( 'ABSPATH' ) ) {
		define( 'ABSPATH', __DIR__ . '/' );
	}
	if ( ! defined( 'HOUR_IN_SECONDS' ) ) {
		define( 'HOUR_IN_SECONDS', 3600 );
	}

	if ( ! function_exists( 'faz_sanitize_bool' ) ) {
		function faz_sanitize_bool( $value ) {
			return filter_var( $value, FILTER_VALIDATE_BOOLEAN );
		}
	}
	if ( ! function_exists( 'wp_strip_all_tags' ) ) {
		function wp_strip_all_tags( $str ) {
			return trim( preg_replace( '/<[^>]*>/', '', (string) $str ) );
		}
	}
	if ( ! function_exists( 'sanitize_text_field' ) ) {
		function sanitize_text_field( $str ) {
			return trim( wp_strip_all_tags( (string) $str ) );
		}
	}
	if ( ! function_exists( 'sanitize_key' ) ) {
		function sanitize_key( $key ) {
			return preg_replace( '/[^a-z0-9_\-]/', '', strtolower( (string) $key ) );
		}
	}
	if ( ! function_exists( 'apply_filters' ) ) {
		// Passthrough: returns the unfiltered value (no hooks in unit context).
		function apply_filters( $tag, $value ) {
			return $value;
		}
	}

	if ( ! class_exists( 'FazTest_WPDB' ) ) {
		class FazTest_WPDB {
			public $prefix = 'wp_';
			public function get_col( $query ) {
				return array();
			}
		}
	}
	$GLOBALS['wpdb'] = new FazTest_WPDB();

	require_once dirname( __DIR__, 2 ) . '/admin/modules/settings/includes/class-settings.php';
	require_once dirname( __DIR__, 2 ) . '/frontend/class-frontend.php';

	use FazCookie\Admin\Modules\Settings\Includes\Settings;
	use FazCookie\Frontend\Frontend;

	$tests_run = $tests_passed = $tests_failed = 0;
	function assert_eq( $actual, $expected, $label ) {
		global $tests_run, $tests_passed, $tests_failed;
		$tests_run++;
		if ( $actual === $expected ) {
			$tests_passed++;
			echo "  \033[32m✓\033[0m $label\n";
		} else {
			$tests_failed++;
			echo "  \033[31m✗\033[0m $label\n";
			echo '      expected: ' . var_export( $expected, true ) . "\n";
			echo '      actual:   ' . var_export( $actual, true ) . "\n";
		}
	}

	/** is_country_dependent_output() with a reflection-seeded settings cache. */
	function faz_is_dependent( array $settings ) {
		$rc = new ReflectionClass( Frontend::class );
		$fe = $rc->newInstanceWithoutConstructor();
		$p  = new ReflectionProperty( Frontend::class, 'settings_option_cache' );
		$p->setAccessible( true );
		$p->setValue( $fe, $settings );
		$m = new ReflectionMethod( Frontend::class, 'is_country_dependent_output' );
		$m->setAccessible( true );
		return (bool) $m->invoke( $fe );
	}

	echo "\n\033[1mCache Compatibility Mode (issue #158)\033[0m\n\n";

	// ---------------------------------------------------------------------
	// Settings::sanitize_option(): cache_compatibility is a clean boolean.
	// ---------------------------------------------------------------------
	echo "Settings::sanitize (cache_compatibility)\n";
	$defaults = array( 'banner_control' => array( 'cache_compatibility' => false ) );
	$san      = function ( $raw ) use ( $defaults ) {
		$out = Settings::sanitize( array( 'banner_control' => array( 'cache_compatibility' => $raw ) ), $defaults );
		return $out['banner_control']['cache_compatibility'];
	};
	assert_eq( $san( 'true' ), true, "string 'true' coerces to bool true" );
	assert_eq( $san( '1' ), true, "string '1' coerces to bool true" );
	assert_eq( $san( true ), true, 'bool true stays true' );
	assert_eq( $san( '0' ), false, "string '0' coerces to bool false" );
	assert_eq( $san( '' ), false, 'empty string coerces to bool false' );
	assert_eq( $san( false ), false, 'bool false stays false' );

	// ---------------------------------------------------------------------
	// Frontend::is_country_dependent_output(): ON short-circuits to false.
	// ---------------------------------------------------------------------
	echo "\nFrontend::is_country_dependent_output()\n";

	// ON → always cacheable, regardless of other triggers.
	assert_eq(
		faz_is_dependent( array( 'banner_control' => array( 'cache_compatibility' => true ) ) ),
		false,
		'cache_compatibility ON → not country-dependent (cacheable)'
	);
	assert_eq(
		faz_is_dependent( array(
			'banner_control' => array( 'cache_compatibility' => true ),
			'iab'            => array( 'enabled' => true ),
		) ),
		false,
		'cache_compatibility ON overrides IAB TCF → still cacheable'
	);
	assert_eq(
		faz_is_dependent( array(
			'banner_control' => array( 'cache_compatibility' => true ),
			'geolocation'    => array( 'geo_targeting' => true, 'default_behavior' => 'no_banner' ),
		) ),
		false,
		'cache_compatibility ON overrides geo-targeting no_banner → still cacheable'
	);
	assert_eq(
		faz_is_dependent( array( 'banner_control' => array( 'cache_compatibility' => '1' ) ) ),
		false,
		"truthy '1' value is honoured by the !empty() short-circuit"
	);

	// OFF (or absent) → unchanged behaviour: country-dependent only when a
	// real trigger is active. Controller + Geo_Runtime stubs report "no".
	\FazCookie\Admin\Modules\Banners\Includes\Controller::$countryDependent = false;
	\FazCookie\Frontend\Includes\Geo_Runtime::$enabled                              = false;
	assert_eq(
		faz_is_dependent( array( 'banner_control' => array( 'cache_compatibility' => false ) ) ),
		false,
		'OFF + no trigger → not country-dependent'
	);
	assert_eq(
		faz_is_dependent( array(
			'banner_control' => array( 'cache_compatibility' => false ),
			'iab'            => array( 'enabled' => true ),
		) ),
		true,
		'OFF + IAB enabled → country-dependent (cache-bust active, unchanged)'
	);
	assert_eq(
		faz_is_dependent( array() ),
		false,
		'absent cache_compatibility key + no trigger → not country-dependent'
	);

	echo "\n";
	if ( $tests_failed > 0 ) {
		echo "\033[31m✗ {$tests_failed} failed\033[0m, {$tests_passed} passed ({$tests_run} total)\n";
		exit( 1 );
	}
	echo "\033[32m✓ all {$tests_passed} passed\033[0m ({$tests_run} total)\n";
	exit( 0 );
}
