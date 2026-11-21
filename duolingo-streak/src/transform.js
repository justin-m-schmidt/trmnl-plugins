// Duolingo Streak: turns the polled streak into everything the screens draw.
// Duolingo only publishes the streak length and its last day, so the per-day
// history (practised / frozen) is recorded here, one refresh at a time.
// Days from before the plugin was installed are only known as "streak kept".
async function run(input) {
  var t = input.trmnl || {};
  var ps = t.plugin_settings || {};
  var cf = ps.custom_fields_values || {};
  var state = (t.state && typeof t.state === 'object') ? t.state : {};
  var offset = (t.user && typeof t.user.utc_offset === 'number') ? t.user.utc_offset : 0;

  function iso(d) { return d.toISOString().slice(0, 10); }
  function addDays(s, n) { var d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
  function dow(s) { return new Date(s + 'T00:00:00Z').getUTCDay(); }
  function list(v) {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string') return v.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    return [];
  }

  var local = new Date(Date.now() + offset * 1000);
  var today = iso(local);
  var secsLeft = 86400 - (local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds());

  // 1. The streak: from the polled data, else straight from Duolingo.
  var cs = null;
  var username = input.username || cf.username || '';
  if (input.currentStreak && typeof input.currentStreak.days === 'number') {
    cs = { days: input.currentStreak.days, endDate: input.currentStreak.endDate || null };
  } else if (cf.username) {
    try {
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, 3500);
      var res = await fetch('https://www.duolingo.com/2017-06-30/users?username=' + encodeURIComponent(cf.username) +
        '&fields=users%7Busername,streak,streakData%7D', { signal: ctl.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
      clearTimeout(timer);
      if (res.ok) {
        var body = await res.json();
        var u = body && body.users && body.users[0];
        if (u) {
          var c = u.streakData && u.streakData.currentStreak;
          cs = c ? { days: c.length || 0, endDate: c.endDate || null } : { days: 0, endDate: null };
          username = u.username || username;
        }
      }
    } catch (e) { /* fall through to "no data" */ }
  }
  if (!cs) {
    // Nothing came back: keep the history and let the markup show its fallback.
    return { ds: { error: true, username: username }, trmnl_state: state };
  }

  var len = Math.max(0, cs.days | 0);
  var doneToday = len > 0 && !!cs.endDate && cs.endDate >= today;

  // 2. History: p = practised, f = frozen, m = missed,
  //    k = streak kept, but not known whether practised or frozen.
  var hist = {};
  Object.keys(state.hist || {}).forEach(function (k) { hist[k] = state.hist[k]; });
  var lastDate = state.date, lastLen = state.len | 0;
  var since = state.since || null;
  if (lastDate && !since) {
    // Older saved history guessed the days before install; only "kept" is known.
    since = lastDate;
    Object.keys(hist).forEach(function (k) { if (k < since) hist[k] = 'k'; });
  }

  if (!lastDate) {
    // First run: the days this streak certainly covers are marked as kept.
    since = today;
    var back = Math.min(len - (doneToday ? 1 : 0), 62);
    for (var i = 1; i <= back; i++) hist[addDays(today, -i)] = 'k';
  } else if (lastDate < today) {
    var unknown = [];
    for (var d = lastDate; d < today; d = addDays(d, 1)) if (hist[d] !== 'p' && hist[d] !== 'f') unknown.push(d);
    if (len < lastLen) {
      // The streak restarted somewhere in the gap.
      var fresh = len - (doneToday ? 1 : 0);
      unknown.forEach(function (x, idx) { hist[x] = (unknown.length - idx <= fresh) ? 'p' : 'm'; });
    } else {
      var gained = len - lastLen - (doneToday ? 1 : 0);
      var fill = gained >= unknown.length ? 'p' : (gained <= 0 ? 'f' : 'k');
      unknown.forEach(function (x) { hist[x] = fill; });
    }
  }
  if (doneToday) hist[today] = 'p'; else delete hist[today];
  var cutoff = addDays(today, -70);
  Object.keys(hist).forEach(function (k) { if (k < cutoff) delete hist[k]; });

  // 3. Status
  var status = len === 0 ? 'lost' : (doneToday ? 'done' : 'due');
  var h = Math.floor(secsLeft / 3600), m = Math.max(1, Math.floor(secsLeft / 60));
  var timeLeft = h >= 1 ? (h + ' h left today') : (m + ' min left today');

  // 4. Milestones
  function isMilestone(n) { return n === 7 || n === 14 || n === 30 || n === 50 || n === 75 || (n >= 100 && n % 25 === 0) || (n > 0 && n % 365 === 0); }
  function nextMilestone(n) { var x = n + 1; while (!isMilestone(x)) x++; return x; }
  function prevMilestone(n) { var x = n; while (x > 0 && !isMilestone(x)) x--; return x; }
  var goal = parseInt(cf.goal, 10);
  var useGoal = cf.milestone_mode === 'goal' && goal > len;
  var next = useGoal ? goal : nextMilestone(len);
  var prev = prevMilestone(len);
  var togo = next - len;
  var pct = Math.max(0, Math.min(100, Math.round(100 * (len - prev) / Math.max(1, next - prev))));
  var reached = status === 'done' && (isMilestone(len) || (cf.milestone_mode === 'goal' && goal === len));
  var ms = { prev: prev, next: next, togo: togo, pct: pct, unit: togo === 1 ? 'day' : 'days', after: nextMilestone(len), after_togo: nextMilestone(len) - len };

  // 5. Week strip
  var NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  function codeFor(d) { if (d > today) return 'x'; if (d === today) return doneToday ? 'p' : 'd'; return hist[d] || 'u'; }
  var mode = cf.week_mode || 'sunday';
  var start = mode === 'last7' ? addDays(today, -6) : addDays(today, -((dow(today) - (mode === 'monday' ? 1 : 0) + 7) % 7));
  var week = [];
  for (var w = 0; w < 7; w++) { var wd = addDays(start, w); week.push({ l: NAMES[dow(wd)], s: codeFor(wd), t: wd === today }); }

  // 6. Month calendar
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var first = today.slice(0, 8) + '01';
  var lead = (dow(first) - (mode === 'monday' ? 1 : 0) + 7) % 7;
  var dim = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
  var cells = [], practised = 0, frozen = 0;
  for (var b = 0; b < lead; b++) cells.push({ d: 0 });
  for (var day = 1; day <= dim; day++) {
    var cd = today.slice(0, 8) + (day < 10 ? '0' + day : '' + day), cc = codeFor(cd);
    if (cc === 'p') practised++;
    if (cc === 'f') frozen++;
    cells.push({ d: day, s: cc, t: cd === today });
  }
  var labels = [];
  for (var q = 0; q < 7; q++) labels.push(NAMES[(q + (mode === 'monday' ? 1 : 0)) % 7]);

  // 7. What to show
  var hide = list(cf.hide);
  function shown(k) { return hide.indexOf(k) === -1; }
  var detail = cf.detail === 'minimal' || cf.detail === 'detailed' ? cf.detail : 'standard';
  var loud = cf.reminder === 'invert' && status === 'due' && local.getUTCHours() >= 18;

  return {
    ds: {
      n: len, status: status, time_left: timeLeft, username: username, today: today,
      detail: detail, celebrate: reached, invert: reached || loud, quiet: cf.reminder === 'none',
      show: { hours: shown('hours'), week: shown('week'), milestone: shown('milestone'), username: shown('username'), color: shown('color') },
      ms: ms, week: week,
      cal: { month: MONTHS[local.getUTCMonth()], labels: labels, cells: cells, practised: practised, frozen: frozen, frozen_unit: frozen === 1 ? 'freeze' : 'freezes' }
    },
    trmnl_state: { v: 2, hist: hist, len: len, date: today, since: since }
  };
}
