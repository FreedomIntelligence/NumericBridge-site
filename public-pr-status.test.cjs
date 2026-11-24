"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const { publicPRStatus } = require("./board-data.js");

const url = "https://github.com/Published/Repo/pull/17";
const missing = "https://github.com/published/repo/pull/18";
const injected = "https://github.com/not-published/repo/pull/91";
const nonGitHub = "https://gitlab.com/published/repo/-/merge_requests/17";
const now = new Date().toISOString();
const row = { state: "draft", checks: "failing", updated_at: now, fetched_at: now };
const artifact = (pull_requests, refreshed_at = now) => ({ schema_version: 1, refreshed_at, pull_requests });

function loader(t, body, options = {}) {
  return t.mock.method(globalThis, "fetch", async () => {
    if (options.offline) throw new TypeError("Network request failed");
    return { ok: !options.httpError, json: async () => {
      if (options.badJSON) throw new SyntaxError("Not JSON");
      return body;
    } };
  });
}

test("requests one anonymous same-origin GET and matches only canonical published PRs", async t => {
  const fetch = loader(t, artifact({
    [url.toLowerCase()]: { ...row, url: injected },
    [missing]: { ...row, checks: "constructor" },
    [injected]: row,
    [nonGitHub]: row,
    [url + "?tab=files"]: { ...row, state: "merged" },
  }));
  const snapshot = await publicPRStatus.load([url, missing, nonGitHub].map(url => ({ url })));
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(fetch.mock.calls[0].arguments, ["/data/public-pr-status.json", {
    method: "GET", mode: "same-origin", credentials: "omit", redirect: "error", cache: "no-cache",
  }]);
  assert.deepEqual([...snapshot.records], [[publicPRStatus.key(url), {
    state: "draft", checks: "failing", updatedAt: Date.parse(now), fetchedAt: Date.parse(now),
  }]]);
  assert.equal(await publicPRStatus.load([{ url: nonGitHub }]), null);
  assert.equal(fetch.mock.callCount(), 1);
  for (const invalid of [url + "/", url + "\n", url + "#review", url.replace("github.com", "github.com.evil.test"), url.replace("https:", "http:")]) {
    assert.equal(publicPRStatus.key(invalid), null);
  }
});

test("rejects invalid envelopes and rows, and tolerates request failure", async t => {
  let reply = {};
  t.mock.method(globalThis, "fetch", async () => {
    if (reply.offline) throw new TypeError("Offline");
    return { ok: !reply.httpError, json: async () => {
      if (reply.badJSON) throw new SyntaxError("Not JSON");
      return reply.body;
    } };
  });
  const load = () => publicPRStatus.load([{ url }]);
  for (const invalid of [{ offline: true }, { httpError: 404 }, { httpError: 503 }, { badJSON: true },
    { body: { ...artifact({ [url]: row }), schema_version: "1" } }, { body: artifact([]) },
    { body: artifact({ [url]: row }, "2026-02-30T00:00:00Z") }, { body: artifact({ [url]: row }, "2026-06-30T00:00:00+01:00") }]) {
    reply = invalid;
    assert.equal(await load(), null);
  }
  for (const invalidRow of [null, { ...row, state: "released" }, { ...row, fetched_at: "2026-11-25" }, { ...row, updated_at: "2026-13-02T00:00:00Z" }]) {
    reply = { body: artifact({ [url]: invalidRow }) };
    assert.equal((await load()).records.size, 0);
  }
  reply = { body: artifact({ [url]: row, [url.toLowerCase()]: { ...row, state: "open" } }) };
  assert.equal((await load()).records.size, 0);
});

test("freshness uses both refresh and fetch times, not old PR update times", async t => {
  const recent = "2026-11-24T12:00:00Z", checkAt = Date.parse("2026-11-24T12:14:59Z");
  loader(t, artifact({ [url]: { ...row, fetched_at: "2026-11-24T13:00:00+01:00", updated_at: "2025-11-24T12:00:00Z" } }, recent.replace("Z", "+00:00")));
  const snapshot = await publicPRStatus.load([{ url }]);
  const entry = snapshot.records.get(publicPRStatus.key(url));
  assert.equal(publicPRStatus.isStale(snapshot, entry, checkAt), false);
  assert.equal(publicPRStatus.isStale(snapshot, entry, checkAt + 1000), true);
  assert.equal(publicPRStatus.isStale(snapshot, { ...entry, fetchedAt: entry.fetchedAt - 1000 }, checkAt), true);
  assert.equal(publicPRStatus.isStale({ ...snapshot, refreshedAt: snapshot.refreshedAt - 1000 }, entry, checkAt), true);
});

test("existing cards and drawer render before hydration; only established status slots change", async t => {
  const html = readFileSync(require("node:path").join(__dirname, "index.html"), "utf8");
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const section = html.slice(html.indexOf("const UPBY ="), html.indexOf("function writeUpQuery()"));
  const data = { id: "one", url, number: "#17", status: "released", state: "merged", project: "Repo", forge: "github", release_tag: "v1.0", title: "Fix", observed_at: "2026-11-24" };
  const cardTarget = {}, drawerTarget = {}, els = { dwCrumb: {}, dwBody: {}, dwFoot: {}, dwCopy: {}, upDrawerPublicStatus: drawerTarget };
  let deliver;
  const fetch = t.mock.method(globalThis, "fetch", () => new Promise(resolve => { deliver = resolve; }));
  const sandbox = vm.createContext({
    UPSTREAM: { contributions: [data] }, data, LANG: "en", tx: (zh, en) => en,
    esc: s => String(s ?? ""), ico: () => "", byId: id => els[id], $: () => cardTarget,
    $$: () => [{ dataset: { upId: data.id } }], DW: { kind: "upstream", order: [data.id], idx: 0 },
    window: { NumericBridgePublicPRStatus: publicPRStatus },
  });
  const run = code => vm.runInContext(code, sandbox);
  run(section);
  const baseline = run("upCardHtml(data)");
  run("paintUpstreamDrawer(data); loadUpPublicStatus(); loadUpPublicStatus();");
  assert.match(baseline, /Released/);
  assert.match(baseline, /Showing published status only/);
  assert.match(els.dwBody.innerHTML, /Showing published status only/);
  assert.ok(baseline.includes('href="' + url + '"'));
  assert.ok(els.dwFoot.innerHTML.includes('href="' + url + '"'));
  assert.equal(fetch.mock.callCount(), 1);
  deliver({ ok: true, json: async () => artifact({ [url]: { ...row, url: injected }, [injected]: row }) });
  await new Promise(setImmediate);
  assert.match(cardTarget.innerHTML, /GitHub snapshot · Draft · Checks failing · Fresh · Fetched <time/);
  assert.match(drawerTarget.innerHTML, /PR updated .*Snapshot refreshed/);
  const card = run("upCardHtml(data)");
  assert.match(card, /Released/);
  assert.ok(card.includes('href="' + url + '"'));
  assert.ok(!card.includes(injected));
  assert.ok(!run('upCardHtml({ ...data, url: "https://gitlab.com/owner/repo/-/merge_requests/17" })').includes("GitHub snapshot"));
});
