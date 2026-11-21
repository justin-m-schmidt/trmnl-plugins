const FI = "https://api.tryfi.com";
const UA = "trmnl-fi-collar";
function setting(input, key) {
  const value = input?.trmnl?.plugin_settings?.custom_fields_values?.[key] ?? input?.[key];
  return typeof value === "string" ? value.trim() : value;
}
async function login(email, password) {
  const res = await fetch(`${FI}/auth/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA }, body: new URLSearchParams({ email, password }).toString(), signal: AbortSignal.timeout(2500) });
  const json = await res.json().catch(() => undefined);
  if (!res.ok || !json?.userId) throw new Error(`login failed ${res.status}`);
  const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : (res.headers.get("set-cookie") ?? "").split(/,(?=\s*[^;,=\s]+=)/);
  return cookies.map((c) => c.split(";")[0].trim()).filter((c) => c.includes("=")).join("; ");
}
async function gql(cookie, query) {
  try {
    const res = await fetch(`${FI}/graphql`, { method: "POST", headers: { cookie, "content-type": "application/json", accept: "application/json", "user-agent": UA }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(3000) });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { status: res.status, text: text.slice(0, 300) }; }
  } catch (e) { return { fetchError: String(e?.message ?? e) }; }
}
const CAND = "id title name label type rank score region regionName state stateName area areaName location place trend change delta previousRank rankChange direction pet pets entries leaderboard leaderboards myRank petRank myPetRank currentPetRank petRanks ranks cards sections items stats window period week start end description subtitle value count total percentile".split(" ");
function digest(r) {
  if (!r?.errors) return JSON.stringify(r).slice(0, 1500);
  const bad = {};
  const notes = [];
  for (const e of r.errors) {
    const m = /Cannot query field "(\w+)" on type "(\w+)"\.(.*)/.exec(e.message);
    if (m) { (bad[m[2]] ??= new Set()).add(m[1]); if (m[3].trim()) notes.push(`${m[2]}.${m[1]}:${m[3].trim()}`); }
    else notes.push(e.message);
  }
  const valid = Object.entries(bad).map(([t, s]) => `${t} VALID[${CAND.filter((c) => !s.has(c)).join(",")}]`);
  return `${valid.join(" ; ")} NOTES[${notes.join(" / ")}]`.slice(0, 3000);
}
const raw = (r) => (r?.errors ? r.errors.map((e) => e.message).join(" / ") : JSON.stringify(r)).slice(0, 900);
async function run(input) {
  try {
    const cookie = await login(setting(input, "email"), setting(input, "password"));
    const [a, b, c, d, e] = await Promise.all([
      gql(cookie, `{ leaderboardsHome { ${CAND.join(" ")} } }`),
      gql(cookie, `{ leaderboardsHome(zzz: 1) { __typename } }`),
      gql(cookie, `{ leaderboard(window: WEEKLY) { entries { rank score pet { id name } } } }`),
      gql(cookie, `{ leaderboardDirectory { ${CAND.join(" ")} } }`),
      gql(cookie, `{ leaderboardsHome { __typename } }`),
    ]);
    return { probe: [`HOME ${digest(a)}`, `HOME.args ${raw(b)}`, `LB ${raw(c)}`, `DIR ${digest(d)}`, `HOME.type ${raw(e)}`].join("\n").slice(0, 9500) };
  } catch (e) {
    return { probe: `ERR ${e?.message ?? e}` };
  }
}
