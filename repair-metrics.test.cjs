'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, 'repair-metrics.js'), 'utf8');
function load(context = {}) {
  vm.runInNewContext(source, context);
  return context.NumericBridgeRepairMetrics;
}
const api = load();

// Capture the original public formatter's boundaries, including the integer exception.
test('number formatting matches the public SPA for signed and threshold values', () => {
  const cases = [
    [undefined, '—'], [null, '—'], [NaN, '—'], [0, '0'], [-0, '0'],
    [9999999, '9,999,999'], [-10000, '-10,000'], [10000000, '1.00e+7'],
    [10000.5, '1.00e+4'], [9999.9, '9999.9'], [100.56, '100.6'],
    [99.1234, '99.123'], [-1.234567, '-1.235'], [0.51234, '0.512'],
    [+1e-4, '0.000100'], [-9e-5, '-9.00e-5'], [Infinity, 'Infinity'],
  ];
  for (const [value, output] of cases) {
    assert.equal(api.formatNumber(value), output, String(value));
    assert.equal(api.formatValue(value), output, String(value));
    if (Number.isFinite(value)) assert.equal(api.formatValue(String(value)), output, String(value));
  }
});

test('reading SSR attributes retains exact tooltip text and distinguishes missing from zero', () => {
  assert.deepEqual({ ...api.readValue(' -2.457600E-7 ') }, { value: -2.4576e-7, title: '-2.457600E-7' });
  const negativeZero = api.readValue('-0.000');
  assert.ok(Object.is(negativeZero.value, -0));
  assert.equal(negativeZero.title, '-0.000');
  assert.equal(api.formatValue('-0.000'), '0');
  for (const raw of ['', '  ', '—', '1,000', '0x10', '3 kg', '1e9999', false]) {
    assert.deepEqual({ ...api.readValue(raw) }, { value: null, title: '' });
    assert.equal(api.formatValue(raw), '—');
  }
});

test('twin preserves labels, aria table order, headlines, units, and raw values', () => {
  const aux = Object.freeze({ label: 'Other', before: null, after: 3.4567 });
  const lead = Object.freeze({ label: 'Logprob <max>', before: -0.0000821234, after: 0, unit: 'A&B' });
  const rows = Object.freeze([aux, lead]);
  const meta = { beforeLabel: 'Baseline "raw"', afterLabel: "Candidate's", headline: { ...lead }, labelledBy: 'heading' };
  const html = api.renderPairs(rows, meta);
  assert.deepEqual(rows, [aux, lead]);
  assert.ok(html.startsWith('<div class="twin" role="table" aria-labelledby="heading">'));
  assert.match(html, /role="columnheader"><b>Baseline &quot;raw&quot;<\/b>.*role="columnheader"><b>Candidate&#39;s<\/b>/);
  assert.match(html, /role="rowheader">Logprob &lt;max&gt;<\/span><div class="tw-c b m hd" role="cell"><small aria-hidden="true">/);
  assert.match(html, /title="-0.0000821234">-8.21e-5<\/strong><em>A&amp;B<\/em>/);
  assert.match(html, /title="0">0<\/strong>/);
  assert.match(html, /role="rowheader">Other<\/span><div class="tw-c b m end" .*title="">—<\/strong>/);
  assert.match(html, /tw-c a m end.*title="3.4567">3.457<\/strong>/);
  assert.equal((html.match(/role="rowheader"/g) || []).length, rows.length);
  assert.equal(api.renderPairs([]), '');
  assert.match(api.renderPairs(rows, { headline: { label: 'not a validation metric' } }), /role="rowheader">Other<\/span><div class="tw-c b m hd"/);
});

function attrs(values = {}) {
  return { getAttribute: name => values[name] ?? null };
}

function fixture(rows, { readyState = 'loading', setup = {}, name = 'Measured results <test>' } = {}) {
  let table, swapped, listener;
  const marker = '[data-repair-metric-pair]';
  const wrapper = {
    ...attrs({ 'data-before-label': '修复前', 'data-after-label': '修复后', ...setup }),
    matches: selector => selector === marker,
    querySelectorAll(selector) { return selector === 'table' && table ? [table] : []; },
  };
  const doc = {
    readyState,
    querySelectorAll(selector) { return selector === marker ? [wrapper] : []; },
    addEventListener(event, callback, options) {
      assert.equal(event, 'DOMContentLoaded');
      assert.equal(options.once, true);
      listener = callback;
    },
    createElement(tag) {
      assert.equal(tag, 'div');
      return { set innerHTML(html) { this.firstElementChild = { html }; } };
    },
  };
  const tHead = {};
  table = {
    ...attrs({ 'aria-describedby': 'notes' }),
    id: 'metrics',
    caption: { textContent: name },
    tHead,
    rows: [{ ...attrs(), parentElement: tHead }, ...rows.map(values => ({ ...attrs(values), cells: [] }))],
    ownerDocument: doc,
    closest(selector) { return selector === marker ? wrapper : null; },
    replaceWith(node) { swapped = node; table = null; },
  };
  return { doc, wrapper, complete: () => listener(), swapped: () => swapped };
}

const metric = { 'data-label': 'Max & drift', 'data-before': '-1.00e-7', 'data-after': '0.0', 'data-unit': '1' };
test('DOMContentLoaded enhances Admin SSR using only raw values and preserves its name', () => {
  const page = fixture([
    { ...metric, 'data-label': 'Other', 'data-before': '', 'data-after': '0' },
    { ...metric, 'data-headline': '' },
  ]);
  const browser = load({ document: page.doc });
  assert.equal(page.swapped(), undefined);
  page.complete();
  const { id, html } = page.swapped();
  assert.equal(id, 'metrics');
  assert.match(html, /^<div class="twin" role="table" aria-label="Measured results &lt;test&gt;" aria-describedby="notes">/);
  assert.match(html, /<b>修复前<\/b>.*<b>修复后<\/b>/);
  assert.match(html, /role="rowheader">Max &amp; drift<\/span><div class="tw-c b m hd".*title="-1.00e-7">-1.00e-7<\/strong><em>1<\/em>/);
  assert.match(html, /title="0.0">0<\/strong>.*title="">—<\/strong>/);
  assert.equal(browser.enhance(page.wrapper), 0, 'the replacement is idempotent');
});

test('enhanced SSR output equals public output when raw values use JS number text', () => {
  const example = { label: 'Logprob', before: -0.0000821234, after: 0, unit: '' };
  const page = fixture([{
    'data-label': example.label, 'data-before': String(example.before), 'data-after': String(example.after), 'data-unit': example.unit, 'data-headline': 'true',
  }], { readyState: 'interactive' });
  load({ document: page.doc });
  assert.equal(page.swapped().html, api.renderPairs([example], {
    headline: example, beforeLabel: '修复前', afterLabel: '修复后', label: 'Measured results <test>', describedBy: 'notes',
  }));
});

test('absent or malformed SSR data does not replace fallback content', () => {
  for (const page of [
    fixture([], { readyState: 'interactive' }),
    fixture([metric], { readyState: 'interactive', setup: { 'data-after-label': '' } }),
    fixture([metric, { ...metric, 'data-unit': null }], { readyState: 'interactive' }),
    fixture([{ ...metric, 'data-after': 'Infinity' }], { readyState: 'interactive' }),
  ]) {
    load({ document: page.doc });
    assert.equal(page.swapped(), undefined);
  }
  const publicDoc = { readyState: 'interactive', querySelectorAll: () => [] };
  assert.equal(load({ document: publicDoc }).enhance(publicDoc), 0);
});

test('main SPA loads the shared twin and keeps repair and candidate wording', () => {
  const index = readFileSync(join(__dirname, 'index.html'), 'utf8');
  assert.match(index, /<script src="\.\/repair-metrics\.js"><\/script>\s*<script>/);
  const start = index.indexOf('function paintRepair(');
  const end = index.indexOf('\n}', start) + 2;
  const byId = (() => {
    const els = new Map();
    return id => { if (!els.has(id)) els.set(id, {}); return els.get(id); };
  })();
  const ctx = {
    byId, tx: (_zh, en) => en, esc: value => String(value ?? ''),
    renderRepairPairs: api.renderPairs, repairLibrary: () => 'Library', repairStatus: () => '',
    DW: { idx: 0, order: [0] }, parseHash: () => ({ name: 'repairs' }),
  };
  vm.runInNewContext(index.slice(start, end), ctx);
  const rp = { id: 'sample', short: 'Sample', validation: { metrics: [{ label: 'Error', before: -0.0000821234, after: 0 }] } };
  ctx.paintRepair(rp);
  assert.match(byId('dwBody').innerHTML, /<h4 id="dwRepairMetricsTitle">Measured results<\/h4><div class="twin" role="table" aria-labelledby="dwRepairMetricsTitle">/);
  assert.match(byId('dwBody').innerHTML, /<b>Before<\/b>.*<b>After<\/b>/);
  ctx.paintRepair({ ...rp, status: 'investigating' });
  assert.match(byId('dwBody').innerHTML, /<b>Baseline<\/b>.*<b>Candidate<\/b>/);
  ctx.paintRepair({ ...rp, validation: {} });
  assert.doesNotMatch(byId('dwBody').innerHTML, /Measured results|class="twin"/);
});
