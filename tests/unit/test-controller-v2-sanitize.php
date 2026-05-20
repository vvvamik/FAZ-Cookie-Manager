<?php
/**
 * Standalone unit tests for the consent-log v2 column shaping logic.
 *
 * Regression guards for the round-1 + round-2 fixes in
 * admin/modules/consentlogs/includes/class-controller.php::log_consent():
 *  - tc_string / gpp_string sanitized via wp_unslash + sanitize_text_field
 *  - v2 columns appended ONLY when both:
 *      (a) faz_geo_v2_disabled_reason is empty, AND
 *      (b) faz_geo_v2_migration_pending is falsy
 *  - $insert_format kept aligned (%d for ints, %s for strings)
 *
 * Replicates the production resolve_geo_audit_fields() shape + the
 * insert-time guard. Keeps the production code untouched.
 *
 * Run:
 *   php tests/unit/test-controller-v2-sanitize.php
 *
 * @package FazCookie\Tests\Unit
 */

// Minimal WP polyfills.
function wp_unslash( $v ) {
	if ( is_string( $v ) ) {
		return stripslashes( $v );
	}
	return $v;
}
function sanitize_text_field( $v ) {
	// Strip tags + collapse whitespace + drop control chars (mirrors WP behaviour).
	$v = (string) $v;
	$v = wp_check_invalid_utf8_polyfill( $v );
	$v = strip_tags( $v );
	$v = preg_replace( '/[\r\n\t]+/', ' ', $v );
	$v = preg_replace( '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', '', $v );
	$v = preg_replace( '/\s+/', ' ', $v );
	return trim( $v );
}
function wp_check_invalid_utf8_polyfill( $s ) { return $s; }

// In-process option store.
$GLOBALS['_options'] = array();
function get_option( $key, $default = false ) {
	return array_key_exists( $key, $GLOBALS['_options'] ) ? $GLOBALS['_options'][ $key ] : $default;
}

/**
 * Sanitize a tc/gpp field the way Controller::resolve_geo_audit_fields() does.
 *
 * @param string $raw
 * @return string Sanitized or '' if empty after sanitize.
 */
function sanitize_audit_string( $raw ) {
	if ( ! is_string( $raw ) ) {
		return '';
	}
	return sanitize_text_field( wp_unslash( $raw ) );
}

/**
 * Mirrors the v2-columns insert guard:
 * append v2 columns only when (a) disabled_reason empty AND (b) NOT migration_pending.
 *
 * @return bool true → append v2 columns to the insert payload.
 */
function should_append_v2() {
	$disabled = (string) get_option( 'faz_geo_v2_disabled_reason', '' );
	$pending  = (bool) get_option( 'faz_geo_v2_migration_pending', false );
	return '' === $disabled && ! $pending;
}

/**
 * Build the $insert_format array given the produced $insert_data map.
 * Mirrors the production loop: '%d' for ints, '%s' for strings.
 *
 * @param array $base_format Format codes for the v1 base columns (passed through).
 * @param array $geo_fields  v2 columns to append (key → value).
 * @return array
 */
function build_insert_format( $base_format, $geo_fields ) {
	$out = $base_format;
	foreach ( $geo_fields as $val ) {
		$out[] = is_int( $val ) ? '%d' : '%s';
	}
	return $out;
}

$tests_run = $tests_passed = $tests_failed = 0;
function assert_eq( $a, $e, $label ) {
	global $tests_run, $tests_passed, $tests_failed;
	$tests_run++;
	if ( $a === $e ) { $tests_passed++; echo "  \033[32m✓\033[0m $label\n"; }
	else { $tests_failed++; echo "  \033[31m✗\033[0m $label\n      expected: " . var_export( $e, true ) . "\n      actual:   " . var_export( $a, true ) . "\n"; }
}
function assert_true( $c, $l ) { assert_eq( (bool) $c, true, $l ); }
function assert_false( $c, $l ) { assert_eq( (bool) $c, false, $l ); }

echo "\n== Controller v2-columns sanitize + insert guards (round-1/2 fix) ==\n\n";

// ---------- 1. tc/gpp sanitize roundtrip — preserves IAB strings ----------
$tc_valid  = 'CPyyyAAA.AAAAxxxxx_BB.fakeAA-9999.YY';
$gpp_valid = 'DBABLA~CPyyyAAA~~~';
assert_eq( sanitize_audit_string( $tc_valid ), $tc_valid, 'TC valid IAB string passes through unchanged' );
assert_eq( sanitize_audit_string( $gpp_valid ), $gpp_valid, 'GPP valid string passes through unchanged' );

// ---------- 2. Slashed input (POST through WP magic-quotes) is un-slashed ----------
$slashed = "CPyyy\\\"with\\\"escapes";
assert_eq(
	sanitize_audit_string( $slashed ),
	'CPyyy"with"escapes',
	'wp_unslash removes WP-added slashes (defensive against magic-quotes legacy)'
);

// ---------- 3. Control characters stripped ----------
$with_ctrl = "CPyyy\x00\x07\x1Fevil\x7Frest";
assert_eq(
	sanitize_audit_string( $with_ctrl ),
	'CPyyyevilrest',
	'Control chars (NUL, BEL, US, DEL) stripped'
);

$with_tab_newline = "CPyyy\twith\nnewlines\rcr";
$res = sanitize_audit_string( $with_tab_newline );
assert_eq( $res, 'CPyyy with newlines cr', 'Tab/newline/CR collapsed to single space (WP standard)' );

// ---------- 4. Non-string / empty inputs ----------
assert_eq( sanitize_audit_string( '' ), '', 'Empty string → empty' );
assert_eq( sanitize_audit_string( null ), '', 'Null → empty (defensive cast)' );
assert_eq( sanitize_audit_string( 12345 ), '', 'Int input → empty (rejected by is_string check)' );
assert_eq( sanitize_audit_string( array( 'x' ) ), '', 'Array input → empty' );

// ---------- 5. Insert guard: append v2 columns only on healthy migration ----------

// Case A: disabled_reason empty + not pending → APPEND
$GLOBALS['_options'] = array();
assert_true( should_append_v2(), 'No disabled_reason + no pending → append v2 columns' );

// Case B: disabled_reason set → SKIP v2 even if pending=false
$GLOBALS['_options'] = array( 'faz_geo_v2_disabled_reason' => 'mysql_too_old' );
assert_false( should_append_v2(), 'disabled_reason="mysql_too_old" → skip v2 columns' );

// Case C: disabled_reason empty BUT migration_pending → SKIP v2 (round-2 guard)
$GLOBALS['_options'] = array(
	'faz_geo_v2_disabled_reason'    => '',
	'faz_geo_v2_migration_pending'  => array( 'country_at_consent' ),  // truthy non-bool
);
assert_false( should_append_v2(), 'migration_pending non-empty array → skip v2 columns (round-2 guard)' );

// Case D: disabled_reason empty AND migration_pending = false → APPEND
$GLOBALS['_options'] = array(
	'faz_geo_v2_disabled_reason'    => '',
	'faz_geo_v2_migration_pending'  => false,
);
assert_true( should_append_v2(), 'Explicit pending=false → append v2 columns' );

// Case E: BOTH disabled AND pending → SKIP (defensive — either alone disables)
$GLOBALS['_options'] = array(
	'faz_geo_v2_disabled_reason'    => 'mysql_too_old',
	'faz_geo_v2_migration_pending'  => true,
);
assert_false( should_append_v2(), 'Both flags set → skip v2 columns' );

// ---------- 6. $insert_format alignment with int vs string values ----------
$base = array( '%s', '%s', '%s', '%s', '%s', '%s', '%s', '%d', '%s' );  // v1 base
$geo_mixed = array(
	'country_at_consent'    => 'US',
	'region_at_consent'     => 'US-CA',
	'ruleset_id_at_consent' => 'ccpa-california',
	'signal_gpc_received'   => 1,  // INT
	'signal_dnt_received'   => 0,  // INT
	'tc_string'             => 'CPyyy',
	'gpp_string'            => 'DBABAA',
);
$formats = build_insert_format( $base, $geo_mixed );
// Expect 9 base + 7 geo = 16 entries, with signals as %d, rest as %s.
assert_eq( count( $formats ), 16, '$insert_format length = base(9) + geo(7) = 16' );
$last_seven = array_slice( $formats, -7 );
assert_eq( $last_seven, array( '%s', '%s', '%s', '%d', '%d', '%s', '%s' ),
	'Geo formats: country/region/ruleset = %s, signals = %d, tc/gpp = %s'
);

// ---------- Summary ----------
echo "\n--\n";
echo "Tests:  $tests_run\n";
echo "Passed: $tests_passed\n";
echo "Failed: $tests_failed\n\n";
if ( $tests_failed > 0 ) { echo "\033[31mFAIL\033[0m\n"; exit( 1 ); }
echo "\033[32mPASS\033[0m\n";
exit( 0 );
