(() => {
  "use strict";
  const PATH = "/v1/public-submissions";
  const PUBLIC_ORIGIN = "https://numericbridge.com";
  const DESTINATION = PUBLIC_ORIGIN + PATH;
  const MAX_DRAFT_BYTES = 1280 * 1024;
  const MAX_RECEIPT_BYTES = 4096;
  const REQUEST_OPTIONS = { mode: "same-origin", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" };
  const COLLECTIONS = { evaluations: ["evaluations"], repairs: ["repairs", "library_groups"], relations: ["entities", "links"] };
  const STATES = new Map([
    ["pending_review", "等待审核"], ["needs_information", "需要补充信息"],
    ["accepted", "已接受"], ["declined", "未接受"], ["published", "已发布"],
  ]);
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const hasKeys = (value, ...keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const isHex = (value, length) => typeof value === "string" && value.length === length && !/[^0-9a-f]/.test(value);
  const isReceiptId = value => typeof value === "string" && value.startsWith("submission-") && isHex(value.slice(11), 64);

  // This checks the generated envelope. The server validates canonical encoding and catalog semantics.
  function isPublicDraft(draft) {
    if (!hasKeys(draft, "schema_version", "title", "destination", "attribution", "base_commit", "additions", "files") ||
        draft.schema_version !== 3 || draft.destination !== DESTINATION ||
        !hasKeys(draft.attribution, "mode") || draft.attribution.mode !== "anonymous" ||
        typeof draft.title !== "string" || !/^[^\x00-\x1f\x7f]{1,120}$/u.test(draft.title) || draft.title !== draft.title.trim() ||
        !isHex(draft.base_commit, 40) || !isObject(draft.files) || !Object.values(draft.files).every(value => isHex(value, 64)) ||
        !hasKeys(draft.additions, ...Object.keys(COLLECTIONS), "evidence") || !isObject(draft.additions.evidence) ||
        !Object.values(draft.additions.evidence).every(isObject)) return false;
    let hasRecords = false;
    for (const [collection, allowed] of Object.entries(COLLECTIONS)) {
      if (!isObject(draft.additions[collection])) return false;
      for (const [field, records] of Object.entries(draft.additions[collection])) {
        if (!allowed.includes(field) || !Array.isArray(records) || !records.every(isObject)) return false;
        hasRecords ||= records.length > 0;
      }
    }
    return hasRecords;
  }

  class DraftError extends Error {}

  async function readDraft(file, subtle = globalThis.crypto.subtle) {
    if (file.size < 1 || file.size > MAX_DRAFT_BYTES) throw new DraftError("草稿文件为空或超过 1.25 MiB。");
    const bytes = await file.arrayBuffer();
    let text, draft;
    try {
      // Keep a possible BOM visible to JSON.parse rather than stripping it.
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      draft = JSON.parse(text);
    } catch {
      throw new DraftError("请选择有效的 UTF-8 草稿 JSON。");
    }
    if (!text.startsWith("{") || !text.endsWith("}\n") || !isPublicDraft(draft)) {
      throw new DraftError("请选择为本站生成的新匿名草稿原文件，不接受其他 JSON 或替换提交。");
    }
    const hash = new Uint8Array(await subtle.digest("SHA-256", bytes));
    const digest = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
    const namedDigest = /^draft-([0-9a-f]{64})\.json$/.exec(file.name);
    if (namedDigest && namedDigest[1] !== digest) throw new DraftError("草稿内容与文件名中的 SHA-256 不符，请选择未修改的原文件。");
    return { title: draft.title, text, bytes, digest };
  }

  function privateReceipt(value) {
    if (!isObject(value) || value.status !== "received" || value.review_state !== "pending_review" ||
        typeof value.reused !== "boolean" || !isReceiptId(value.receipt_id) || !isHex(value.status_token, 64)) {
      throw new Error("Invalid receipt");
    }
    const { status, receipt_id, review_state, reused, status_token } = value;
    return { status, receipt_id, review_state, reused, status_token };
  }

  async function submitDraft(draft, send = fetch) {
    const response = await send(PATH, {
      ...REQUEST_OPTIONS, method: "POST", body: draft.bytes,
      headers: { "Content-Type": "application/json", "X-Draft-SHA256": draft.digest },
    });
    if (response.status === 200 || response.status === 201) {
      const receipt = privateReceipt(await response.json());
      if (receipt.receipt_id !== "submission-" + draft.digest) throw new Error("Receipt mismatch");
      return { receipt };
    }
    return { httpStatus: response.status };
  }

  async function lookupStatus(file, send = fetch) {
    let receipt;
    try {
      if (file.size < 1 || file.size > MAX_RECEIPT_BYTES) throw new Error("Invalid receipt size");
      receipt = privateReceipt(JSON.parse(await file.text()));
    } catch {
      return "请选择下载的有效私密回执 JSON。";
    }
    const response = await send(PATH + "/" + receipt.receipt_id, {
      ...REQUEST_OPTIONS, method: "GET", headers: { Authorization: "Bearer " + receipt.status_token },
    });
    if (response.status === 404) return "未找到该回执的状态。请确认选中了正确的私密回执。";
    if (!response.ok) throw new Error("Status lookup failed");
    const value = await response.json();
    if (!isObject(value) || value.receipt_id !== receipt.receipt_id || !STATES.has(value.review_state)) throw new Error("Invalid review state");
    return "审核状态：" + STATES.get(value.review_state);
  }

  function setup() {
    const byId = id => document.getElementById(id);
    const fileInput = byId("draft-file"), confirm = byId("confirm-draft"), send = byId("send-draft");
    const preview = byId("draft-preview"), title = byId("draft-title"), content = byId("draft-content"), digest = byId("draft-digest");
    const message = byId("submit-message"), receiptPanel = byId("receipt"), receiptLabel = byId("receipt-label");
    const receiptFile = byId("receipt-file"), lookup = byId("lookup-status"), lookupResult = byId("lookup-result");
    let draft = null, receipt = null, version = 0, sending = false, checking = false;
    if (!globalThis.crypto?.subtle) {
      message.textContent = "请通过 HTTPS 打开本站并使用支持 SHA-256 的浏览器。";
      return;
    }
    fileInput.disabled = receiptFile.disabled = confirm.checked = false;
    fileInput.value = receiptFile.value = "";
    const syncSend = () => { send.disabled = sending || !draft || !confirm.checked; };
    const clearDraft = () => {
      draft = null;
      confirm.checked = false;
      preview.hidden = true;
      title.textContent = content.textContent = digest.textContent = "";
      syncSend();
    };

    fileInput.addEventListener("change", async () => {
      const selection = ++version;
      clearDraft();
      message.textContent = "";
      const file = fileInput.files[0];
      if (!file) return;
      message.textContent = "正在本地读取草稿…";
      try {
        const result = await readDraft(file);
        if (selection !== version) return;
        draft = result;
        title.textContent = result.title;
        content.textContent = result.text;
        digest.textContent = result.digest;
        preview.hidden = false;
        message.textContent = "草稿已在本地打开，尚未发送。";
      } catch (error) {
        if (selection === version) {
          // Never show browser exceptions that might include filename or draft data.
          message.textContent = error instanceof DraftError ? error.message : "无法在本地读取草稿。";
        }
      }
    });
    confirm.addEventListener("change", syncSend);
    send.addEventListener("click", async () => {
      if (sending || !draft || !confirm.checked) return;
      if (location.origin !== PUBLIC_ORIGIN) {
        message.textContent = "只能在 https://numericbridge.com 上发送草稿。";
        return;
      }
      sending = fileInput.disabled = confirm.disabled = true;
      confirm.checked = false;
      syncSend();
      message.textContent = "正在发送草稿…";
      try {
        const result = await submitDraft(draft);
        if (!result.receipt) {
          message.textContent = result.httpStatus === 429 ? "审核收件箱暂时繁忙，请稍后重新确认并发送同一草稿。"
            : "未收到回执（HTTP " + result.httpStatus + "）。请保留原始草稿。";
          return;
        }
        receipt = result.receipt;
        receiptLabel.textContent = (receipt.reused ? "已找回已有回执：" : "草稿已收到，等待审核：") + receipt.receipt_id;
        receiptPanel.hidden = false;
        message.textContent = "";
        clearDraft();
        fileInput.value = "";
        receiptLabel.focus();
      } catch {
        message.textContent = "未收到有效回执。请保留原始草稿，稍后可重新确认并发送同一文件。";
      } finally {
        sending = fileInput.disabled = confirm.disabled = false;
        syncSend();
      }
    });

    byId("download-receipt").addEventListener("click", () => {
      if (!receipt) return;
      const blob = new Blob([JSON.stringify(receipt) + "\n"], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "numericbridge-" + receipt.receipt_id + "-private.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    receiptFile.addEventListener("change", () => {
      lookup.disabled = checking || !receiptFile.files[0];
      lookupResult.textContent = "";
    });
    lookup.addEventListener("click", async () => {
      const file = receiptFile.files[0];
      if (!file || checking) return;
      if (location.origin !== PUBLIC_ORIGIN) {
        lookupResult.textContent = "只能在 https://numericbridge.com 上查询状态。";
        return;
      }
      checking = lookup.disabled = receiptFile.disabled = true;
      lookupResult.textContent = "正在查询状态…";
      try {
        lookupResult.textContent = await lookupStatus(file);
      } catch {
        lookupResult.textContent = "暂时无法查询状态，请稍后再试。";
      } finally {
        checking = lookup.disabled = receiptFile.disabled = false;
      }
    });
  }

  if (typeof module === "object" && module.exports) module.exports = { isPublicDraft, readDraft, submitDraft, lookupStatus };
  else setup();
})();
