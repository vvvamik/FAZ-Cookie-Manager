<?php
/**
 * Standalone unit tests for the geo-routing preview rate-limit logic.
 *
 * Regression guards for the round-2 fix to Geo_Api::preview() — per-user
 * 60-req/minute transient-based throttle. The production code uses
 * get_transient / set_transient directly; we replicate the throttle
 * counter math here and validate behaviour.
 *
 * Run:
 *   php tests/unit/test-rate-limit.php
 *
 * @package FazCookie\Tests\Unit
 */

define( 'MINUTE_IN_SECONDS', 60 );

// In-process transient store keyed by name → [value, expires_at].
$GLOBALS['_transients'] = array();
function get_transient( $key ) {
	if ( ! isset( $GLOBALS['_transients'][ $key ] ) ) {
		return false;
	}
	list( $val, $expires_at ) = $GLOBALS['_transients'][ $key ];
	if ( $expires_at && time() > $expires_at ) {
		unset( $GLOBALS['_transients'][ $key ] );
		return false;
	}
	return $val;
}
function set_transient( $key, $val, $ttl_sec ) {
	$GLOBALS['_transients'][ $key ] = array( $val, $ttl_sec ? time() + $ttl_sec : 0 );
	return true;
}
function _faz_test_reset_transients() {
	$GLOBALS['_transients'] = array();
}

/**
 * Mirrors the preview-rate-limit logic in
 * admin/modules/geo-routing/api/class-geo-api.php::preview().
 *
 * @param int|string $user_id Anonymous fallback string allowed for $user_id<=0.
 * @return array{throttled: bool, count_after: int}
 */
function preview_rate_step( $user_id ) {
	$rate_key = 'faz_geo_preview_rate_' . ( (int) $user_id > 0 ? (int) $user_id : 'anon' );
	$count    = (int) get_transient( $rate_key );
	if ( $count >= 60 ) {
		return array( 'throttled' => true, 'count_after' => $count );
	}
	set_transient( $rate_key, $count + 1, MINUTE_IN_SECONDS );
	return array( 'throttled' => false, 'count_after' => $count + 1 );
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

echo "\n== Geo_Api preview rate-limit (round-2 fix) ==\n\n";

// ---------- 1. First 60 calls pass, 61st throttles ----------
_faz_test_reset_transients();
for ( $i = 1; $i <= 60; $i++ ) {
	$r = preview_rate_step( 42 );
	if ( $r['throttled'] ) {
		break;
	}
}
assert_eq( $r['throttled'], false, 'Call #60 passes (last allowed)' );
assert_eq( $r['count_after'], 60, 'Counter increments to 60 after 60 calls' );

$r61 = preview_rate_step( 42 );
assert_eq( $r61['throttled'], true, 'Call #61 is throttled' );
assert_eq( $r61['count_after'], 60, 'Throttled call does NOT increment counter past 60' );

// ---------- 2. Different users have independent counters ----------
_faz_test_reset_transients();
for ( $i = 0; $i < 50; $i++ ) { preview_rate_step( 100 ); }  // user 100 → 50 calls
for ( $i = 0; $i < 5;  $i++ ) { preview_rate_step( 200 ); }  // user 200 → 5 calls

$r_100 = preview_rate_step( 100 );
$r_200 = preview_rate_step( 200 );
assert_eq( $r_100['count_after'], 51, 'User 100 counter independent (51 after 51 calls)' );
assert_eq( $r_200['count_after'], 6, 'User 200 counter independent (6 after 6 calls)' );
assert_eq( $r_100['throttled'], false, 'Neither user throttled while both below 60' );
assert_eq( $r_200['throttled'], false, 'Neither user throttled while both below 60' );

// ---------- 3. Anonymous (user_id<=0) routes to 'anon' bucket ----------
_faz_test_reset_transients();
$r_anon_a = preview_rate_step( 0 );  // user_id=0
$r_anon_b = preview_rate_step( -1 ); // negative (shouldn't happen, defensive)
assert_eq( $r_anon_a['count_after'], 1, 'Anonymous user_id=0 → bucket "anon", count=1' );
assert_eq( $r_anon_b['count_after'], 2, 'Anonymous user_id=-1 → same "anon" bucket, count=2' );

// Verify the actual transient key — internal contract.
assert_true(
	isset( $GLOBALS['_transients']['faz_geo_preview_rate_anon'] ),
	'Anonymous bucket transient key is "faz_geo_preview_rate_anon"'
);
assert_false(
	isset( $GLOBALS['_transients']['faz_geo_preview_rate_0'] ),
	'No transient created for literal user_id=0 key'
);

// ---------- 4. TTL expiry resets the counter ----------
_faz_test_reset_transients();
for ( $i = 0; $i < 60; $i++ ) { preview_rate_step( 7 ); }
assert_eq( preview_rate_step( 7 )['throttled'], true, 'User 7 throttled after 60 calls' );

// Simulate TTL expiry: force the transient's expires_at to the past.
$GLOBALS['_transients']['faz_geo_preview_rate_7'][1] = time() - 1;
$r_after_ttl = preview_rate_step( 7 );
assert_eq( $r_after_ttl['throttled'], false, 'After TTL expires (60s window), counter resets and call passes' );
assert_eq( $r_after_ttl['count_after'], 1, 'Post-expiry counter starts back at 1' );

// ---------- Summary ----------
echo "\n--\n";
echo "Tests:  $tests_run\n";
echo "Passed: $tests_passed\n";
echo "Failed: $tests_failed\n\n";
if ( $tests_failed > 0 ) { echo "\033[31mFAIL\033[0m\n"; exit( 1 ); }
echo "\033[32mPASS\033[0m\n";
exit( 0 );
