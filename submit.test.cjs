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

const script = readFileSync(require.resolve("./submit.js"), "utf8");
const requestOptions = { mode: "same-origin", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" };
const draftInput = "draft-file", checkbox = "confirm-draft", submit = "send-draft";
const receiptInput = "receipt-file", lookup = "lookup-status";
const receiptFile = new File([JSON.stringify(receipt)], "private.json");
const otherReceipt = { ...receipt, receipt_id: "submission-" + "a".repeat(64), status_token: "b".repeat(64) };
const otherReceiptFile = new File([JSON.stringify(otherReceipt)], "other-private.json");
const otherSource = source.replace(draft.title, "另一份草稿");
const otherDigest = createHash("sha256").update(otherSource).digest("hex");
const otherDraftFile = new File([otherSource], "draft-" + otherDigest + ".json");

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}

function page(fetch = () => assert.fail("unexpected network request"), { pageOrigin = origin, crypto = webcrypto } = {}) {
  const elements = {}, focusListeners = new Set(), requests = [], downloads = [], revoked = [], persistence = [];
  const body = { id: "body" };
  let active = body;
  const focus = target => {
    active = target;
    for (const notify of focusListeners) notify({ target });
  };
  const byId = id => {
    if (elements[id]) return elements[id];
    let disabled = [draftInput, submit, receiptInput, lookup].includes(id);
    let value = "";
    return elements[id] = {
      id, events: {}, files: [], textContent: "", hidden: ["draft-preview", "receipt"].includes(id), checked: false,
      get disabled() { return disabled; },
      set disabled(flag) {
        disabled = flag;
        // Browsers can blur a newly disabled active control without focusing another element.
        if (flag && active === this) active = body;
      },
      get value() { return value; },
      set value(newValue) { value = newValue; if (newValue === "") this.files = []; },
      addEventListener(event, listener) { this.events[event] = listener; },
      // Deliberately bypasses native disabled handling to exercise the handlers' guards.
      fire(event) { return this.events[event]?.(); },
      focus() { assert.equal(this.disabled || this.hidden, false, "cannot focus " + id); focus(this); },
      set innerHTML(_) { assert.fail("untrusted HTML rendering"); },
    };
  };
  const document = {
    body, get activeElement() { return active; },
    getElementById: byId,
    addEventListener(event, listener) { assert.equal(event, "focusin"); focusListeners.add(listener); },
    removeEventListener(event, listener) { assert.equal(event, "focusin"); focusListeners.delete(listener); },
    createElement(tag) {
      assert.equal(tag, "a");
      return { click() { downloads.push(this.download); } };
    },
    set cookie(value) { persistence.push(value); },
  };
  vm.runInNewContext(script, {
    document, location: { origin: pageOrigin }, crypto, Blob, TextDecoder,
    fetch(url, options) { requests.push({ url, options }); return fetch(url, options); },
    URL: { createObjectURL(blob) { downloads.push(blob); return "blob:mock"; }, revokeObjectURL(url) { revoked.push(url); } },
    setTimeout(callback) { callback(); },
    get localStorage() { persistence.push("localStorage"); },
    get sessionStorage() { persistence.push("sessionStorage"); },
    get indexedDB() { persistence.push("indexedDB"); },
  });
  return {
    byId, elements, requests, downloads, revoked, persistence, focusListeners,
    get active() { return active.id; },
    blur() { focus(body); },
    choose(id, file) {
      const input = byId(id);
      // Re-choosing an unchanged native selection emits cancel, not change.
      if (file && input.files[0] === file) return input.fire("cancel");
      input.value = file ? "C:\\fakepath\\" + file.name : "";
      input.files = file ? [file] : [];
      return input.fire("change");
    },
    check(checked = true) {
      const confirm = byId(checkbox);
      confirm.checked = checked;
      confirm.fire("change");
    },
    click(id) {
      const control = byId(id);
      control.focus();
      return control.fire("click");
    },
  };
}

function assertPost({ url, options }, text = source, hash = digest) {
  assert.equal(url, path);
  const { method, body, headers, ...rest } = options;
  assert.equal(method, "POST");
  assert.deepEqual(rest, requestOptions);
  assert.deepEqual({ ...headers }, { "Content-Type": "application/json", "X-Draft-SHA256": hash });
  assert.deepEqual(Buffer.from(body), Buffer.from(text));
}

function assertLookup({ url, options }, value = receipt) {
  assert.equal(url, path + "/" + value.receipt_id);
  const { method, headers, ...rest } = options;
  assert.equal(method, "GET");
  assert.deepEqual(rest, requestOptions);
  assert.deepEqual({ ...headers }, { Authorization: "Bearer " + value.status_token });
}

const submitted = (value = receipt, status = 201) => ({ status, json: async () => value });
const reviewed = (review_state, value = receipt) => ({ ok: true, status: 200, json: async () => ({ ...value, review_state }) });
const displayed = p => Object.values(p.elements).map(element => element.textContent).join("\n");

test("preview and consent stay local; explicit submit sends exact bytes and download keeps the receipt token private", async () => {
  const p = page(() => submitted({ ...receipt, extra: "not for display" }));
  p.byId(draftInput).focus();
  await p.choose(draftInput, draftFile);
  assert.equal(p.active, draftInput);
  assert.equal(p.byId("draft-title").textContent, draft.title);
  assert.equal(p.byId("draft-content").textContent, source);
  assert.equal(p.byId("draft-digest").textContent, digest);
  await p.byId(submit).fire("click");
  p.check();
  assert.equal(p.requests.length, 0);
  await p.click(submit);
  assert.equal(p.requests.length, 1);
  assertPost(p.requests[0]);
  assert.equal(p.byId("receipt").hidden, false);
  assert.match(p.byId("receipt-label").textContent, new RegExp(receipt.receipt_id));
  assert.equal(p.active, "receipt-label");
  assert.equal(p.byId("draft-preview").hidden, true);
  assert.equal(p.byId("draft-content").textContent, "");
  assert.equal(p.byId(draftInput).files.length, 0);
  assert.equal(p.byId(checkbox).checked, false);
  assert.equal(p.byId(submit).disabled, true);
  assert.doesNotMatch(displayed(p), new RegExp(token + "|not for display"));
  assert.deepEqual(p.persistence, []);
  assert.equal(p.downloads.length, 0);
  p.byId("download-receipt").fire("click");
  assert.equal(p.downloads[0].type, "application/json");
  assert.deepEqual(JSON.parse(await p.downloads[0].text()), receipt);
  assert.equal(p.downloads[1], "numericbridge-" + receipt.receipt_id + "-private.json");
  assert.deepEqual(p.revoked, ["blob:mock"]);
  const freshPage = page();
  freshPage.byId("download-receipt").fire("click");
  assert.equal(freshPage.byId("receipt").hidden, true);
  assert.deepEqual(freshPage.downloads, []);
});

test("a late SHA-256 result cannot overwrite the newer preview, consent or bytes", { timeout: 5000 }, async () => {
  const hashing = deferred(), slowHash = deferred();
  const crypto = { subtle: { digest(algorithm, bytes) {
    if (Buffer.from(bytes).toString() === source) {
      hashing.resolve();
      return slowHash.promise;
    }
    return webcrypto.subtle.digest(algorithm, bytes);
  } } };
  const p = page(() => submitted({ ...receipt, receipt_id: "submission-" + otherDigest }), { crypto });
  const original = p.choose(draftInput, draftFile);
  await hashing.promise;
  await p.choose(draftInput, otherDraftFile);
  p.check();
  slowHash.resolve(Buffer.from(digest, "hex"));
  await original;
  assert.equal(p.byId("draft-title").textContent, "另一份草稿");
  assert.equal(p.byId("draft-content").textContent, otherSource);
  assert.equal(p.byId("draft-digest").textContent, otherDigest);
  assert.equal(p.byId(checkbox).checked, true);
  assert.equal(p.requests.length, 0);
  await p.click(submit);
  assert.equal(p.requests.length, 1);
  assertPost(p.requests[0], otherSource, otherDigest);
});

test("draft replacement or clearing invalidates reads; picker cancellation does not", async () => {
  const p = page();
  const oldRead = deferred();
  const stale = p.choose(draftInput, { ...oldRead, name: "old.json", size: 10, arrayBuffer: () => oldRead.promise });
  await p.choose(draftInput, draftFile);
  p.check();
  const currentMessage = p.byId("submit-message").textContent;
  oldRead.reject(new Error("stale, private path"));
  await stale;
  assert.equal(p.byId(draftInput).files[0], draftFile);
  assert.equal(p.byId("submit-message").textContent, currentMessage);
  await p.choose(draftInput, draftFile);
  assert.equal(p.byId(checkbox).checked, true);

  const nextRead = deferred();
  const next = p.choose(draftInput, { name: "next.json", size: draftFile.size, arrayBuffer: () => nextRead.promise });
  assert.equal(p.byId(checkbox).checked, false);
  assert.equal(p.byId(checkbox).disabled, true);
  assert.equal(p.byId("draft-preview").hidden, true);
  assert.equal(p.byId("draft-content").textContent, "");
  await p.choose(draftInput, null);
  nextRead.resolve(await draftFile.arrayBuffer());
  await next;
  assert.equal(p.byId("draft-preview").hidden, true);
  assert.equal(p.byId("submit-message").textContent, "");
  assert.equal(p.byId(submit).disabled, true);
  assert.equal(p.requests.length, 0);
});

test("a local draft error clears the picker for same-file retry; only post-preview consent counts", async () => {
  const p = page();
  let attempts = 0;
  const read = deferred();
  const file = { name: draftFile.name, size: draftFile.size, arrayBuffer() {
    return ++attempts === 1 ? Promise.reject(new Error("private path " + token)) : read.promise;
  } };
  p.byId(draftInput).focus();
  await p.choose(draftInput, file);
  assert.equal(p.byId("submit-message").textContent, "无法在本地读取草稿。");
  assert.equal(p.byId(draftInput).value, "");
  assert.equal(p.byId("draft-preview").hidden, true);
  assert.equal(p.active, draftInput);
  assert.doesNotMatch(displayed(p), /private path/);
  const retry = p.choose(draftInput, file);
  p.check();
  assert.equal(p.byId(checkbox).checked, false);
  p.byId(checkbox).checked = true; // Unannounced browser/programmatic state cannot carry forward either.
  await p.byId(submit).fire("click");
  read.resolve(await draftFile.arrayBuffer());
  await retry;
  assert.equal(attempts, 2);
  assert.equal(p.byId(checkbox).checked, false);
  assert.equal(p.byId(checkbox).disabled, false);
  assert.equal(p.byId(submit).disabled, true);
  p.byId(checkbox).checked = true;
  await p.byId(submit).fire("click");
  assert.equal(p.requests.length, 0);
  p.check();
  assert.equal(p.byId(submit).disabled, false);
  p.check(false);
  assert.equal(p.byId(submit).disabled, true);
});

test("rapid repeat submits send once; HTTP, bad receipt and transport failures require fresh consent to retry exact bytes", async () => {
  const rateLimit = deferred();
  const attempts = [
    () => rateLimit.promise,
    () => ({ status: 503 }),
    () => submitted({ ...receipt, receipt_id: otherReceipt.receipt_id }),
    () => Promise.reject(new Error("private network error " + token)),
    () => submitted({ ...receipt, reused: true }, 200),
  ];
  const p = page(() => attempts.shift()());
  await p.choose(draftInput, draftFile);
  p.check();
  const first = p.click(submit);
  assert.equal(p.active, "body");
  assert.equal(p.byId(draftInput).disabled, true);
  assert.equal(p.byId(checkbox).disabled, true);
  assert.equal(p.byId(checkbox).checked, false);
  assert.equal(p.byId(submit).disabled, true);
  p.check();
  await p.byId(submit).fire("click");
  assert.equal(p.requests.length, 1);
  rateLimit.resolve({ status: 429 });
  await first;
  for (const [i, text] of [/暂时繁忙/, /HTTP 503/, /未收到有效回执/, /未收到有效回执/].entries()) {
    assert.match(p.byId("submit-message").textContent, text);
    assert.doesNotMatch(displayed(p), /private network error/);
    assert.equal(p.byId("receipt").hidden, true);
    assert.equal(p.active, checkbox);
    assert.equal(p.byId("draft-content").textContent, source);
    assert.equal(p.byId(draftInput).files[0], draftFile);
    assert.equal(p.byId(draftInput).disabled, false);
    assert.equal(p.byId(checkbox).disabled, false);
    assert.equal(p.byId(checkbox).checked, false);
    await p.byId(submit).fire("click");
    assert.equal(p.requests.length, i + 1);
    p.check();
    await p.click(submit);
  }
  assert.equal(p.requests.length, 5);
  p.requests.forEach(request => assertPost(request));
  assert.match(p.byId("receipt-label").textContent, /已找回已有回执/);
  assert.equal(p.active, "receipt-label");
});

test("completion shows the sent receipt without clearing a newer draft or stealing moved focus", async () => {
  const response = deferred();
  const p = page(() => response.promise);
  await p.choose(draftInput, draftFile);
  p.check();
  const sent = p.click(submit);
  p.byId(receiptInput).focus();
  // Model a late selection event already queued by the picker when the submit was started.
  await p.choose(draftInput, otherDraftFile);
  assert.equal(p.byId(checkbox).disabled, true);
  response.resolve(submitted());
  await sent;
  assert.equal(p.active, receiptInput);
  assert.equal(p.byId("draft-content").textContent, otherSource);
  assert.equal(p.byId(draftInput).files[0], otherDraftFile);
  assert.equal(p.byId(checkbox).disabled, false);
  assert.equal(p.byId(checkbox).checked, false);
  assert.equal(p.byId(submit).disabled, true);
  assert.match(p.byId("receipt-label").textContent, new RegExp(receipt.receipt_id));
  assert.equal(p.requests.length, 1);
  assertPost(p.requests[0]);
});

test("async submit does not steal focus after the user navigated away from the action", async () => {
  const response = deferred();
  const p = page(() => response.promise);
  await p.choose(draftInput, draftFile);
  p.check();
  const sent = p.click(submit);
  p.byId(receiptInput).focus();
  p.blur();
  response.resolve(submitted());
  await sent;
  assert.equal(p.active, "body");
  assert.equal(p.byId("receipt").hidden, false);
  assert.equal(p.focusListeners.size, 0);
});

test("all noncanonical origins allow only local draft preview; POST and receipt GET stay blocked", async () => {
  for (const pageOrigin of ["http://127.0.0.1:41731", "http://numericbridge.com", "https://www.numericbridge.com",
    "https://numericbridge.com:444", "https://numericbridge.com.example", "null"]) {
    const p = page(undefined, { pageOrigin });
    await p.choose(draftInput, draftFile);
    assert.equal(p.byId("draft-preview").hidden, false, pageOrigin);
    p.check();
    await p.click(submit);
    assert.match(p.byId("submit-message").textContent, /只能在 https:\/\/numericbridge\.com 上发送草稿/);
    assert.equal(p.byId(checkbox).checked, false);
    assert.equal(p.byId(submit).disabled, true);
    await p.choose(receiptInput, { name: "private.json", size: 10, text: () => assert.fail("read receipt at off-origin lookup") });
    await p.click(lookup);
    assert.match(p.byId("lookup-result").textContent, /只能在 https:\/\/numericbridge\.com 上查询状态/);
    assert.equal(p.requests.length, 0, pageOrigin);
  }
});

test("status sends only a receipt-scoped bearer header and exposes only known review labels", async () => {
  const sent = [];
  const label = await lookupStatus(receiptFile, async (url, options) => {
    sent.push({ url, options });
    return reviewed("accepted");
  });
  assert.equal(label, "审核状态：已接受");
  assert.equal(sent.length, 1);
  assertLookup(sent[0]);
  assert.match(await lookupStatus(receiptFile, async () => ({ status: 404 })), /未找到该回执/);
  await assert.rejects(lookupStatus(receiptFile, async () => reviewed("unknown")), /Invalid review state/);
  await assert.rejects(lookupStatus(receiptFile, async () => reviewed("accepted", otherReceipt)), /Invalid review state/);
  const invalid = new File([JSON.stringify({ ...receipt, receipt_id: "../../bad" })], "private.json");
  assert.match(await lookupStatus(invalid, () => assert.fail("invalid receipt triggered a request")), /有效私密回执/);
});

test("invalid local receipts reset for a same-file reselect; network failure preserves valid receipts for explicit retry", async () => {
  let reads = 0;
  const file = { name: receiptFile.name, size: receiptFile.size, text() {
    return ++reads === 1 ? Promise.reject(new Error("private receipt read " + token)) : receiptFile.text();
  } };
  let lookups = 0;
  const p = page(() => ++lookups === 1 ? Promise.reject(new Error("private network error " + token)) : reviewed("accepted"));
  await p.choose(receiptInput, file);
  assert.equal(reads, 0);
  assert.equal(p.requests.length, 0);
  await p.click(lookup);
  assert.match(p.byId("lookup-result").textContent, /有效私密回执/);
  assert.equal(p.byId(receiptInput).value, "");
  assert.equal(p.byId(lookup).disabled, true);
  assert.equal(p.active, receiptInput);
  assert.equal(p.requests.length, 0);
  await p.choose(receiptInput, file);
  assert.equal(p.byId("lookup-result").textContent, "");
  await p.click(lookup);
  assert.match(p.byId("lookup-result").textContent, /稍后再试/);
  assert.equal(p.active, lookup);
  assert.equal(p.byId(receiptInput).files[0], file);
  assert.equal(p.byId(lookup).disabled, false);
  await p.click(lookup);
  assert.equal(p.byId("lookup-result").textContent, "审核状态：已接受");
  assert.equal(p.active, lookup);
  assert.doesNotMatch(displayed(p), new RegExp(token + "|private receipt read|private network error"));
  assert.deepEqual(p.persistence, []);
  assert.equal(p.requests.length, 2);
  p.requests.forEach(request => assertLookup(request));
});

test("replacing a pending local receipt read suppresses the old request and rapid duplicate lookup", async () => {
  const oldRead = deferred(), newRead = deferred();
  const p = page(() => reviewed("needs_information", otherReceipt));
  await p.choose(receiptInput, { name: receiptFile.name, size: receiptFile.size, text: () => oldRead.promise });
  const oldQuery = p.click(lookup);
  assert.equal(p.byId(receiptInput).disabled, false);
  assert.equal(p.byId(lookup).disabled, true);
  await p.byId(lookup).fire("click");
  await p.choose(receiptInput, { name: otherReceiptFile.name, size: otherReceiptFile.size, text: () => newRead.promise });
  const newQuery = p.click(lookup);
  await p.byId(lookup).fire("click");
  oldRead.resolve(JSON.stringify(receipt));
  await oldQuery;
  assert.equal(p.requests.length, 0);
  assert.equal(p.byId(lookup).disabled, true);
  assert.equal(p.byId("lookup-result").textContent, "正在查询状态…");
  newRead.resolve(JSON.stringify(otherReceipt));
  await newQuery;
  assert.equal(p.requests.length, 1);
  assertLookup(p.requests[0], otherReceipt);
  assert.equal(p.byId("lookup-result").textContent, "审核状态：需要补充信息");
  assert.equal(p.focusListeners.size, 0);
});

test("stale network lookup errors and successes cannot replace the current result, focus or control state", { timeout: 5000 }, async () => {
  const oldResponse = deferred(), oldStarted = deferred();
  const newResponse = deferred(), newStarted = deferred();
  const p = page(url => {
    if (url.endsWith(receipt.receipt_id)) { oldStarted.resolve(); return oldResponse.promise; }
    newStarted.resolve();
    return newResponse.promise;
  });
  await p.choose(receiptInput, receiptFile);
  const oldQuery = p.click(lookup);
  await oldStarted.promise;
  await p.choose(receiptInput, otherReceiptFile);
  const newQuery = p.click(lookup);
  await newStarted.promise;
  p.byId(draftInput).focus();
  oldResponse.reject(new Error("old private error"));
  await oldQuery;
  assert.equal(p.byId("lookup-result").textContent, "正在查询状态…");
  assert.equal(p.byId(lookup).disabled, true);
  assert.equal(p.active, draftInput);
  await p.choose(receiptInput, null);
  newResponse.resolve(reviewed("published", otherReceipt));
  await newQuery;
  assert.equal(p.byId("lookup-result").textContent, "");
  assert.equal(p.byId(lookup).disabled, true);
  assert.equal(p.active, draftInput);
  assert.equal(p.requests.length, 2);
  assertLookup(p.requests[0]);
  assertLookup(p.requests[1], otherReceipt);
  assert.equal(p.focusListeners.size, 0);
});
