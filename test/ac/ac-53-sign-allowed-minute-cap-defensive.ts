/* @slow: 4.6x the pool mean (D19) */
/* AC-53 -- D14 (LOW, reviewer-found): `nextAllowedMinuteAfter` and the
 * private `firstAllowedMinuteAtOrAfter` walked forward at most 20160
 * minutes (14 days) looking for an allowed instant, then returned
 * whatever they landed on -- even if it was STILL forbidden. Under the
 * current schema (`forbiddenWindows[].to` is HH:MM, max '23:59', and
 * `from < to` is required) this can never actually happen via any
 * policy.json a real user could write -- the minute '23:59' itself is
 * never excluded by any valid window, so some minute is always allowed
 * within a day. That is exactly why this is a UNIT test importing
 * lib/policy.ts directly, unlike every other AC file here (which only
 * drives the built binary): the only way to exercise the cap at all is
 * to hand-build a `Policy` value in memory whose window reaches a 'to'
 * the file loader would never accept (schema-circumventing, on purpose),
 * standing in for "the schema changes later and allows this" or "a
 * caller builds a Policy value programmatically, not from a file". */
import { nextAllowedMinuteAfter, signTimeFor } from '../../lib/policy.ts';
import type { Policy } from '../../lib/policy.ts';
import * as H from '../lib/harness.ts';
const T = H.T;

const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function impossiblePolicy(): Policy {
  return {
    identity: { name: 'X', email: 'x@example.invalid' },
    signingKey: '0'.repeat(40),
    timezone: 'UTC',
    /* 'to': '24:00' is not expressible via policy.json (validateWindow's
     * HH:MM regex caps the hour at 23) -- deliberately out of schema, to
     * make literally every minute of every day forbidden, something no
     * file-loaded Policy can ever actually produce. */
    forbiddenWindows: [{ days: ALL_DAYS, from: '00:00', to: '24:00' }],
    forbiddenMessagePatterns: [],
  };
}

{
  const policy = impossiblePolicy();
  const result = nextAllowedMinuteAfter(1_700_000_000, policy);
  T.eq('AC-53: nextAllowedMinuteAfter returns null, not a still-forbidden instant, once the cap is exhausted', result, null);
}

{
  const policy = impossiblePolicy();
  let threw: Error | null = null;
  try {
    signTimeFor(1_700_000_000, policy, 1_600_000_000);
  } catch (e) {
    threw = e as Error;
  }
  T.check('AC-53: signTimeFor refuses (never signs at a silently-forbidden instant) when no floor can be found', !!threw, String(threw));
  if (threw) T.contains('AC-53: names the reason', threw.message, 'forbiddenWindows');
}

/* Sanity check on the OTHER side: an ordinary, schema-valid, merely
 * five-day policy (the common case) still finds an allowed minute almost
 * immediately -- the defensive path above is for the pathological case
 * only, never for a normal policy. */
{
  const normal: Policy = {
    identity: { name: 'X', email: 'x@example.invalid' },
    signingKey: '0'.repeat(40),
    timezone: 'UTC',
    forbiddenWindows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '07:00', to: '19:00' }],
    forbiddenMessagePatterns: [],
  };
  const result = nextAllowedMinuteAfter(1_700_000_000, normal);
  T.check('AC-53: an ordinary policy still finds an allowed minute (not null)', result !== null);
}

T.finish();
