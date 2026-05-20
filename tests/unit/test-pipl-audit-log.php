<?php
/**
 * Standalone unit tests for the PIPL attestation audit-log logic.
 *
 * Regression guards for the round-2 fix to set_pipl_attestation() in
 * admin/modules/geo-routing/api/class-geo-api.php — the audit log
 * must:
 *  - Append on every state transition (true ⇄ false)
 *  - NOT append on no-op POSTs (same value as previous)
 *  - Cap at 200 entries, keeping the most recent
 *  - Sanitize log entries on read (drop malformed)
 *  - Handle the first-attestation case (no previous record)
 *
 * Since the production code uses get_option / update_option directly
 * we replicate the pure logic inline, then validate behaviour against
 * the same input fixtures the production handler sees.
 *
 * Run:
 *   php tests/unit/test-pipl-audit-log.php
 *
 * @package FazCookie\Tests\Unit
 */

// ---------- Helper that mirrors set_pipl_attestation() audit logic ----------

/**
 * Returns the updated [current, log] tuple given a previous state and
 * the new attestation flag.
 *
 * @param array $prev          Previous current state (empty for first attestation).
 * @param array $log           Previous audit log.
 * @param bool  $new_attested  New attestation value.
 * @param int   $now_ts        Timestamp to record.
 * @param int   $user_id       User performing the change.
 * @return array{current: array, log: array}
 */
function compute_pipl_state( $prev, $log, $new_attested, $now_ts, $user_id ) {
	$current = array(
		'attested'  => (bool) $new_attested,
		'timestamp' => (int) $now_ts,
		'user_id'   => (int) $user_id,
	);

	$prev_attested = ! empty( $prev['attested'] );
	$is_transition = empty( $prev ) || $prev_attested !== (bool) $new_attested;

	if ( $is_transition ) {
		$log[] = $current;
		if ( count( $log ) > 200 ) {
			$log = array_slice( $log, -200 );
		}
	}

	return array( 'current' => $current, 'log' => $log );
}

/**
 * Returns the sanitized log for read response (mirrors get_pipl_attestation).
 *
 * @param array $raw_log Raw option content.
 * @return array Sanitized.
 */
function sanitize_pipl_log( $raw_log ) {
	$out = array();
	foreach ( (array) $raw_log as $entry ) {
		if ( ! is_array( $entry ) ) {
			continue;
		}
		$out[] = array(
			'attested'  => ! empty( $entry['attested'] ),
			'timestamp' => (int) ( $entry['timestamp'] ?? 0 ),
			'user_id'   => (int) ( $entry['user_id'] ?? 0 ),
		);
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

echo "\n== PIPL attestation audit-log logic (round-2 fix) ==\n\n";

// ---------- 1. First attestation creates a log entry ----------
$result = compute_pipl_state( array(), array(), true, 1715000000, 7 );
assert_eq( count( $result['log'] ), 1, 'First attestation → log has 1 entry' );
assert_eq( $result['log'][0]['attested'], true, 'First log entry is the attestation' );
assert_eq( $result['log'][0]['user_id'], 7, 'User ID recorded' );

// ---------- 2. Repeated POST with same value → no log append ----------
$prev = array( 'attested' => true, 'timestamp' => 1715000000, 'user_id' => 7 );
$log  = array( $prev );
$result = compute_pipl_state( $prev, $log, true, 1715001000, 8 );
assert_eq( count( $result['log'] ), 1, 'Same-value POST does NOT append (no-op detect)' );
assert_eq( $result['log'][0]['user_id'], 7, 'Log still shows original user, not the no-op repeater' );

// ---------- 3. Revocation (true → false) appends ----------
$result = compute_pipl_state( $prev, $log, false, 1715002000, 9 );
assert_eq( count( $result['log'] ), 2, 'Revocation appends second log entry' );
assert_eq( $result['log'][1]['attested'], false, 'Second entry is the revocation' );
assert_eq( $result['log'][1]['user_id'], 9, 'Revocation records the revoking admin' );

// ---------- 4. Cap at 200 entries — oldest rolls off ----------
$big_log = array();
for ( $i = 0; $i < 250; $i++ ) {
	$big_log[] = array( 'attested' => ( $i % 2 === 0 ), 'timestamp' => 1000 + $i, 'user_id' => 1 );
}
// 250 entries; append the 251st. Cap should keep last 200, dropping first 50+the-new-one becomes 201 → slice to 200.
$result = compute_pipl_state(
	array( 'attested' => false ),  // alternates, so this triggers a transition
	$big_log,
	true,
	2000,
	2
);
assert_eq( count( $result['log'] ), 200, 'Log capped at 200 entries' );
// The most recent (just-appended) entry must be present at the tail.
$last = end( $result['log'] );
assert_eq( $last['user_id'], 2, 'Newest entry is at the tail of the capped log' );
assert_eq( $last['timestamp'], 2000, 'Newest entry timestamp preserved at tail' );
// The oldest surviving entry must be from the original $big_log, not from index 0.
$first = $result['log'][0];
assert_true( $first['timestamp'] >= 1051, 'Oldest entry rolled off — surviving entries are the newest 200' );

// ---------- 5. Sanitization on read ----------
$raw = array(
	array( 'attested' => true, 'timestamp' => 100, 'user_id' => 1 ),  // valid
	'malformed-string-entry',                                          // dropped
	array( 'attested' => 'yes', 'timestamp' => '200', 'user_id' => '5' ), // coerced
	null,                                                              // dropped
	array(),                                                           // becomes attested=false, ts=0, user=0
);
$sanitized = sanitize_pipl_log( $raw );
assert_eq( count( $sanitized ), 3, 'Non-array entries dropped on sanitization' );
assert_eq( $sanitized[0]['attested'], true, 'First valid entry preserved' );
assert_eq( $sanitized[1]['timestamp'], 200, 'String timestamp coerced to int' );
assert_eq( $sanitized[1]['user_id'], 5, 'String user_id coerced to int' );
assert_eq( $sanitized[2]['attested'], false, 'Empty entry → attested=false (defensive default)' );

// ---------- Summary ----------
echo "\n--\n";
echo "Tests:  $tests_run\n";
echo "Passed: $tests_passed\n";
echo "Failed: $tests_failed\n\n";
if ( $tests_failed > 0 ) { echo "\033[31mFAIL\033[0m\n"; exit( 1 ); }
echo "\033[32mPASS\033[0m\n";
exit( 0 );
