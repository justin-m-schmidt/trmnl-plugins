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
const CAND = "id title name label type kind rank score region regionName state stateName area areaName location place scope trend change delta previousRank rankChange direction movement pet pets entries petRank myRank rank petEntry entry stats window period week start end description subtitle value count total size percentile leaderboard board boardId key displayName shortName".split(" ");
function digest(r) {
  if (!r?.errors) return JSON.stringify(r).slice(0, 2500);
  const bad = {};
  const notes = [];
  for (const e of r.errors) {
    const m = /Cannot query field "(\w+)" on type "(\w+)"\.(.*)/.exec(e.message);
    if (m) { (bad[m[2]] ??= new Set()).add(m[1]); if (m[3].trim()) notes.push(`${m[2]}.${m[1]}:${m[3].trim()}`); }
    else notes.push(e.message);
  }
  const valid = Object.entries(bad).map(([t, s]) => `${t} VALID[${CAND.filter((c) => !s.has(c)).join(",")}]`);
  return `${valid.join(" ; ")} NOTES[${notes.join(" / ")}]`.slice(0, 3500);
}
async function run(input) {
  try {
    const cookie = await login(setting(input, "email"), setting(input, "password"));
    const u = await gql(cookie, `{ currentUser { userHouseholds { household { pets { id name } } } } }`);
    const id = u?.data?.currentUser?.userHouseholds?.[0]?.household?.pets?.[0]?.id;
    const [a, b] = await Promise.all([
      gql(cookie, `{ leaderboardsHome(petId: "${id}") { window week { start end } boards { ${CAND.join(" ")} } } }`),
      gql(cookie, `{ leaderboardsHome(petId: "${id}") { window boards { __typename } } }`),
    ]);
    return { probe: [`BOARDS ${digest(a)}`, `TYPE ${digest(b)}`].join("\n").slice(0, 9500) };
  } catch (e) {
    return { probe: `ERR ${e?.message ?? e}` };
  }
}
