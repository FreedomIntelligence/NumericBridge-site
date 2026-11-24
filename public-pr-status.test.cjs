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

function upstreamView(contributions) {
  const html = readFileSync(require("node:path").join(__dirname, "index.html"), "utf8");
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const section = html.slice(html.indexOf("const UPBY ="), html.indexOf("/* ======================================================================\n   platform —"));
  const doc = { addEventListener() {}, activeElement: null };
  function element(dataset = {}) {
    return {
      dataset, style: {}, attrs: {}, slots: {}, innerHTML: "", textContent: "",
      classList: { toggle() {} },
      setAttribute(k, v) { this.attrs[k] = v; },
      focus() { doc.activeElement = this; },
      contains(node) { return this === node || this.link === node; },
    };
  }
  const cards = [];
  const box = element();
  function insert(index, markup) {
    const card = element({ upId: /data-up-id="([^"]+)"/.exec(markup)[1] });
    card.link = element();
    card.slots["[data-up-badge]"] = { innerHTML: /<span data-up-badge>(<span.*?<\/span>)/.exec(markup)[1] };
    card.slots["[data-up-public-status]"] = { innerHTML: /<span class="up-public-status" data-up-public-status>(.*?)<\/span>/.exec(markup)?.[1] };
    card.remove = () => cards.splice(cards.indexOf(card), 1);
    card.insertAdjacentHTML = (where, content) => {
      assert.equal(where, "beforebegin");
      insert(cards.indexOf(card), content);
    };
    Object.defineProperty(card, "previousElementSibling", { get: () => cards[cards.indexOf(card) - 1] });
    cards.splice(index, 0, card);
  }
  Object.defineProperty(box, "lastElementChild", { get: () => cards.at(-1) });
  box.insertAdjacentHTML = (where, markup) => { assert.equal(where, "beforeend"); insert(cards.length, markup); };
  Object.defineProperty(box, "innerHTML", {
    get: () => box.slots[".empty"]?.innerHTML,
    set: markup => { box.slots[".empty"] = { innerHTML: markup, remove: () => delete box.slots[".empty"] }; },
  });
  const ids = ("dwCrumb dwBody dwFoot dwCopy dwClose dwPrev dwNext upDrawerBadge upDrawerTimeline upDrawerPublicStatus upDrawerPosition uMergedStat uReviewStat uClr").split(" ");
  const els = { ...Object.fromEntries(ids.map(id => [id, element()])), uCards: box };
  const pills = ["", "merged", "review", "closed"].map(us => {
    const pill = element({ us });
    pill.slots[".n"] = element();
    return pill;
  });
  const queries = [];
  const DW = { kind: "upstream", order: [contributions[0].id], idx: 0 };
  const context = vm.createContext({
    UPSTREAM: { contributions }, LANG: "en", tx: (zh, en) => en, fmtInt: String, esc: s => String(s ?? ""),
    ico: () => "", mascot: () => "", byId: id => els[id], $: (selector, node) => node.slots[selector],
    $$: selector => selector.startsWith("#uStatus") ? pills : selector.startsWith("#uCards") ? [...cards] : [],
    document: doc, DW, RENDER: {}, dwReturnFocus: null, writeQuery: (...args) => queries.push(args),
    window: { NumericBridgePublicPRStatus: publicPRStatus, addEventListener() {}, setInterval() {} },
  });
  const run = code => vm.runInContext(code, context);
  run(section);
  return { run, cards, els, pills, doc, DW, queries };
}

const transformersUrl = "https://github.com/huggingface/transformers/pull/51042";
const submitted = { id: "transformers", url: transformersUrl, number: "#51042", status: "submitted", state: "review", project: "Transformers", forge: "github", title: "Fix", submitted_at: "2026-11-20", observed_at: "2026-11-21" };
const whenUpdated = "2026-11-24T12:00:00Z";
const setImmediateAsync = () => new Promise(setImmediate);

test("merged GitHub snapshot updates a submitted card, open drawer, and filters without synthesizing a lifecycle event", async t => {
  const other = { ...submitted, id: "other", url: nonGitHub, forge: "gitlab" };
  const { run, cards, els, pills, doc, DW, queries } = upstreamView([submitted, other]);
  let deliver;
  const fetch = t.mock.method(globalThis, "fetch", () => new Promise(resolve => { deliver = resolve; }));
  run('upBuilt = true; US.status = "review"; US.sel = "transformers"; paintUpstream(); paintUpstreamDrawer(UPBY.get(US.sel));');
  const [original, survivor] = cards;
  assert.match(original.slots["[data-up-badge]"].innerHTML, /Open/);
  assert.match(els.dwBody.innerHTML, /upDrawerBadge.*Open/);
  assert.match(els.dwBody.innerHTML, /Published lifecycle: Submitted · 2026-11-20/);
  assert.ok(els.dwFoot.innerHTML.includes('href="' + transformersUrl + '"'));
  assert.equal(pills[1].slots[".n"].textContent, "0");
  assert.equal(pills[2].slots[".n"].textContent, "2");
  const body = els.dwBody.innerHTML, foot = els.dwFoot.innerHTML;
  els.dwCopy.focus();
  els.dwBody.scrollTop = 120;
  run('dwReturnFocus = $$("#uCards [data-up-id]")[0].link; loadUpPublicStatus(); loadUpPublicStatus();');
  assert.equal(fetch.mock.callCount(), 1);
  deliver({ ok: true, json: async () => artifact({ [transformersUrl]: { ...row, state: "merged", updated_at: whenUpdated, url: injected }, [injected]: row }) });
  await setImmediateAsync();
  assert.deepEqual(cards, [survivor], "the review filter removes only the now-merged card");
  assert.equal(run("dwReturnFocus"), pills[2], "closing the drawer can return focus to the active filter");
  assert.equal(pills[2].attrs["aria-pressed"], "true");
  assert.equal(pills[2].slots[".n"].textContent, "1");
  assert.equal(pills[1].slots[".n"].textContent, "1");
  assert.equal(els.uMergedStat.textContent, "1");
  assert.equal(els.uReviewStat.textContent, "1");
  assert.equal(doc.activeElement, els.dwCopy);
  assert.equal(els.dwBody.scrollTop, 120);
  assert.equal(els.dwBody.innerHTML, body);
  assert.equal(els.dwFoot.innerHTML, foot);
  assert.equal(DW.order[DW.idx], submitted.id);
  assert.equal(DW.kind, "upstream");
  assert.equal(queries.length, 1, "hydration must not rewrite the route");
  assert.match(els.upDrawerBadge.innerHTML, /Merged/);
  assert.match(els.upDrawerTimeline.innerHTML, /aria-current="step"><span[^>]+><\/span>Merged<span class="up-st-d">—/);
  assert.match(els.upDrawerTimeline.innerHTML, /Released<span class="up-st-d">Pending/);
  assert.doesNotMatch(els.upDrawerTimeline.innerHTML, /11-24/);
  assert.match(els.upDrawerPublicStatus.innerHTML, /GitHub snapshot · Merged · Checks failing · Fresh · Fetched <time/);
  assert.match(els.upDrawerPublicStatus.innerHTML, /PR updated .*Snapshot refreshed/);
  run('US.status = "merged"; paintUpstream();');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].dataset.upId, submitted.id);
  assert.match(cards[0].slots["[data-up-badge]"].innerHTML, /Merged/);
  const card = run('upCardHtml(UPBY.get("transformers"))');
  assert.ok(card.includes('href="' + transformersUrl + '"'));
  assert.ok(!card.includes(injected));
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.merged_at, undefined);
});

test("draft and closed affect status buckets while release facts and non-GitHub records stay published", async t => {
  const released = { ...submitted, id: "released", url, status: "released", state: "merged", merged_at: "2026-11-22", released_at: "2026-11-23", release_tag: "v1.0" };
  const staticClosed = { ...submitted, id: "static", url: nonGitHub, forge: "gitlab", status: "closed", state: "closed", closed_at: "2026-11-23" };
  const draft = { ...submitted, id: "draft", url: missing };
  const { run, cards } = upstreamView([submitted, released, staticClosed, draft]);
  loader(t, artifact({ [transformersUrl]: { ...row, state: "closed", updated_at: whenUpdated }, [url]: { ...row, state: "merged" }, [missing]: row, [nonGitHub]: { ...row, state: "merged" } }));
  run('DW.kind = null; upBuilt = true; paintUpstream(); loadUpPublicStatus();');
  const before = [...cards];
  await setImmediateAsync();
  assert.deepEqual(cards, before, "unfiltered hydration retains DOM nodes and their links");
  assert.match(cards[0].slots["[data-up-badge]"].innerHTML, /Closed/);
  assert.equal(run('JSON.stringify(upCounts())'), '{"total":4,"merged":1,"review":1,"closed":2}');
  assert.match(run('upBadge(UPBY.get("draft"))'), /Draft/);
  assert.match(run('upTimeline(UPBY.get("transformers"))'), /aria-current="step"><span[^>]+><\/span>Closed<span class="up-st-d">—/);
  assert.doesNotMatch(run('upTimeline(UPBY.get("transformers"))'), /11-24/);
  assert.match(run('upTimeline(UPBY.get("released"))'), /Merged<span class="up-st-d">11-22.*Released<span class="up-st-d">v1.0/);
  assert.match(run('upBadge(UPBY.get("released"))'), /Released/);
  assert.match(run('upRecordedLifecycle(UPBY.get("released"))'), /Released · 2026-11-23/);
  assert.match(run('upBadge(UPBY.get("static"))'), /Closed/);
  assert.doesNotMatch(run('upCardHtml(UPBY.get("static"))'), /GitHub snapshot|data-up-public-status/);
  run('US.status = "review"; paintUpstream();');
  assert.deepEqual(cards.map(card => card.dataset.upId), ["draft"]);
  run('US.status = "closed"; paintUpstream();');
  assert.deepEqual(cards.map(card => card.dataset.upId), ["transformers", "static"]);
  run('upSnapshot.records.set(upPublicStatus.key(UPBY.get("released").url), { state: "open" });');
  assert.match(run('upBadge(UPBY.get("released"))'), /Released/, "a lagging snapshot cannot undo a confirmed merge");
  run('upSnapshot = null');
  assert.match(run('upBadge(UPBY.get("released"))'), /Released/);
  assert.match(run('upBadge(UPBY.get("transformers"))'), /Open/);
});
