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
const CAND = "start end date period title strain strainScore strainLevel strainValue score level label value steps totalSteps stepGoal goal stepGoalPercent percent data id type rank region state stateName areaName name total count change delta trend previousRank rankChange percentile entries pets pet petId stats week weekStart description size participants totalPets".split(" ");
function digest(r) {
  if (!r?.errors) return JSON.stringify(r).slice(0, 1200);
  const bad = {};
  const notes = [];
  for (const e of r.errors) {
    const m = /Cannot query field "(\w+)" on type "(\w+)"\.(.*)/.exec(e.message);
    if (m) { (bad[m[2]] ??= new Set()).add(m[1]); if (m[3].trim()) notes.push(`${m[2]}.${m[1]}:${m[3].trim()}`); }
    else notes.push(e.message);
  }
  const valid = Object.entries(bad).map(([t, s]) => `${t} VALID[${CAND.filter((c) => !s.has(c)).join(",")}]`);
  return `${valid.join(" ; ")} NOTES[${notes.join(" / ")}]`.slice(0, 2500);
}
const raw = (r) => (r?.errors ? r.errors.map((e) => e.message).join(" / ") : JSON.stringify(r)).slice(0, 600);
async function run(input) {
  try {
    const cookie = await login(setting(input, "email"), setting(input, "password"));
    const u = await gql(cookie, `{ currentUser { userHouseholds { household { pets { id name } } } } }`);
    const id = u?.data?.currentUser?.userHouseholds?.[0]?.household?.pets?.[0]?.id;
    if (!id) return { probe: JSON.stringify(u).slice(0, 800) };
    const p = (b) => `{ pet(id: "${id}") { ${b} } }`;
    const windows = ["DAY", "DAILY", "WEEK", "WEEKLY", "MONTH", "MONTHLY", "ALL_TIME", "TODAY", "LAST_7_DAYS", "CURRENT_WEEK", "THIS_WEEK", "SEVEN_DAYS"];
    const wins = await Promise.all(windows.map(async (w) => `${w}: ${raw(await gql(cookie, `{ petRanking(petId: "${id}", window: ${w}) { score rank } }`))}`));
    const [a, b] = await Promise.all([
      gql(cookie, p(`stepFeed(period: DAY) { stepSummary { ${CAND.join(" ")} } }`)),
      gql(cookie, `{ leaderboard(window: WEEK) { window stats { ${CAND.join(" ")} } week { ${CAND.join(" ")} } entries { ${CAND.join(" ")} } } }`),
    ]);
    return { probe: [`STEPSUMMARY ${digest(a)}`, `LEADERBOARD ${digest(b)}`, ...wins].join("\n").slice(0, 9000) };
  } catch (e) {
    return { probe: `ERR ${e?.message ?? e}` };
  }
}
