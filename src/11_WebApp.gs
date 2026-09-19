/**
 * Tail Wag — 11_WebApp.gs
 * The HTTP surface: one doPost() that Slack sends everything to, and a doGet()
 * that serves a read-only leaderboard page for screens and all-hands.
 */

/**
 * When the current request started, in epoch ms. Slack discards a slash command
 * response after three seconds, so the give path checks this before deciding
 * whether the announcement can safely ride back on the HTTP response.
 */
var __reqStarted = 0;

/**
 * Milliseconds spent on the current request so far. Returns 0 when nothing has
 * set __reqStarted (a trigger run, a function run from the editor, a test).
 */
function elapsedMs_() {
  return __reqStarted ? (new Date().getTime() - __reqStarted) : 0;
}

/**
 * True when so much of Slack's three-second budget is gone that the response is
 * likely to be thrown away.
 *
 * The number has to be well under 3000. Slack starts its clock when it sends the
 * request, and roughly a second goes to Apps Script dispatch and response
 * handling either side of this function — time doPost never sees. A request that
 * measures 900ms of its own work can still be past three seconds on the wire,
 * which is exactly how a fast answer ends up discarded with "operation_timeout".
 */
function responseLikelyTooLate_() {
  // Outside a request — a trigger, a run from the editor — there is no Slack
  // waiting and nothing to be late for.
  if (!__reqStarted) return false;
  // Setting RESPONSE_DEADLINE_MS to 0 makes every slash command answer through
  // response_url. That is the switch to reach for if Apps Script ever gets slow
  // enough that returning inline stops being worth trying.
  return elapsedMs_() >= cfgNum('RESPONSE_DEADLINE_MS');
}

/**
 * Every inbound Slack request lands here: slash commands, interactivity
 * payloads and Events API callbacks all arrive as POSTs to the same URL.
 */
function doPost(e) {
  var started = new Date().getTime();
  __reqStarted = started;
  try {
    if (!e) return textOut_('no request');

    var raw = (e.postData && e.postData.contents) || '';
    var contentType = (e.postData && e.postData.type) || '';
    var params = e.parameter || {};
    var payload = null;
    var kind = '';

    if (params.payload) {
      // Interactivity: a JSON blob inside a form field.
      kind = 'interaction';
      payload = safeParseJson_(params.payload);
    } else if (contentType.indexOf('application/json') !== -1 || (raw && raw.charAt(0) === '{')) {
      kind = 'event';
      payload = safeParseJson_(raw);
    } else if (params.command) {
      kind = 'command';
      payload = params;
    } else {
      return textOut_('unrecognized request');
    }

    if (!payload) return textOut_('bad payload');

    // The URL verification handshake arrives before anything is wired up, and
    // Slack will not save the Request URL until it is echoed. It carries no user
    // data, so it is answered after the shared-secret check but before the rest.
    var auth = verifyRequest_(e, payload);
    if (!auth.ok) {
      logWarn_('auth.rejected', kind, { reason: auth.reason, method: auth.method });
      return textOut_('unauthorized');
    }

    if (kind === 'event' && payload.type === 'url_verification') {
      return textOut_(payload.challenge || '');
    }

    // Slack stops listening after three seconds. A give takes the script lock,
    // appends to the ledger, rewrites a balance and calls Slack — measured at
    // 2.5 to 4.2 seconds of our own work, before the second or so of Apps Script
    // overhead on either side of this function. No amount of tuning fits that
    // into three seconds, so the work does not go on the request path at all:
    // the command is handed to a one-off trigger and answered on response_url,
    // which Slack honours for thirty minutes. What comes back from here is an
    // empty body, which Slack shows as nothing at all rather than an error.
    if (kind === 'command' && payload.response_url && cfgBool('ASYNC_COMMANDS')) {
      if (queueCommand_(payload)) return emptyOut_();
      // Could not queue it — fall through and answer inline, late or not.
    }

    var out;
    switch (kind) {
      case 'command': out = routeCommand_(payload); break;
      case 'interaction': out = handleInteraction_(payload); break;
      case 'event': out = handleEvent_(payload); break;
      default: out = textOut_('ok');
    }

    var elapsed = new Date().getTime() - started;

    // Do not gamble on the HTTP response once our share of the budget is spent.
    // response_url reaches the same place in Slack and stays valid for thirty
    // minutes, so the answer lands even when the request itself has timed out.
    // The work is already done at this point, so nothing is counted twice.
    if (kind === 'command' && payload.response_url && responseLikelyTooLate_()) {
      var late = '';
      try { late = out.getContent(); } catch (e2) { late = ''; }
      if (late && postToResponseUrl_(payload.response_url, late)) {
        logWarn_('response.late', payload.command || '', { ms: elapsed });
        return emptyOut_();
      }
    }

    if (elapsed > 2500) {
      logWarn_('slow_request', kind, { ms: elapsed, command: payload.command || payload.type || '' });
    }
    return out;
  } catch (err) {
    logError_('dopost.failed', '', String(err && err.stack || err));
    // Never leak a stack trace into Slack; say something a human can act on.
    return jsonOut_({
      response_type: 'ephemeral',
      text: 'Tail Wag hit an error handling that. Nothing was counted. If it keeps happening, ' +
        'check the Events tab of the Tail Wag sheet.'
    });
  }
}

/** Dispatches a slash command by name, so the command words can be renamed freely. */
function routeCommand_(cmd) {
  var name = String(cmd.command || '').replace(/^\//, '').toLowerCase();

  if (name === 'wag' || name === 'kudos' || name === 'tailwag') return handleWagCommand_(cmd);
  if (name === 'wags' || name === 'mywags' || name === 'leaderboard') return handleWagsCommand_(cmd);
  if (name === 'wag-admin' || name === 'tailwags-admin' || name === 'kudos-admin') return handleAdminCommand_(cmd);

  // Unknown command name — most likely a manifest edit that did not match.
  return ephemeral_('`/' + escapeSlack_(name) + '` is not wired up. Known commands: `/wag`, `/wags`, `/wag-admin`.');
}

function safeParseJson_(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// doGet — the read-only web leaderboard
// ---------------------------------------------------------------------------

/**
 * Serves the leaderboard page. Guarded by the same URL secret, so the link can
 * be pinned in a channel or left up on an office screen without exposing the
 * data to the open web.
 *
 * ?view=health returns a JSON status object instead.
 */
function doGet(e) {
  var params = (e && e.parameter) || {};

  if (!safeEqual_(params.k || '', cfgStr('URL_SECRET'))) {
    return HtmlService.createHtmlOutput(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{font:16px/1.5 system-ui,sans-serif;background:#0f1115;color:#e7e9ee;' +
      'display:grid;place-items:center;height:100vh;margin:0}</style>' +
      '<div><h1 style="font-size:20px">🐕 Tail Wag</h1><p>This link needs its key.</p></div>'
    ).setTitle('Tail Wag');
  }

  if (params.view === 'health') {
    return jsonOut_({
      ok: true,
      time: iso_(),
      periodKey: periodKey_(),
      monthKey: monthKey_(),
      paused: cfgBool('PAUSED'),
      hasToken: !!cfgStr('SLACK_BOT_TOKEN'),
      stats: globalStats_()
    });
  }

  var period = params.period === 'month' ? 'month' : params.period === 'all' ? 'all' : 'period';
  var tmpl = HtmlService.createTemplateFromFile('Leaderboard');
  tmpl.data = {
    period: period,
    periodWord: periodWord_(),
    rows: leaderboard_(period, 25),
    givers: giverLeaderboard_(5),
    stats: globalStats_(),
    feed: recentReasons_(12),
    values: valueBreakdown_(isDailyAllowance_() ? {} : { week_key: weekKey_() }),
    valuesEnabled: cfgBool('VALUES_ENABLED'),
    raffleEnabled: cfgBool('RAFFLE_ENABLED'),
    rafflePrize: cfgStr('RAFFLE_PRIZE'),
    monthName: fmt_(now_(), 'MMMM'),
    updated: fmt_(now_(), 'EEE d MMM, h:mm a'),
    key: params.k
  };
  return tmpl.evaluate()
    .setTitle('Tail Wag')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---------------------------------------------------------------------------
// Running a command off the request path
// ---------------------------------------------------------------------------

/** Script-property prefix mapping a trigger to the job it was created for. */
var JOB_PROP_PREFIX = 'TW_JOB_';

/**
 * Parks a slash command for a one-off trigger to run, and returns true when it
 * is safely parked. Only the fields the command needs are kept, so nothing
 * larger than a few hundred bytes goes into the cache.
 *
 * Returning false is not a failure the user should see — the caller just
 * answers inline instead, which is what the app did before.
 */
function queueCommand_(payload) {
  try {
    var token = Utilities.getUuid();
    cachePut_('job.' + token, {
      command: payload.command || '',
      text: payload.text || '',
      user_id: payload.user_id || '',
      user_name: payload.user_name || '',
      channel_id: payload.channel_id || '',
      channel_name: payload.channel_name || '',
      team_id: payload.team_id || '',
      response_url: payload.response_url || ''
    }, CACHE_TTL.JOB);

    var trigger = ScriptApp.newTrigger('runQueuedCommand').timeBased().after(1).create();
    PropertiesService.getScriptProperties()
      .setProperty(JOB_PROP_PREFIX + trigger.getUniqueId(), token);
    return true;
  } catch (e) {
    // Most likely the per-script trigger ceiling during a burst. Answering
    // inline is worse but still correct, so this is a warning, not an error.
    logWarn_('queue.failed', payload.user_id || '', String(e));
    return false;
  }
}

/**
 * Runs a parked command and sends the answer to response_url. Nothing about the
 * work changes — it is the same routeCommand_ the inline path calls — so a
 * tailwag is counted exactly once whichever way the command arrived.
 */
function runQueuedCommand(e) {
  var props = PropertiesService.getScriptProperties();
  var uid = (e && e.triggerUid) ? String(e.triggerUid) : '';
  var key = JOB_PROP_PREFIX + uid;
  var token = props.getProperty(key);

  // Clear the one-off trigger first, so a job that throws cannot leave one
  // behind and eat into the ceiling.
  deleteTriggerByUid_(uid);
  if (key !== JOB_PROP_PREFIX) props.deleteProperty(key);

  if (!token) { logWarn_('queue.no_token', 'system', uid); return; }

  var job = cacheGet_('job.' + token);
  cacheDrop_('job.' + token);
  if (!job) { logWarn_('queue.expired', 'system', token); return; }

  var body;
  try {
    body = routeCommand_(job).getContent();
  } catch (err) {
    logError_('queue.run_failed', job.user_id || '', String(err && err.stack || err));
    body = JSON.stringify({
      response_type: 'ephemeral',
      text: 'Tail Wag hit an error handling that. Nothing was counted. If it keeps happening, ' +
        'check the Events tab of the Tail Wag sheet.'
    });
  }
  postToResponseUrl_(job.response_url, body);
}

/** Deletes one trigger by its unique id. Silent when it is already gone. */
function deleteTriggerByUid_(uid) {
  if (!uid) return false;
  try {
    var all = ScriptApp.getProjectTriggers();
    for (var i = 0; i < all.length; i++) {
      if (String(all[i].getUniqueId()) === uid) {
        ScriptApp.deleteTrigger(all[i]);
        return true;
      }
    }
  } catch (e) {
    logWarn_('queue.cleanup_failed', 'system', String(e));
  }
  return false;
}

/**
 * Removes one-off command triggers that never ran, and the properties that
 * point at them. Apps Script caps how many triggers a script may hold, so a run
 * that died without cleaning up must not be allowed to accumulate. Called by
 * the daily job.
 */
function sweepQueuedCommands_() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var live = {};
  var removed = 0;

  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() !== 'runQueuedCommand') return;
      var uid = String(t.getUniqueId());
      // Its cached job is gone, so it can never do anything useful again.
      var token = all[JOB_PROP_PREFIX + uid];
      if (!token || !cacheGet_('job.' + token)) {
        ScriptApp.deleteTrigger(t);
        removed++;
      } else {
        live[JOB_PROP_PREFIX + uid] = true;
      }
    });
  } catch (e) {
    logWarn_('queue.sweep_failed', 'system', String(e));
  }

  Object.keys(all).forEach(function (k) {
    if (k.indexOf(JOB_PROP_PREFIX) === 0 && !live[k]) props.deleteProperty(k);
  });

  if (removed) logInfo_('queue.swept', 'system', { triggers: removed });
  return removed;
}
