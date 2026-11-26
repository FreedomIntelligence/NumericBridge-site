'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./board-data.js');
const catalog = global.NumericBridgeCatalog;

test('case and board requests share one fetched and parsed catalog document', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  let fetches = 0, reads = 0;
  global.fetch = async (_url, options) => {
    assert.equal(options.cache, 'no-cache');
    fetches++;
    return {ok: true, text: async () => { reads++; return '{"cases":[]}'; }};
  };
  const url = './data/shared-test.json';
  t.after(() => catalog.forget(url));
  const first = catalog.load(url), second = catalog.load(url);
  assert.strictEqual(first, second);
  const result = await second;
  assert.equal(result.text, '{"cases":[]}');
  assert.deepEqual(result.document, {cases: []});
  assert.strictEqual(await catalog.load(url), result);
  assert.equal(fetches, 1);
  assert.equal(reads, 1);
});

test('failed fetches and generation invalidation allow new bytes', async t => {
  const original = global.fetch;
  const url = './data/retry-test.json';
  t.after(() => { global.fetch = original; catalog.forget(url); });
  let calls = 0;
  global.fetch = async () => ++calls === 1 ? {ok: false, status: 503} :
    {ok: true, text: async () => JSON.stringify({generation: calls})};
  await assert.rejects(catalog.load(url), /HTTP 503/);
  assert.deepEqual((await catalog.load(url)).document, {generation: 2});
  catalog.forget(url);
  assert.deepEqual((await catalog.load(url)).document, {generation: 3});
});
