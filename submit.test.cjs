"use strict";
const assert = require("node:assert/strict");
const { createHash, webcrypto } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const { isPublicDraft, readDraft, lookupStatus } = require("./submit.js");

const origin = "https://numericbridge.com";
const path = "/v1/public-submissions";
const token = "d".repeat(64);
const draft = {
  schema_version: 3,
  title: "<b>测试</b>",
  destination: origin + path,
  attribution: { mode: "anonymous" },
  base_commit: "1".repeat(40),
  additions: { evaluations: { evaluations: [{ metric: 1 }] }, repairs: {}, relations: {}, evidence: {} },
  files: { "data/evaluations.json": "2".repeat(64) },
};
// JSON.stringify would change 1.0 into 1. The submitted bytes must keep 1.0 and the final LF.
const source = JSON.stringify(draft).replace('"metric":1', '"metric":1.0') + "\n";
const digest = createHash("sha256").update(source).digest("hex");
const draftFile = new File([source], "draft-" + digest + ".json");
const receipt = { status: "received", review_state: "pending_review", receipt_id: "submission-" + digest, status_token: token, reused: false };

test("checks the generated public envelope and reads the exact bounded UTF-8 bytes", async () => {
  assert.equal(isPublicDraft(draft), true);
  for (const invalid of [{}, { ...draft, destination: origin + path + "?x=1" }, { ...draft, destination: "https://evil.test" + path },
    { ...draft, supersedes: [] }, { ...draft, attribution: { mode: "anonymous", name: "test" } },
    { ...draft, additions: { ...draft.additions, evaluations: [1] } }]) {
    assert.equal(isPublicDraft(invalid), false);
  }
  const result = await readDraft(draftFile, webcrypto.subtle);
  assert.equal(result.text, source);
  assert.equal(result.digest, digest);
  await assert.rejects(readDraft({ size: 1280 * 1024 + 1, arrayBuffer: () => assert.fail("read oversized file") }, webcrypto.subtle), /1\.25 MiB/);
  await assert.rejects(readDraft(new File([source], "draft-" + "0".repeat(64) + ".json"), webcrypto.subtle), /SHA-256/);
});

function page(fetch, pageOrigin = origin) {
  const elements = {};
  const byId = id => elements[id] ??= {
    events: {}, files: [], textContent: "", disabled: true, hidden: false, checked: false,
    addEventListener(event, listener) { this.events[event] = listener; },
    fire(event) { return this.events[event]?.(); },
    focus() {},
    set innerHTML(_) { assert.fail("untrusted HTML rendering"); },
  };
  const downloads = [];
  vm.runInNewContext(readFileSync(require.resolve("./submit.js"), "utf8"), {
    document: { getElementById: byId, createElement: () => ({ click() { downloads.push(this.download); } }) },
    location: { origin: pageOrigin }, crypto: webcrypto, fetch, Blob, TextDecoder,
    URL: { createObjectURL(blob) { downloads.push(blob); return "blob:mock"; }, revokeObjectURL() {} },
    setTimeout(callback) { callback(); },
  });
  return { byId, elements, downloads };
}

test("selection and checking consent are local; an explicit click sends exact bytes and receipt token stays private", async () => {
  let calls = 0;
  const { byId, elements, downloads } = page(async (url, options) => {
    calls++;
    assert.equal(url, path);
    assert.equal(options.method, "POST");
    assert.equal(options.mode, "same-origin");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers["X-Draft-SHA256"], digest);
    assert.deepEqual(Buffer.from(options.body), Buffer.from(source));
    return { status: 201, json: async () => ({ ...receipt, extra: "not for display" }) };
  });
  byId("draft-file").files = [draftFile];
  await byId("draft-file").fire("change");
  assert.equal(byId("draft-title").textContent, draft.title);
  assert.equal(byId("draft-content").textContent, source);
  await byId("send-draft").fire("click");
  assert.equal(calls, 0);
  byId("confirm-draft").checked = true;
  byId("confirm-draft").fire("change");
  assert.equal(calls, 0);
  await byId("send-draft").fire("click");
  assert.equal(calls, 1);
  assert.match(byId("receipt-label").textContent, new RegExp(receipt.receipt_id));
  assert.equal(Object.values(elements).some(element => element.textContent.includes(token)), false);
  assert.equal(downloads.length, 0);
  byId("download-receipt").fire("click");
  assert.deepEqual(JSON.parse(await downloads[0].text()), receipt);
  assert.equal(downloads[1].includes(token), false);
});

test("a new selection clears consent and a mirror cannot send", async () => {
  const { byId } = page(() => assert.fail("request on mirror"), "https://mirror.test");
  byId("draft-file").files = [draftFile];
  await byId("draft-file").fire("change");
  byId("confirm-draft").checked = true;
  byId("confirm-draft").fire("change");
  await byId("draft-file").fire("change");
  assert.equal(byId("confirm-draft").checked, false);
  assert.equal(byId("send-draft").disabled, true);
  byId("confirm-draft").checked = true;
  await byId("send-draft").fire("click");
  assert.match(byId("submit-message").textContent, /numericbridge\.com/);
});

test("status uses a receipt-scoped bearer header and only returns a known review label", async () => {
  const file = new File([JSON.stringify(receipt)], "private.json");
  const label = await lookupStatus(file, async (url, options) => {
    assert.equal(url, path + "/" + receipt.receipt_id);
    assert.equal(options.headers.Authorization, "Bearer " + token);
    assert.equal(options.cache, "no-store");
    assert.equal(options.body, undefined);
    return { ok: true, json: async () => ({ ...receipt, updated_at: token, review_state: "accepted" }) };
  });
  assert.equal(label, "审核状态：已接受");
  const invalid = new File([JSON.stringify({ ...receipt, receipt_id: "../../bad" })], "private.json");
  assert.match(await lookupStatus(invalid, () => assert.fail("invalid receipt triggered a request")), /有效私密回执/);
});
