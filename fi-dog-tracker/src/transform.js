const FI = "https://api.tryfi.com";
function setting(input, key) {
  const value = input?.trmnl?.plugin_settings?.custom_fields_values?.[key] ?? input?.[key];
  return typeof value === "string" ? value.trim() : value;
}
async function login(email, password, ua) {
  const res = await fetch(`${FI}/auth/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": ua }, body: new URLSearchParams({ email, password }).toString(), signal: AbortSignal.timeout(2500) });
  const json = await res.json().catch(() => undefined);
  if (!res.ok || !json?.userId) throw new Error(`login failed ${res.status}`);
  const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : (res.headers.get("set-cookie") ?? "").split(/,(?=\s*[^;,=\s]+=)/);
  return { cookie: cookies.map((c) => c.split(";")[0].trim()).filter((c) => c.includes("=")).join("; "), user: json };
}
async function getq(cookie, query, ua) {
  const url = new URL("/graphql", FI);
  url.searchParams.set("query", query);
  try {
    const res = await fetch(url, { headers: { cookie, "content-type": "application/json", "apollo-require-preflight": "true", accept: "application/json", "user-agent": ua }, signal: AbortSignal.timeout(3000) });
    const t = await res.text();
    return `${res.status} ${t.slice(0, 600)}`;
  } catch (e) { return `ERR ${e?.message ?? e}`; }
}
async function run(input) {
  try {
    const ua = "Fi/5.0 (iPhone; iOS 18.0)";
    const { cookie, user } = await login(setting(input, "email"), setting(input, "password"), ua);
    const id = (await (async () => { const r = await getq(cookie, `{ currentUser { userHouseholds { household { pets { id } } } } }`, ua); return /"id":"([^"]+)"/.exec(r)?.[1]; })());
    const out = await Promise.all([
      getq(cookie, `{ leaderboardsHome(petId: "${id}") { window boards { title slice scope { __typename } } } }`, ua),
      getq(cookie, `{ petRanking(petId: "${id}", window: WEEKLY) { rank score } }`, ua),
    ]);
    return { probe: [`USERKEYS ${Object.keys(user || {}).join(",")}`, ...out].join("\n") };
  } catch (e) {
    return { probe: `ERR ${e?.message ?? e}` };
  }
}
