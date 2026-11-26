/* Shared by the public repair drawer and the admin's progressively enhanced repair table. */
(function (root) {
  "use strict";

  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
  const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  const marker = "[data-repair-metric-pair]";

  function readValue(raw) {
    if (typeof raw === "number" && !Number.isNaN(raw)) return { value: raw, title: String(raw) };
    if (typeof raw === "string") {
      const title = raw.trim();
      if (decimal.test(title)) {
        const value = Number(title);
        if (Number.isFinite(value)) return { value, title };
      }
    }
    return { value: null, title: "" };
  }

  // The public SPA's fmtNum policy, for already numeric values.
  function formatNumber(v) {
    if (v == null || Number.isNaN(v)) return "—";
    if (v === 0) return "0";
    const a = Math.abs(v);
    if (Number.isInteger(v) && a < 1e7) return v.toLocaleString("en-US");
    if (a >= 1e4 || a < 1e-4) return v.toExponential(2);
    if (a >= 100) return v.toFixed(1);
    if (a >= 1) return v.toFixed(3);
    return v.toPrecision(3);
  }

  function formatValue(raw) {
    return formatNumber(readValue(raw).value);
  }

  function renderPairs(metrics, { beforeLabel = "Before", afterLabel = "After", headline, label, labelledBy, describedBy } = {}) {
    if (!metrics.length) return "";
    const ordered = metrics.slice();
    const lead = headline || ordered.find(m => m.headline);
    let first = lead ? ordered.indexOf(lead) : -1;
    if (lead && first < 0) {
      first = ordered.findIndex(m => m.label === lead.label && m.before === lead.before && m.after === lead.after);
    }
    if (first > 0) ordered.unshift(ordered.splice(first, 1)[0]);

    const attr = (name, value) => value ? ' ' + name + '="' + escape(value) + '"' : "";
    const heading = '<div class="tw-row" role="row"><span class="tw-label" role="columnheader"></span>'
      + '<div class="tw-c b h" role="columnheader"><b>' + escape(beforeLabel) + '</b></div>'
      + '<div class="tw-c a h" role="columnheader"><b>' + escape(afterLabel) + '</b></div></div>';
    const cell = (side, cls, metric, raw) => {
      const { value, title } = readValue(raw);
      return '<div class="tw-c ' + side + ' ' + cls + '" role="cell"><small aria-hidden="true">' + escape(metric.label)
        + '</small><strong title="' + escape(title) + '">' + escape(formatNumber(value)) + '</strong>'
        + (metric.unit ? '<em>' + escape(metric.unit) + '</em>' : "") + '</div>';
    };
    const rows = ordered.map((metric, i) => {
      const cls = "m" + (i === 0 && lead ? " hd" : "") + (i === ordered.length - 1 ? " end" : "");
      return '<div class="tw-row" role="row"><span class="tw-label" role="rowheader">' + escape(metric.label) + '</span>'
        + cell("b", cls, metric, metric.before) + cell("a", cls, metric, metric.after) + '</div>';
    }).join("");
    return '<div class="twin" role="table"' + attr("aria-label", label) + attr("aria-labelledby", labelledBy)
      + attr("aria-describedby", describedBy) + '>' + heading + rows + '</div>';
  }

  function enhance(container = root.document) {
    if (!container) return 0;
    const wrappers = Array.from(container.querySelectorAll(marker));
    if (container.matches?.(marker)) wrappers.unshift(container);
    let count = 0;
    for (const wrapper of wrappers) {
      const tables = wrapper.querySelectorAll("table");
      if (tables.length !== 1) continue;
      const table = tables[0];
      if (table.closest(marker) !== wrapper) continue;
      const beforeLabel = wrapper.getAttribute("data-before-label");
      const afterLabel = wrapper.getAttribute("data-after-label");
      if (!beforeLabel?.trim() || !afterLabel?.trim()) continue;
      const metrics = [];
      let valid = true;
      for (const row of table.rows) {
        const fields = ["label", "before", "after", "unit"].map(key => row.getAttribute("data-" + key));
        if (fields.every(field => field == null) && (row.parentElement === table.tHead
          || (row.cells.length && Array.from(row.cells).every(cell => cell.tagName === "TH")))) continue;
        const [label, before, after, unit] = fields;
        // Empty values mean missing. Bad numeric text leaves the SSR table intact.
        if (!label?.trim() || before == null || after == null || unit == null
          || [before, after].some(raw => raw.trim() && readValue(raw).value == null)) {
          valid = false;
          break;
        }
        const flag = row.getAttribute("data-headline");
        metrics.push({ label, before, after, unit, headline: flag === "" || flag === "true" || flag === "1" });
      }
      if (!valid || !metrics.length) continue;
      const explicitLabel = table.getAttribute("aria-label") || table.caption?.textContent.trim();
      const fragment = table.ownerDocument.createElement("div");
      fragment.innerHTML = renderPairs(metrics, {
        beforeLabel, afterLabel,
        label: explicitLabel || wrapper.getAttribute("aria-label"),
        labelledBy: table.getAttribute("aria-labelledby") || (!explicitLabel && wrapper.getAttribute("aria-labelledby")),
        describedBy: table.getAttribute("aria-describedby") || wrapper.getAttribute("aria-describedby"),
      });
      const twin = fragment.firstElementChild;
      if (table.id) twin.id = table.id;
      table.replaceWith(twin);
      count++;
    }
    return count;
  }

  root.NumericBridgeRepairMetrics = Object.freeze({ readValue, formatNumber, formatValue, renderPairs, enhance });
  if (root.document?.readyState === "loading") {
    root.document.addEventListener("DOMContentLoaded", () => enhance(), { once: true });
  } else {
    enhance();
  }
})(globalThis);
