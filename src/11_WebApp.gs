/**
 * Orange Dots — 11_WebApp.gs
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

    var out;
    switch (kind) {
      case 'command': out = routeCommand_(payload); break;
      case 'interaction': out = handleInteraction_(payload); break;
      case 'event': out = handleEvent_(payload); break;
      default: out = textOut_('ok');
    }

    var elapsed = new Date().getTime() - started;
    if (elapsed > 2500) {
      logWarn_('slow_request', kind, { ms: elapsed, command: payload.command || payload.type || '' });
    }
    return out;
  } catch (err) {
    logError_('dopost.failed', '', String(err && err.stack || err));
    // Never leak a stack trace into Slack; say something a human can act on.
    return jsonOut_({
      response_type: 'ephemeral',
      text: 'Orange Dots hit an error handling that. Nothing was counted. If it keeps happening, ' +
        'check the Events tab of the Orange Dots sheet.'
    });
  }
}

/** Dispatches a slash command by name, so the command words can be renamed freely. */
function routeCommand_(cmd) {
  var name = String(cmd.command || '').replace(/^\//, '').toLowerCase();

  if (name === 'dot' || name === 'kudos' || name === 'orangedot') return handleDotCommand_(cmd);
  if (name === 'dots' || name === 'mydots' || name === 'leaderboard') return handleDotsCommand_(cmd);
  if (name === 'dot-admin' || name === 'dots-admin' || name === 'kudos-admin') return handleAdminCommand_(cmd);

  // Unknown command name — most likely a manifest edit that did not match.
  return ephemeral_('`/' + escapeSlack_(name) + '` is not wired up. Known commands: `/dot`, `/dots`, `/dot-admin`.');
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
      '<div><h1 style="font-size:20px">🟠 Orange Dots</h1><p>This link needs its key.</p></div>'
    ).setTitle('Orange Dots');
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
    .setTitle('Orange Dots')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
