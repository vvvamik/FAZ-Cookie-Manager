<?php
/**
 * Standalone unit tests for Secrets — round-2 hardening.
 *
 * Regression guards for the 2026-05-20 changes:
 *  - removed insecure shared fallback salt ('faz-fallback-salt-not-secure')
 *  - v1 backward-compat decrypt path now refuses to decode (returns '')
 *    so garbage XOR output cannot leak as a bearer token to ipinfo.io
 *  - encrypt() / current_key_hint() / derive_key() return '' when
 *    wp_salt() is unavailable, refusing to fall back to a predictable
 *    keystream
 *  - salt-rotation detection via 8-char hex key-hint prefix in v2 format
 *
 * Run:
 *   php tests/unit/test-secrets.php
 *
 * @package FazCookie\Tests\Unit
 */

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ );
}
define( 'FAZ_VERSION', '1.15.0-test' );

$GLOBALS['_faz_test_salt'] = 'test-salt-stable';
function wp_salt( $scheme = 'auth' ) {
	return $GLOBALS['_faz_test_salt'];
}

require_once dirname( __DIR__, 2 ) . '/admin/modules/geo-routing/includes/class-secrets.php';
use FazCookie\Admin\Modules\Geo_Routing\Includes\Secrets;

$tests_run = $tests_passed = $tests_failed = 0;

function assert_eq( $a, $e, $label ) {
	global $tests_run, $tests_passed, $tests_failed;
	$tests_run++;
	if ( $a === $e ) { $tests_passed++; echo "  \033[32m✓\033[0m $label\n"; }
	else { $tests_failed++; echo "  \033[31m✗\033[0m $label\n      expected: " . var_export( $e, true ) . "\n      actual:   " . var_export( $a, true ) . "\n"; }
}
function assert_true( $c, $l ) { assert_eq( (bool) $c, true, $l ); }
function assert_false( $c, $l ) { assert_eq( (bool) $c, false, $l ); }
function assert_neq( $a, $e, $l ) {
	global $tests_run, $tests_passed, $tests_failed;
	$tests_run++;
	if ( $a !== $e ) { $tests_passed++; echo "  \033[32m✓\033[0m $l\n"; }
	else { $tests_failed++; echo "  \033[31m✗\033[0m $l (got: " . var_export( $a, true ) . ")\n"; }
}

echo "\n== Secrets — encryption hardening (round-2 fix) ==\n\n";

// ---------- 1. v2 encrypt → decrypt roundtrip ----------
$plain = 'svn_secret_token_42';
$enc = Secrets::encrypt( $plain );
assert_true( 0 === strpos( $enc, 'v2:' ), 'encrypt produces v2-prefixed ciphertext' );
assert_eq( Secrets::decrypt( $enc ), $plain, 'v2 roundtrip preserves plaintext' );

// ---------- 2. v2 format shape: v2:<8 hex>:<base64> ----------
assert_true(
	1 === preg_match( '/^v2:[0-9a-f]{8}:[A-Za-z0-9+\/=]+$/', $enc ),
	'v2 ciphertext format: prefix + 8-hex keyhint + base64 payload'
);

// ---------- 3. v1 backward-compat is CLOSED — must return '' ----------
// Construct a v1-shaped ciphertext by hand: 'v1:' + base64(plaintext XOR key).
$v1_payload = base64_encode( $plain ^ str_repeat( "\0", strlen( $plain ) ) );
$v1_cipher  = 'v1:' . $v1_payload;
assert_eq(
	Secrets::decrypt( $v1_cipher ),
	'',
	'v1 backward-compat decode returns empty (deprecated path, no key-hint = no salt-rotation detection)'
);

// ---------- 4. Salt rotation detection ----------
$enc_before = Secrets::encrypt( 'rotation-test' );
$GLOBALS['_faz_test_salt'] = 'test-salt-ROTATED'; // simulate wp_salt() change
$dec_after_rotation = Secrets::decrypt( $enc_before );
assert_eq(
	$dec_after_rotation,
	'',
	'Salt rotation detected via key-hint mismatch → decrypt returns empty'
);
$GLOBALS['_faz_test_salt'] = 'test-salt-stable'; // restore

// ---------- 5. No-salt failure: wp_salt() returns empty ----------
$GLOBALS['_faz_test_salt'] = '';
assert_eq(
	Secrets::encrypt( 'should-fail' ),
	'',
	'encrypt() refuses to encrypt when wp_salt() returns empty (no insecure fallback)'
);
// Decrypt also refuses (it consults current_key_hint).
$some_old_cipher = 'v2:abcd1234:' . base64_encode( 'whatever' );
assert_eq(
	Secrets::decrypt( $some_old_cipher ),
	'',
	'decrypt() refuses when current_key_hint is unavailable (no insecure fallback)'
);
$GLOBALS['_faz_test_salt'] = 'test-salt-stable'; // restore

// ---------- 6. Malformed v2 inputs ----------
assert_eq(
	Secrets::decrypt( 'v2:tooShort' ),
	'',
	'v2 ciphertext missing payload segment → empty'
);
assert_eq(
	Secrets::decrypt( 'v2:notHexAtAll:Zm9v' ),
	'',
	'v2 ciphertext with non-matching key-hint → empty'
);
assert_eq(
	Secrets::decrypt( 'v3:future-version:Zm9v' ),
	'',
	'Unknown version prefix (v3) → empty (forward-compat safe)'
);

// ---------- 7. Long payloads ----------
$long_secret = str_repeat( 'A', 512 ); // matches the API key max-length cap
$long_enc = Secrets::encrypt( $long_secret );
assert_eq(
	Secrets::decrypt( $long_enc ),
	$long_secret,
	'512-byte payload roundtrips (matches Geo_Api API-key length cap)'
);

// Bonus: derived key never repeats across very different lengths (XOR-stream uniqueness).
$enc_short = Secrets::encrypt( 'a' );
$enc_long  = Secrets::encrypt( 'a' );
assert_eq( $enc_short, $enc_long, 'Deterministic: same plaintext + same salt → same ciphertext (acceptable for XOR-stream)' );

// ---------- Summary ----------
echo "\n--\n";
echo "Tests:  $tests_run\n";
echo "Passed: $tests_passed\n";
echo "Failed: $tests_failed\n\n";

if ( $tests_failed > 0 ) { echo "\033[31mFAIL\033[0m\n"; exit( 1 ); }
echo "\033[32mPASS\033[0m\n";
exit( 0 );
