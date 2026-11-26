'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const preview = process.env.NUMERICBRIDGE_PREVIEW_URL;
const series = Object.fromEntries(Array.from({ length: 82 }, (_, i) => ['item-' + i, i]));
const index = {
  highlights: [], notes: [], assets: [],
  sources: [{ id: 'fixture', title: 'Fixture', source_sha256: 'local-test', export_sha256: 'local-test', data: { series } }],
  numeric_fields: Object.entries(series).map(([key, value]) => ({ source_id: 'fixture', pointer: '/series/' + key, value, unit: 'count', kind: 'number' })),
};

test('paper search, keyboard preview, and load recovery', { skip: !preview, timeout: 40000 }, async t => {
  const origin = new URL(preview);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Use a loopback preview');
  const { chromium } = require(process.env.NUMERICBRIDGE_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.NUMERICBRIDGE_CHROME });
  t.after(() => browser.close());
  async function paper(sub, statusCodes = [200]) {
    let requests = 0;
    const context = await browser.newContext({ serviceWorkers: 'block' });
    sub.after(() => context.close());
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin.origin || req.method() !== 'GET' || url.pathname.startsWith('/v1/')) return route.abort();
      if (url.pathname !== '/data/paper-results.json') return route.continue();
      const status = statusCodes[requests++] || 200;
      return route.fulfill({ status, json: status === 200 ? index : { unavailable: true } });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    sub.after(() => assert.deepEqual(errors, []));
    await page.goto(new URL('/paper.html', origin).href);
    return { page, requests: () => requests };
  }
  const active = page => page.evaluate(() => document.activeElement.id);
  const pages = page => page.locator('#page-number').textContent();

  await t.test('composition leaves prior results intact and pagination has a useful focus fallback', async s => {
    const { page } = await paper(s);
    await page.locator('#rows tr').first().waitFor();
    assert.equal(await pages(page), '1 / 2');
    await page.locator('#next').focus();
    await page.keyboard.press('Enter');
    assert.equal(await pages(page), '2 / 2');
    assert.equal(await active(page), 'previous');
    const query = page.locator('#query');
    await query.focus();
    await query.evaluate(input => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.value = 'item-';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
    assert.equal(await pages(page), '2 / 2');
    await query.evaluate(input => {
      input.value = 'item-81';
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'item-81' }));
    });
    await page.waitForFunction(() => document.getElementById('page-number').textContent === '1 / 1');
    assert.equal(await page.locator('#rows tr').count(), 1);
    assert.equal(await active(page), 'query');
  });

  await t.test('Escape returns to a preview opener but a queued close does not steal newly moved focus', async s => {
    const { page } = await paper(s);
    const row = page.locator('#rows tr button').first();
    await row.focus();
    await page.keyboard.press('Enter');
    assert.equal(await active(page), 'close-preview');
    await page.keyboard.press('Escape');
    assert.equal(await row.evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('Enter');
    await page.evaluate(() => new Promise(resolve => {
      const dialog = document.getElementById('preview');
      dialog.addEventListener('close', resolve, { once: true });
      dialog.close();
      document.getElementById('query').focus();
    }));
    assert.equal(await active(page), 'query');
  });

  await t.test('initial HTTP failure retries once in place, then restores search focus', async s => {
    const { page, requests } = await paper(s, [503, 200]);
    const retry = page.getByRole('button', { name: '重试', exact: true });
    await retry.waitFor();
    const started = await page.evaluate(() => performance.timeOrigin);
    await retry.focus();
    await retry.evaluate(button => { button.click(); button.click(); });
    await page.locator('#rows tr').first().waitFor();
    assert.equal(requests(), 2);
    assert.equal(await page.evaluate(() => performance.timeOrigin), started);
    assert.equal(await active(page), 'query');
    assert.equal(await retry.count(), 0);
  });
});
