// Luxer One → TRMNL serverless function (Node 20).
// Signs each account in with the emailed one-time code (Luxer One has no password login any more),
// keeps the long-lived tokens in this install's saved state, and lists packages waiting for pickup
// across up to five accounts, with a total and a subtotal per person.

const API = "https://resident-api.luxerone.com/resident_api/v2";
const IDLE_HIDE_MS = 24 * 3600e3; // hide after a full day with nothing to pick up
// The page the optional on-screen QR code opens. Fixed here on purpose: it is not a form setting.
const PICKUP_PAGE = "https://justin-m-schmidt.github.io/luxer-one-locker-codes-page-for-trmnl/";
// Form fields per person. The form reveals each next block once the email before it is filled in.
const SLOTS = [1, 2, 3, 4, 5].map((n) => ({
  n,
  email: n === 1 ? "email" : `email_${n}`,
  code: n === 1 ? "code" : `code_${n}`,
  name: n === 1 ? "nickname" : `nickname_${n}`,
}));

function setting(input, key) {
  const value = input?.trmnl?.plugin_settings?.custom_fields_values?.[key] ?? input?.[key];
  return typeof value === "string" ? value.trim() : value;
}

// Switches are boolean fields now; installs made before that saved "yes" / "no".
function on(input, key) {
  const v = setting(input, key);
  return v === true || v === "true" || v === "yes" || v === "1";
}

async function api(method, path, token, body) {
  const headers = { accept: "application/json", "content-type": "application/json" };
  if (token) headers.authorization = `LuxerOneApi ${token}`;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(2000),
  });
  const json = (await res.json().catch(() => undefined)) ?? {};
  const data = json && typeof json.data === "object" && json.data !== null ? json.data : json;
  const denied = res.status === 401 || res.status === 403 || json.error === "ApiAuthorizationRequired";
  return { status: res.status, json, data, denied };
}

function newUuid() {
  try { return crypto.randomUUID().toUpperCase(); } catch { /* fall through */ }
  return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)).toUpperCase();
}

async function sendCode(email) {
  const r = await api("POST", "/auth/loginUsingEmail", null, { email });
  return (r.data?.status ?? r.json?.status) === "OK";
}

// ---------- accounts ----------
function accountsFrom(input) {
  const seen = new Set();
  const list = [];
  for (const slot of SLOTS) {
    const email = String(setting(input, slot.email) || "").toLowerCase();
    // The form hides everything after the first empty email, so later leftovers are ignored too.
    if (!email) break;
    if (seen.has(email)) continue;
    seen.add(email);
    const local = email.split("@")[0].split(/[._+-]/)[0] || `Account ${slot.n}`;
    list.push({
      slot: slot.n,
      email,
      code: String(setting(input, slot.code) || "").replace(/\s+/g, ""),
      name: String(setting(input, slot.name) || "").slice(0, 14) || local.charAt(0).toUpperCase() + local.slice(1),
      field: slot.n === 1 ? "Verification code" : `Person ${slot.n} verification code`,
    });
  }
  return list;
}

// Saved state is { accounts: { [email]: { uuid, token, code_tried, code_sent_at } } }.
// The first version kept one account at the top level, and one kept a single shared code_tried; carry both over.
function savedAccounts(saved) {
  if (!saved || typeof saved !== "object") return {};
  if (saved.accounts && typeof saved.accounts === "object") {
    if (typeof saved.code_tried !== "string") return saved.accounts;
    const out = {};
    for (const [email, s] of Object.entries(saved.accounts)) out[email] = { code_tried: saved.code_tried, ...(s || {}) };
    if (saved.awaiting?.email && out[saved.awaiting.email]) out[saved.awaiting.email].code_sent_at ??= saved.awaiting.sent_at;
    return out;
  }
  if (saved.email) {
    const { email, ...rest } = saved;
    return { [email]: rest };
  }
  return {};
}

// Lifetime count of packages already picked up, from the account's delivery history. The list can be long,
// so it is only read again when the number of waiting packages changes, or twice a day.
// The API answers 50 entries at a time; whether and how it pages is not documented, so this asks for a
// bigger page first and then tries the usual paging styles, and marks the count "or more" if none works.
const HISTORY_MAX_AGE_MS = 12 * 3600e3;
const HISTORY_PAGE = 50;
async function pickedUpCount(token, waiting, probe) {
  const started = Date.now();
  const read = async (query) => {
    const r = await api("GET", `/deliveries/history${query}`, token);
    const d = r.data;
    const list = Array.isArray(d) ? d : d?.deliveries ?? d?.history ?? d?.packages ?? Object.values(d ?? {}).find(Array.isArray);
    return { list: Array.isArray(list) ? list : null, status: r.status, keys: Object.keys(d ?? {}).slice(0, 8).join(" ") };
  };
  const first = await read("?limit=1000&per_page=1000&pageSize=1000");
  if (!first.list) return { diag: `history: HTTP ${first.status}, keys ${first.keys || "none"}` };
  const seen = new Map(first.list.map((p, i) => [p?.id ?? `0-${i}`, p]));
  let how = "one request";
  let more = false;
  if (first.list.length === HISTORY_PAGE) {
    more = true;
    how = "latest 50 only";
  }
  if (more && probe) {
    const styles = [(n) => `?page=${n}`, (n) => `?offset=${(n - 1) * HISTORY_PAGE}`, (n) => `?skip=${(n - 1) * HISTORY_PAGE}`, (n) => `?start=${(n - 1) * HISTORY_PAGE}`];
    const tries = await Promise.all(styles.map((s) => read(s(2)).catch(() => ({ list: null }))));
    const hit = tries.findIndex((r) => r.list && r.list.length > 0 && r.list.some((p) => p?.id !== undefined && !seen.has(p.id)));
    if (hit >= 0) {
      how = `paged with ${styles[hit](2).slice(1).split("=")[0]}`;
      let page = tries[hit].list;
      for (let n = 3; ; n += 1) {
        const before = seen.size;
        page.forEach((p, i) => seen.set(p?.id ?? `${n}-${i}`, p));
        if (page.length < HISTORY_PAGE || seen.size === before) { more = false; break; }
        if (n > 40 || Date.now() - started > 2200) break;
        page = (await read(styles[hit](n)).catch(() => ({ list: null }))).list ?? [];
      }
    } else how = "no paging found";
  }
  const all = [...seen.values()];
  const flagged = all.filter((p) => p && (p.pickedUp || p.pickedup || p.pickedUpAt || p.pickedupAt || p.picked_up)).length;
  // Entries carry a pickup time once collected; if none do, everything that is not waiting counts as collected.
  const n = flagged > 0 ? flagged : Math.max(0, all.length - waiting);
  // Newest entry id, so later reads can count what was added even when only the latest 50 are offered.
  const done = (p) => p && (flagged === 0 || p.pickedUp || p.pickedup || p.pickedUpAt || p.pickedupAt || p.picked_up);
  const ids = all.filter(done).map((p) => Number(p.id)).filter(Number.isFinite);
  const top = ids.length ? Math.max(...ids) : 0;
  const since = (id) => all.filter((p) => done(p) && Number(p.id) > id).length;
  return { n, more, top, since, diag: `history: ${all.length} entries, ${flagged} picked up, ${how}${more ? ", more exist" : ""}` };
}

// Returns { s, deliveries } on success, { s, auth: step } when a code is needed, { s, error } otherwise.
async function loadAccount(a, previous, now) {
  const s = previous && typeof previous === "object" ? { ...previous } : {};
  if (!s.uuid) s.uuid = newUuid();
  let justSignedIn = false;
  try {
    if (!s.token) {
      if (a.code && a.code !== s.code_tried) {
        justSignedIn = true;
        const r = await api("POST", "/auth/verifyOtpUsingEmail", null, { email: a.email, uuid: s.uuid, otp: a.code, as: "token" });
        s.code_tried = a.code;
        const token = r.data?.token ?? r.json?.token;
        if (typeof token === "string" && token) {
          s.token = token;
          delete s.code_sent_at;
        } else {
          if (await sendCode(a.email)) s.code_sent_at = now;
          return { s, auth: "rejected" };
        }
      } else if (!s.code_sent_at) {
        if (!(await sendCode(a.email))) return { s, error: `Luxer One did not accept ${a.email}. Use the address from the Luxer One app.` };
        s.code_sent_at = now;
        return { s, auth: "sent" };
      } else {
        return { s, auth: "waiting" };
      }
    }
    const r = await api("GET", "/deliveries/pendings", s.token);
    if (r.denied) {
      delete s.token;
      s.code_tried = a.code;
      if (await sendCode(a.email)) s.code_sent_at = now; else delete s.code_sent_at;
      return { s, auth: "expired" };
    }
    const deliveries = r.data?.deliveries ?? r.json?.deliveries ?? (Array.isArray(r.data) ? r.data : null);
    if (!Array.isArray(deliveries)) return { s, error: `Luxer One answered unexpectedly (HTTP ${r.status}).` };
    let hdiag = "";
    // Skipped in the run that signs in, to stay inside the time limit; the next refresh picks it up.
    if (!justSignedIn && (s.hist?.v !== 2 || now - s.hist.at > HISTORY_MAX_AGE_MS || s.hist.waiting !== deliveries.length)) {
      try {
        const h = await pickedUpCount(s.token, deliveries.length, !(s.hist?.v === 2 && s.hist.more));
        hdiag = h.diag;
        if (Number.isFinite(h.n)) {
          // Capped list: keep the earlier count and add only entries newer than the last one seen.
          const grown = h.more && s.hist?.v === 2 && s.hist.more && s.hist.top > 0 && Number.isFinite(s.hist.n);
          s.hist = { v: 2, n: grown ? s.hist.n + h.since(s.hist.top) : h.n, at: now, waiting: deliveries.length, top: h.top, ...(h.more ? { more: true } : {}) };
        }
        else if (s.hist?.v !== 2) s.hist = { v: 2, at: now, waiting: deliveries.length }; // not available: do not ask again every refresh
      } catch (error) { hdiag = `history: ${error?.name ?? "error"}`; }
    }
    return { s, deliveries, hdiag };
  } catch (error) {
    return { s, error: `Could not reach Luxer One (${error?.name ?? "error"}).` };
  }
}

// ---------- shaping ----------
function validTz(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return "America/New_York"; }
}
function dayKey(ms, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
function toMs(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v < 1e11 ? v * 1000 : v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return toMs(Number(s));
  const t = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(s) ? s.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z") : s);
  return Number.isFinite(t) ? t : null;
}
// Same day (or the last few hours): time since delivery in 15-minute steps, matching the refresh rate.
// Older: Yesterday, the weekday, then a day count.
function whenLabel(ms, now, tz) {
  if (!ms) return "";
  const age = now - ms;
  const days = Math.round((Date.parse(dayKey(now, tz)) - Date.parse(dayKey(ms, tz))) / 86400e3);
  if (age >= 0 && (days <= 0 || age < 6 * 3600e3)) {
    const q = Math.floor(age / 900e3) * 15;
    if (q < 15) return "Just now";
    if (q < 60) return `${q} min ago`;
    const h = Math.floor(q / 60);
    const m = q % 60;
    if (h < 3 && m) return `${h} hr ${m} min ago`;
    return h === 1 ? "1 hour ago" : `${h} hours ago`;
  }
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(new Date(ms));
  return `${days} days ago`;
}
const pick = (o, keys) => { for (const k of keys) { const v = o?.[k]; if (v !== null && v !== undefined && v !== "") return v; } return undefined; };
const text = (v) => (v === null || v === undefined ? "" : String(v).trim());

// Monochrome carrier marks from Icons8 (https://icons8.com), matched loosely because the API's
// carrier names vary ("Amazon Logistics", "UPS Ground"). Unknown carriers get a plain box and their name.
const ICON = (id) => `https://img.icons8.com/?id=${id}&format=png&size=96`;
const CARRIERS = [
  { test: /usps|postal|post office/i, name: "USPS", icon: ICON("izp3V7qsEkP5") },
  { test: /amazon|amzl/i, name: "Amazon", icon: ICON("36099") },
  { test: /fedex|federal express/i, name: "FedEx", icon: ICON("VYJza0ORlkVJ") },
  { test: /dhl/i, name: "DHL", icon: ICON("GmtCaQWf1gbn") },
  { test: /\bups\b|united parcel/i, name: "UPS", icon: ICON("Of9jnoRhst7S") },
];
function carrierOf(raw) {
  const s = text(raw);
  const hit = CARRIERS.find((c) => c.test.test(s));
  if (hit) return { name: hit.name, icon: hit.icon };
  return { name: s || "Package", icon: "" };
}

function rows(deliveries, who, o) {
  return (Array.isArray(deliveries) ? deliveries : []).map((d) => {
    const carrierObj = typeof d?.carrier === "object" && d.carrier ? d.carrier : null;
    const lockerObj = typeof d?.locker === "object" && d.locker ? d.locker : null;
    const delivered = toMs(pick(d, ["delivered", "deliveredAt", "deliveredOn", "deliveryDate", "created", "createdAt"]));
    const locker = text(pick(lockerObj ?? d, ["lockerNumber", "number", "lockerName", "name"]));
    const place = text(pick(d, ["lockerLocation", "location", "locationName"]));
    const when = whenLabel(delivered, o.now, o.tz);
    const perishable = d?.isPerishable === true || d?.isPerishable === 1 || d?.isPerishable === "1";
    const where = locker ? `Locker ${locker}` : place;
    const carrier = carrierOf(carrierObj ? pick(carrierObj, ["name", "carrier", "title"]) : pick(d, ["carrier", "carrierName", "courier"]));
    const named = carrier.icon || carrier.name === "Package" ? "" : carrier.name;
    return {
      carrier: carrier.name,
      icon: carrier.icon,
      title: where || carrier.name,
      detail: [when, where ? named : "", perishable ? "Perishable" : ""].filter(Boolean).join(" · "),
      code: o.codes ? text(pick(d, ["accessCode", "pickupCode", "code"])) : "",
      secret: text(pick(d, ["accessCode", "pickupCode", "code"])),
      who,
      delivered: delivered ?? 0,
    };
  });
}

// groups: [{ name, deliveries }] for accounts that loaded, [{ name, note }] for ones that did not.
function shape(groups, o) {
  const multi = groups.length > 1;
  const list = groups
    .flatMap((g) => rows(g.deliveries, multi ? g.name : "", o))
    .sort((a, b) => b.delivered - a.delivered);
  const count = list.length;
  return {
    state: count > 0 ? "packages" : "empty",
    count,
    noun: count === 1 ? "package" : "packages",
    multi,
    people: multi ? groups.map((g) => (g.note ? { name: g.name, note: g.note } : { name: g.name, count: g.deliveries.length })) : [],
    pickup_url: pickupUrl(list, o.page),
    pickup_qr: qrSize(pickupUrl(list, o.page)),
    packages: list.slice(0, 8).map(({ delivered, secret, ...p }) => p),
  };
}

// Optional: a link for the on-screen QR code. The codes go after the "#", which a browser keeps to itself
// and never sends to the server hosting the page; the page draws the number and locker QR on the phone.
function pageBase(raw) {
  const s = String(raw || "").trim().split("#")[0];
  return /^https:\/\/[^\s"<>]+$/i.test(s) ? s : "";
}
function pickupUrl(list, page) {
  if (!page) return "";
  const part = (v) => encodeURIComponent(String(v ?? "").replace(/~/g, "-").slice(0, 40));
  const place = (p) => {
    if (p.title === p.carrier) return "";
    const m = /^Locker (\S+)$/.exec(p.title);
    return m ? `*${m[1]}` : p.title;
  };
  const items = list.filter((p) => p.secret).slice(0, 6).map((p) => [p.who, p.carrier === "Package" ? "" : p.carrier, place(p), p.secret].map(part).join("~").replace(/%2A/g, "*"));
  return items.length > 0 ? `${page}#${items.join(";")}` : "";
}

// A longer link needs a denser QR code, so it is drawn a little larger to stay scannable
function qrSize(url) {
  if (!url) return 0;
  return url.length <= 90 ? 92 : url.length <= 150 ? 108 : 124;
}

function clock(now, tz, h12) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: h12 }).format(new Date(now));
}

const SAMPLE = (now) => [
  { carrier: "Amazon", lockerNumber: "14", delivered: now - 40 * 60e3, accessCode: "482913" },
  { carrier: "UPS", lockerNumber: "7", delivered: now - 26 * 3600e3, accessCode: "175046" },
  { carrier: "USPS", lockerNumber: "22", delivered: now - 3 * 86400e3, accessCode: "903317" },
];

async function run(input) {
  const tz = validTz(input?.trmnl?.user?.time_zone_iana || "America/New_York");
  const now = Date.now();
  const o = { tz, now, codes: on(input, "show_codes"), page: on(input, "phone_qr") ? pageBase(PICKUP_PAGE) : "" };
  const base = { updated: clock(now, tz, true) };
  const accounts = accountsFrom(input);
  const preview = String(setting(input, "preview_state") || "live");

  if (preview !== "live" || accounts.length === 0) {
    // Sample data: split between the configured nicknames, or two example people before any account is added.
    // "duo" previews the shared layout even when only one account is set up.
    let names = accounts.map((a) => a.name);
    if (names.length === 0 || (preview === "duo" && names.length < 2)) names = [names[0] ?? "Alex", "Sam"];
    const sample = preview === "empty" ? [] : SAMPLE(now);
    const groups = names.map((name, i) => ({ name, deliveries: sample.filter((_, k) => (names.length === 1 ? true : i === 0 ? k !== 1 : i === 1 && k === 1)) }));
    return { ...base, demo: true, sample: accounts.length === 0, ...shape(groups, o), picked_total: 128, picked_more: false };
  }

  const saved = input?.trmnl?.state;
  const before = savedAccounts(saved);
  const results = await Promise.all(accounts.map((a) => loadAccount(a, before[a.email], now)));
  const trmnl_state = { accounts: {} };
  accounts.forEach((a, i) => { trmnl_state.accounts[a.email] = results[i].s; });
  // When the lockers were first seen empty, kept across refreshes for the optional "hide when idle" setting.
  const emptySince = Number(saved?.empty_since) > 0 ? Number(saved.empty_since) : 0;
  if (emptySince) trmnl_state.empty_since = emptySince;

  const loaded = results.some((r) => r.deliveries);
  if (!loaded) {
    // Nothing to show yet: lead with the first account that is waiting for its code.
    const i = results.findIndex((r) => r.auth);
    if (i >= 0) {
      const waiting = accounts.filter((_, k) => results[k].auth);
      const email = waiting.length === 1 ? waiting[0].email : `${waiting.slice(0, -1).map((a) => a.email).join(", ")} and ${waiting[waiting.length - 1].email}`;
      const field = waiting.length === 1 ? waiting[0].field : "each person's Verification code";
      return { ...base, state: "auth", step: results[i].auth, email, field, trmnl_state };
    }
    return { ...base, state: "error", error: results[0].error, trmnl_state };
  }

  const groups = accounts.map((a, i) => {
    const r = results[i];
    if (r.deliveries) return { name: a.name, deliveries: r.deliveries };
    return { name: a.name, deliveries: [], note: r.auth ? "enter emailed code" : "unavailable" };
  });
  const pending = accounts.filter((_, i) => !results[i].deliveries);
  const first = results.find((r) => r.deliveries?.length)?.deliveries[0];
  const shaped = shape(groups, o);
  // Idle = every account answered and nothing is waiting. One account failing to load keeps the clock as it was.
  let hide = false;
  if (pending.length === 0) {
    if (shaped.count > 0) delete trmnl_state.empty_since;
    else {
      if (!trmnl_state.empty_since) trmnl_state.empty_since = now;
      hide = on(input, "hide_when_idle") && now - trmnl_state.empty_since >= IDLE_HIDE_MS;
    }
  }
  return {
    ...base,
    ...shaped,
    // Tells TRMNL to leave this screen out of the playlist rotation; the layouts set the same flag in markup.
    ...(hide ? { hide: true, TRMNL_SKIP_DISPLAY: true } : { hide: false }),
    notice: pending.length > 0 ? `${pending.map((a) => a.name).join(", ")}: ${results[accounts.indexOf(pending[0])].auth ? "sign-in needed" : "unavailable"}` : "",
    // Shown on the "All picked up" screen. Left at 0 while any account's history is unknown.
    picked_total: results.every((r) => Number.isFinite(r.s?.hist?.n)) ? results.reduce((sum, r) => sum + r.s.hist.n, 0) : 0,
    picked_more: results.some((r) => r.s?.hist?.more === true),
    diag: [first ? `fields: ${Object.keys(first).join(" ")}` : "no deliveries", ...results.map((r) => r.hdiag).filter(Boolean)].join(" | "),
    trmnl_state,
  };
}

module.exports = { run };
