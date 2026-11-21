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
const msg = (r) => (r?.errors ? r.errors.map((e) => e.message).join(" / ") : JSON.stringify(r)).slice(0, 900);
async function run(input) {
  try {
    const cookie = await login(setting(input, "email"), setting(input, "password"));
    const u = await gql(cookie, `{ currentUser { userHouseholds { household { pets { id name } } } } }`);
    const id = u?.data?.currentUser?.userHouseholds?.[0]?.household?.pets?.[0]?.id;
    if (!id) return { probe: JSON.stringify(u).slice(0, 800) };
    const p = (b) => `{ pet(id: "${id}") { ${b} } }`;
    const guesses = ["strain", "strainFeed", "strainScore", "currentStrain", "rank", "ranking", "rankings", "leaderboard", "leaderboards", "stateRank", "leaderboardRank", "currentRank", "activityRank", "stepRank"];
    const jobs = [
      ...guesses.map((g) => [`pet.${g}`, p(g)]),
      ["stepFeed.zzz", p(`stepFeed(period: DAY) { zzz }`)],
      ["stepFeed.args", p(`stepFeed(period: DAY, zzz: 1) { __typename }`)],
      ["summary.zzz", p(`currentActivitySummary(period: DAILY) { zzz strain strainScore rank ranking }`)],
      ["root", `{ leaderboard rank rankings strain }`],
    ];
    const out = await Promise.all(jobs.map(async ([k, q]) => `${k} => ${msg(await gql(cookie, q))}`));
    return { probe: out.join("\n").slice(0, 9000) };
  } catch (e) {
    return { probe: `ERR ${e?.message ?? e}` };
  }
}
