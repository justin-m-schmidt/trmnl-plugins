// Fi Dog Tracker → TRMNL serverless function (Node 20).
// One plugin, four screens picked by the "view" setting: overview, today and week (steps and
// sleep) and the walk timer. Signs in to Fi with the installer's own login (POST /auth/login
// for a session cookie, then GraphQL) and only asks Fi for what the chosen screen needs, so a
// run stays well inside TRMNL's 5 second budget.

const FI = "https://api.tryfi.com";
const UA = "trmnl-fi-collar";
const DAYS = 7;
const DAY = 86400e3;
const VIEWS = ["both", "today", "week", "walk"];
const AXIS_START = 6 * 60; // the walk timer's day strip runs 06:00 → 22:00
const AXIS_END = 22 * 60;
const RING = 2 * Math.PI * 100;

function setting(input, key) {
  const value = input?.trmnl?.plugin_settings?.custom_fields_values?.[key] ?? input?.[key];
  return typeof value === "string" ? value.trim() : value;
}

// ---------- Fi ----------
async function login(email, password) {
  const res = await fetch(`${FI}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: new URLSearchParams({ email, password }).toString(),
    signal: AbortSignal.timeout(2500),
  });
  const json = await res.json().catch(() => undefined);
  if (json?.error || res.status === 401 || res.status === 403) {
    throw new Error("Fi rejected the email or password. Use the same login as the Fi app.");
  }
  if (!res.ok || !json?.userId) throw new Error(`Fi sign-in failed (HTTP ${res.status}).`);
  const cookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : (res.headers.get("set-cookie") ?? "").split(/,(?=\s*[^;,=\s]+=)/);
  return cookies
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.includes("="))
    .join("; ");
}

// Queries without variables go over GET like the Fi apps do. Fi's Apollo server rejects a
// GET without a JSON content-type as possible CSRF, so send it.
async function graphql(cookie, query) {
  const url = new URL("/graphql", FI);
  url.searchParams.set("query", query);
  const res = await fetch(url, {
    headers: {
      cookie,
      "content-type": "application/json",
      "apollo-require-preflight": "true",
      accept: "application/json",
      "user-agent": UA,
    },
    signal: AbortSignal.timeout(2500),
  });
  const json = await res.json().catch(() => undefined);
  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    throw new Error(`Fi API error: ${json.errors.map((e) => e?.message ?? "unknown").join(", ")}`);
  }
  if (!res.ok || !json?.data) throw new Error(`Fi API request failed (HTTP ${res.status}).`);
  return json.data;
}

const petsOf = (data) => (data?.currentUser?.userHouseholds ?? []).flatMap((h) => h?.household?.pets ?? []);

// ---------- time ----------
const pad = (n) => String(n).padStart(2, "0");

function validTz(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return "America/New_York"; }
}

/** Wall-clock fields of `date` in `tz`, read from parts so the runtime's locale data does not matter. */
function wallClock(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date);
  const g = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
  return { year: g.year, month: g.month, day: g.day, hour: g.hour % 24, minute: g.minute, second: g.second };
}

/** Milliseconds `tz` is ahead of UTC at `ms`. */
function tzOffset(ms, tz) {
  const w = wallClock(new Date(ms), tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

/** "4:46 PM" or "16:46". */
function clock(ms, tz, h12) {
  const w = wallClock(new Date(ms), tz);
  if (!h12) return `${pad(w.hour)}:${pad(w.minute)}`;
  return `${w.hour % 12 === 0 ? 12 : w.hour % 12}:${pad(w.minute)} ${w.hour < 12 ? "AM" : "PM"}`;
}

/** "2026-11-21" for the calendar day of `date` in `tz`. */
function ymd(date, tz) {
  const w = wallClock(date, tz);
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).toISOString().slice(0, 10);
}

/** "2026-11-21" for the calendar day `i` days before today in `tz`. */
function dayString(i, tz, now = new Date()) {
  const w = wallClock(now, tz);
  return new Date(Date.UTC(w.year, w.month - 1, w.day) - i * DAY).toISOString().slice(0, 10);
}

/** The UTC instant at which `day` ("2026-11-21") starts in `tz`. */
function localMidnight(day, tz) {
  const guess = new Date(`${day}T00:00:00Z`).getTime();
  const first = guess - tzOffset(guess, tz);
  return new Date(guess - tzOffset(first, tz));
}

// ---------- queries ----------
// Every Pet field lives on household.pets too, so one request covers profile, today and
// (when `history` is set) the 7-day feeds. Sleep comes from two places: restFeed is what
// the current Fi app reads (the only one the Fi Mini fills) and returns one day per call,
// addressed by a cursor that is the base64 of that day's local midnight. restSummaryFeed is
// the older feed, kept for Series collars.
function petsQuery(tz, history) {
  const head = `id name gender breed { name } device { info }
  ongoingActivity { __typename start areaName }
  today: currentActivitySummary(period: DAILY) { totalSteps stepGoal totalDistance }`;
  if (!history) return `query { currentUser { userHouseholds { household { pets { ${head} } } } } }`;
  const rest = Array.from({ length: DAYS }, (_, i) => {
    const cursor = Buffer.from(localMidnight(dayString(i, tz), tz).toISOString()).toString("base64");
    return `rest${i}: restFeed(period: DAY, cursor: "${cursor}") { restSummary { start sleepSecondsTotal napSecondsTotal restSecondsTotal } }`;
  }).join("\n  ");
  return `query { currentUser { userHouseholds { household { pets {
  ${head}
  stepDays: activitySummaryFeed(cursor: null, period: DAILY, limit: ${DAYS}) { activitySummaries { totalSteps stepGoal totalDistance } }
  sleepDays: restSummaryFeed(cursor: null, period: DAILY, limit: ${DAYS}) { restSummaries { start end data { ... on ConcreteRestSummaryData { sleepAmounts { type duration } } } } }
  ${rest}
} } } } }`;
}
// The walk timer's extras go out as their own requests so one failing does not take the screen down.
const Q_WALKING = `query { currentUser { userHouseholds { household { pets { id ongoingActivity { __typename ... on OngoingWalk { distance } } } } } } }`;
const Q_FEED = `query { currentUser { userHouseholds { household { pets { id activityFeed(limit: 25) { activities { __typename start end ... on Walk { distance } } } } } } } }`;

// ---------- formatting ----------
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : undefined);
const fmt = (n) => Math.round(n ?? 0).toLocaleString("en-US");

/** Seconds → "7h 25m". */
function duration(seconds) {
  const total = Math.round((seconds ?? 0) / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function distance(metres, metric) {
  if (metres === undefined) return "–";
  if (metric) return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;
  return `${(metres / 1609.344).toFixed(1)} mi`;
}

/** Milliseconds → "2h 05m", for the walk timer's ring. */
function span(ms) {
  const total = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${pad(m)}m`;
}

/** Milliseconds → "2 h 5 min", for sentences. */
function spanLong(ms) {
  const total = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// ---------- steps and sleep ----------
function sleepSeconds(summary, type) {
  const amounts = summary?.data?.sleepAmounts;
  if (!Array.isArray(amounts)) return 0;
  return amounts.filter((a) => a?.type === type).reduce((t, a) => t + (num(a?.duration) ?? 0), 0);
}

function dayLabels(i, tz, startIso) {
  // i = 0 is today; the older feed gives a start for sleep days, otherwise count back from now.
  const date = startIso ? new Date(new Date(startIso).getTime() + 12 * 3600e3) : new Date(Date.now() - i * DAY);
  const opts = (o) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).format(date);
  return { day: i === 0 ? "Today" : opts({ weekday: "short" }), short: opts({ weekday: "narrow" }), date: opts({ month: "short", day: "numeric" }) };
}

function statusOf(activity) {
  if (!activity) return undefined;
  const where = activity.areaName ? ` · ${activity.areaName}` : "";
  if (activity.__typename === "OngoingWalk") return `On a walk${where}`;
  if (activity.__typename === "OngoingRest") return `Resting${where}`;
  return undefined;
}

/** The restFeed day for `i` days ago, or undefined when Fi answered with another day. */
function feedDay(pet, i, tz, now) {
  const summary = pet[`rest${i}`]?.restSummary;
  const start = summary?.start ? new Date(summary.start).getTime() : NaN;
  if (!Number.isFinite(start)) return undefined;
  return ymd(new Date(start + 12 * 3600e3), tz) === dayString(i, tz, now) ? summary : undefined;
}

function shapeTracker(pet, { tz, metric, h12, now = new Date() }) {
  const today = pet.today ?? {};
  const steps = (pet.stepDays?.activitySummaries ?? []).slice(0, DAYS);
  const sleeps = (pet.sleepDays?.restSummaries ?? []).slice(0, DAYS);
  const feed = Array.from({ length: DAYS }, (_, i) => feedDay(pet, i, tz, now));
  // Use the app's feed as soon as it holds anything; otherwise the older one.
  const modern = feed.some((f) => (num(f?.restSecondsTotal) ?? 0) > 0);
  const count = Math.max(steps.length, sleeps.length, modern ? DAYS : 0, 1);

  const days = [];
  for (let i = 0; i < count; i++) {
    const s = steps[i] ?? {};
    const r = sleeps[i];
    const daySteps = i === 0 ? num(today.totalSteps) ?? num(s.totalSteps) ?? 0 : num(s.totalSteps) ?? 0;
    const goal = num(s.stepGoal) ?? num(today.stepGoal) ?? 0;
    const sleep = modern ? num(feed[i]?.sleepSecondsTotal) ?? 0 : sleepSeconds(r, "SLEEP");
    const nap = modern ? num(feed[i]?.napSecondsTotal) ?? 0 : sleepSeconds(r, "NAP");
    days.push({
      ...dayLabels(i, tz, modern ? undefined : r?.start),
      distance_m: num(s.totalDistance) ?? 0,
      steps: daySteps,
      steps_label: fmt(daySteps),
      goal,
      met: goal > 0 && daySteps >= goal,
      sleep_h: Math.round((sleep / 3600) * 10) / 10,
      nap_h: Math.round((nap / 3600) * 10) / 10,
      sleep: duration(sleep),
      nap: duration(nap),
      rest: duration(sleep + nap),
    });
  }
  days.reverse(); // oldest → today, for left-to-right charts

  const todayDay = days[days.length - 1];
  // Fi books a night's sleep once it has happened, so in the evening today's SLEEP is still 0:
  // fall back to the previous day's entry and call it last night.
  const lastNight = todayDay.sleep_h > 0 || days.length < 2 ? todayDay : days[days.length - 2];
  const todaySteps = todayDay.steps;
  const goal = num(today.stepGoal) ?? todayDay.goal;
  const weekSteps = days.reduce((t, d) => t + d.steps, 0);
  const avgSleepH = days.reduce((t, d) => t + d.sleep_h, 0) / days.length;
  const avgNapH = days.reduce((t, d) => t + d.nap_h, 0) / days.length;
  const best = days.reduce((a, d) => (d.steps > a.steps ? d : a), days[0]);
  const maxSteps = Math.max(goal, ...days.map((d) => d.steps), 1);
  const maxRest = Math.max(...days.map((d) => d.sleep_h + d.nap_h), 1);
  for (const d of days) {
    d.steps_pct = Math.round((d.steps / maxSteps) * 100);
    d.sleep_pct = Math.round((d.sleep_h / maxRest) * 100);
    d.nap_pct = Math.round((d.nap_h / maxRest) * 100);
  }

  let battery;
  try {
    const info = typeof pet.device?.info === "string" ? JSON.parse(pet.device.info) : pet.device?.info;
    battery = num(info?.batteryPercent);
  } catch {}

  return {
    pet: { name: pet.name?.trim() || "Your dog", breed: pet.breed?.name ?? "", battery, status: statusOf(pet.ongoingActivity) },
    today: {
      steps: todaySteps,
      steps_label: fmt(todaySteps),
      goal,
      goal_label: fmt(goal),
      pct: goal ? Math.round((todaySteps / goal) * 100) : 0,
      bar_pct: goal ? Math.min(100, Math.round((todaySteps / goal) * 100)) : 0,
      to_go: goal > todaySteps ? fmt(goal - todaySteps) : "0",
      distance: distance(num(today.totalDistance), metric),
      sleep: lastNight.sleep,
      // The app's feed books a night on the day it ends, so today's sleep is last night's.
      sleep_title: modern || lastNight !== todayDay ? "Last night" : "Sleep today",
      nap: todayDay.nap,
      rest: duration((lastNight.sleep_h + todayDay.nap_h) * 3600),
      sleep_h: lastNight.sleep_h,
    },
    week: {
      steps_label: fmt(weekSteps),
      avg_steps: fmt(weekSteps / days.length),
      goal_days: days.filter((d) => d.met).length,
      day_count: days.length,
      distance: distance(days.reduce((t, d) => t + d.distance_m, 0), metric),
      avg_sleep: duration(avgSleepH * 3600),
      avg_nap: duration(avgNapH * 3600),
      best_day: best.day,
      best_steps: best.steps_label,
      max_steps: fmt(maxSteps),
    },
    days,
    updated: clock(now.getTime(), tz, h12),
  };
}

function demoPet(name) {
  const steps = [9120, 13250, 7480, 11030, 15600, 10240, 6420]; // newest first
  const sleep = [9.6, 10.4, 11.1, 9.2, 12.0, 10.8, 9.9];
  const nap = [2.1, 3.4, 2.8, 1.9, 3.1, 2.5, 2.2];
  return {
    name,
    breed: { name: "Dachshund" },
    device: { info: { batteryPercent: 76 } },
    ongoingActivity: { __typename: "OngoingRest", areaName: "Home" },
    today: { totalSteps: steps[0], stepGoal: 10000, totalDistance: 6100 },
    stepDays: { activitySummaries: steps.map((s) => ({ totalSteps: s, stepGoal: 10000 })) },
    sleepDays: {
      restSummaries: sleep.map((h, i) => ({
        data: { sleepAmounts: [{ type: "SLEEP", duration: h * 3600 }, { type: "NAP", duration: nap[i] * 3600 }] },
      })),
    },
  };
}

// ---------- walk timer ----------
// facts: { name, walks: [{ start, end, distance }] newest first, ongoingWalk: { start, distance } | null,
//          restStart: ms | null (used only when no walk history is available), history: false when
//          Fi's activity feed could not be read }
// Returns one of four screens: resting, walk due, on a walk, good morning.
function shapeWalk(facts, o) {
  const { tz, now, maxMs, pronoun, h12, metric } = o;
  const off = tzOffset(now, tz);
  const wall = (ms) => ms + off; // fake-UTC local time, good enough within a couple of days
  const dayOf = (ms) => Math.floor(wall(ms) / DAY);
  const minutesOfDay = (ms) => { const d = new Date(wall(ms)); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const at = (ms) => clock(ms, tz, h12);
  const dist = (m) => (m > 0 ? distance(m, metric) : "");
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const today = dayOf(now);
  const name = facts.name || "Your dog";
  const walks = (facts.walks ?? []).filter((w) => w.end && w.end <= now).sort((a, b) => b.end - a.end);
  const todays = walks.filter((w) => dayOf(w.end) === today);
  const lastEnd = walks[0]?.end ?? facts.restStart ?? null;
  const since = lastEnd ? now - lastEnd : null;
  const out = {};

  let state;
  if (facts.ongoingWalk) state = "walking";
  else if (todays.length === 0 && !(facts.restStart && !walks.length && dayOf(facts.restStart) === today && minutesOfDay(facts.restStart) > AXIS_START)
           && minutesOfDay(now) < AXIS_START + maxMs / 60000) state = "morning";
  else if (since === null || since >= maxMs) state = "due";
  else state = "resting";
  out.state = state;

  let pct = 0;
  if (state === "walking") {
    const w = facts.ongoingWalk;
    out.big = span(now - w.start);
    out.sub = "out on a walk";
    const d = dist(w.distance);
    out.status = `Left at ${at(w.start)}${d ? ` · ${d} so far` : ""}`;
    out.label = "On a walk";
  } else if (state === "morning") {
    out.line1 = `Ready for ${pronoun}`;
    out.line2 = "first walk";
    out.big = "";
    out.sub = "";
    if (lastEnd) {
      const ago = today - dayOf(lastEnd);
      const when = ago === 0 ? "today" : ago === 1 ? "yesterday" : `on ${WEEKDAYS[new Date(wall(lastEnd)).getUTCDay()]}`;
      out.status = `Last walk ${when} at ${at(lastEnd)}`;
    } else out.status = `Good morning, ${name}`;
    out.label = "Good morning";
  } else if (state === "due") {
    if (since === null) { out.big = "Due"; out.sub = "for a walk"; out.status = "No walk recorded yet"; }
    else {
      out.big = span(since);
      out.sub = "since last walk";
      out.status = `Walk due · ${spanLong(since - maxMs)} over`;
    }
    pct = 100;
    out.label = "Walk due";
  } else {
    out.big = span(since);
    out.sub = "since last walk";
    out.status = `Next walk due by ${at(lastEnd + maxMs)}`;
    pct = Math.max(2, Math.min(100, Math.round((since / maxMs) * 100)));
    out.label = "Resting";
  }
  out.ring = { pct, dash: `${Math.round((pct / 100) * RING)} ${Math.ceil(RING)}` };
  out.limit = spanLong(maxMs);

  // day strip
  const x = (ms) => {
    if (dayOf(ms) < today) return 0;
    if (dayOf(ms) > today) return 100;
    return Math.max(0, Math.min(100, ((minutesOfDay(ms) - AXIS_START) / (AXIS_END - AXIS_START)) * 100));
  };
  const blocks = todays.map((w) => {
    const left = x(w.start ?? w.end);
    return { left: Math.round(left * 10) / 10, width: Math.max(2, Math.round((x(w.end) - left) * 10) / 10), live: false };
  }).reverse();
  const nowX = x(now);
  if (facts.ongoingWalk) {
    const left = x(facts.ongoingWalk.start);
    blocks.push({ left: Math.round(left * 10) / 10, width: Math.max(2, Math.round((nowX - left) * 10) / 10), live: true });
  }
  for (const b of blocks) if (b.left + b.width > 100) b.left = Math.max(0, 100 - b.width);
  const count = todays.length + (facts.ongoingWalk ? 1 : 0);
  const minutes = todays.reduce((t, w) => t + (w.start ? w.end - w.start : 0), 0) + (facts.ongoingWalk ? now - facts.ongoingWalk.start : 0);
  const inAxis = minutesOfDay(now) >= AXIS_START && minutesOfDay(now) <= AXIS_END;
  out.strip = {
    count,
    summary: count === 0 ? "None yet" : `${count} ${count === 1 ? "walk" : "walks"}${minutes > 0 ? ` · ${spanLong(minutes)}` : ""}`,
    blocks,
    now: Math.round(nowX * 10) / 10,
    show_now: inAxis,
    known: facts.history !== false,
  };
  out.axis = h12 ? ["6a", "10a", "2p", "6p", "10p"] : ["06", "10", "14", "18", "22"];
  return out;
}

function demoFacts(kind, tz, name) {
  // A fixed sample afternoon (or morning) so the store preview always looks the same.
  const real = Date.now();
  const off = tzOffset(real, tz);
  const midnight = Math.floor((real + off) / DAY) * DAY - off;
  const at = (h, m) => midnight + (h * 60 + m) * 60000;
  const morningWalk = { start: at(8, 5), end: at(8, 28), distance: 900 };
  const yesterday = { start: at(-3, 15), end: at(-2, -20), distance: 1200 };
  if (kind === "morning") return { now: at(8, 2), facts: { name, walks: [yesterday], ongoingWalk: null } };
  if (kind === "walking") return { now: at(16, 46), facts: { name, walks: [morningWalk, yesterday], ongoingWalk: { start: at(16, 28), distance: 640 } } };
  if (kind === "due") return { now: at(16, 46), facts: { name, walks: [{ start: at(11, 50), end: at(12, 14), distance: 1100 }, morningWalk, yesterday], ongoingWalk: null } };
  return { now: at(16, 46), facts: { name, walks: [{ start: at(14, 8), end: at(14, 32), distance: 1100 }, morningWalk, yesterday], ongoingWalk: null } };
}

/** "38% of step goal" for the walk timer's title bar, or nothing when Fi has no goal. */
const goalNote = (today) => (today?.goal > 0 ? `${today.pct}% of step goal` : undefined);

// ---------- entry point ----------
async function run(input) {
  const tz = validTz(input?.trmnl?.user?.time_zone_iana || "America/New_York");
  const viewSetting = String(setting(input, "view") || "both").toLowerCase();
  const view = VIEWS.includes(viewSetting) ? viewSetting : "both";
  const walkView = view === "walk";
  const metric = setting(input, "units") === "metric";
  const h12 = String(setting(input, "time_format") || "12") !== "24";
  const email = setting(input, "email");
  const password = setting(input, "password");
  const wanted = String(setting(input, "pet_name") || "");
  const hours = parseFloat(String(setting(input, "max_hours") ?? "").replace(",", "."));
  const maxMs = (Number.isFinite(hours) ? Math.min(24, Math.max(0.5, hours)) : 4) * 3600e3;
  const preview = walkView ? String(setting(input, "preview_state") || "live") : "live";
  // The pronoun on the morning screen comes from the dog's sex in Fi. Installs made before
  // that was read automatically may still carry their own choice, used when Fi has none.
  const legacyPronoun = String(setting(input, "pronoun") || "").toLowerCase();
  const pronounOf = (gender) =>
    /^f/i.test(gender ?? "") ? "her" : /^m/i.test(gender ?? "") ? "his" : ["her", "his", "their"].includes(legacyPronoun) ? legacyPronoun : "their";
  const base = { tz, metric, h12 };
  const sampleName = wanted || "Luna";
  const sampleWalk = (kind) => {
    const demo = demoFacts(kind, tz, sampleName);
    return shapeWalk(demo.facts, { ...base, now: demo.now, maxMs, pronoun: pronounOf(wanted ? undefined : "FEMALE") });
  };

  // No login yet: every screen works with sample data, so the plugin can be tried before signing in.
  if (!email || !password) {
    const out = { view, demo: true, sample: true, ...shapeTracker(demoPet(sampleName), base) };
    if (walkView) out.walk = sampleWalk(preview === "live" ? "resting" : preview);
    return out;
  }
  // Walk timer preview: one of its four screens with sample data, without calling Fi.
  if (preview !== "live") {
    return { view, demo: true, pet: { name: sampleName }, walk: sampleWalk(preview), updated: clock(Date.now(), tz, h12) };
  }

  try {
    const cookie = await login(email, password);
    const [mainR, walkingR, feedR] = await Promise.allSettled([
      graphql(cookie, petsQuery(tz, !walkView)),
      walkView ? graphql(cookie, Q_WALKING) : null,
      walkView ? graphql(cookie, Q_FEED) : null,
    ]);
    if (mainR.status !== "fulfilled") throw mainR.reason;
    const pets = petsOf(mainR.value);
    if (pets.length === 0) return { view, error: "No dogs found on this Fi account." };
    const pet = pets.find((p) => wanted && p.name?.trim().toLowerCase() === wanted.toLowerCase()) ?? pets[0];
    const out = { view, ...shapeTracker(pet, base) };
    if (!walkView) return out;

    // The walk timer shows no 7-day history, and none was fetched for it.
    delete out.week;
    delete out.days;
    const byId = (r) => (r.status === "fulfilled" ? petsOf(r.value).find((p) => p.id === pet.id) : undefined);
    const ms = (v) => { const t = typeof v === "number" ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
    const facts = { name: pet.name?.trim(), walks: [], ongoingWalk: null, restStart: null };
    const ongoing = pet.ongoingActivity;
    if (ongoing?.__typename === "OngoingWalk" && ms(ongoing.start)) {
      facts.ongoingWalk = { start: ms(ongoing.start), distance: Number(byId(walkingR)?.ongoingActivity?.distance) || 0 };
    } else if (ongoing?.__typename === "OngoingRest") facts.restStart = ms(ongoing.start);
    const feed = byId(feedR)?.activityFeed?.activities;
    if (Array.isArray(feed)) {
      facts.walks = feed.filter((a) => a?.__typename === "Walk" && ms(a.end)).map((a) => ({ start: ms(a.start), end: ms(a.end), distance: Number(a.distance) || 0 }));
    } else facts.history = false;
    out.walk = shapeWalk(facts, { ...base, now: Date.now(), maxMs, pronoun: pronounOf(pet.gender) });
    out.walk.goal_note = goalNote(out.today);
    return out;
  } catch (error) {
    return { view, error: error?.message ?? String(error) };
  }
}
