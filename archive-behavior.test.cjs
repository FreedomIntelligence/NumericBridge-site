'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

// Opt in against an existing local preview. The default node --test run needs no browser.
const preview = process.env.NUMERICBRIDGE_PREVIEW_URL;
const url = preview && new URL('/archive.html', preview).href;
async function inBrowser(run) {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(preview).hostname), 'Use a loopback preview');
  const { chromium } = require(process.env.NUMERICBRIDGE_PLAYWRIGHT_MODULE || 'playwright');
  const executablePath = process.env.NUMERICBRIDGE_CHROME;
  const browser = await chromium.launch({ headless: true, ...(executablePath && { executablePath }) });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    const origin = new URL(preview).origin;
    await page.context().route('**/*', route => {
      const request = route.request(), requested = new URL(request.url());
      return request.method() === 'GET' && requested.origin === origin && !requested.pathname.startsWith('/v1/') ? route.continue() : route.abort();
    });
    await run(page);
  } finally { await browser.close(); }
}

function loaded(page, kind) {
  return page.waitForFunction((kind) => document.body.dataset.archive === kind &&
    !document.getElementById('download').disabled && !document.getElementById('history').hasAttribute('aria-busy'), kind);
}
const active = (page) => page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
const miss = 'archive-browser-test-no-matching-record';

// Use real keyboard and session history instead of dispatching synthetic hashchange events.
test('archive restores keyboard focus on Back, record links, and search reset', { skip: !url }, async () => {
  await inBrowser(async (page) => {
    await page.goto(url);
    await loaded(page, 'repairs');
    assert.equal(await active(page), 'BODY');
    const record = page.locator('.verification-card').first();
    const id = await record.getAttribute('id');
    const search = page.locator('#search');
    await search.fill(miss);
    assert.equal(await page.locator('.verification-card').count(), 0);
    await page.locator('#reset').focus();
    await page.keyboard.press('Enter');
    assert.equal(await active(page), 'search');
    assert.equal(await search.inputValue(), '');
    assert.equal(await page.locator('#reset').isVisible(), false);
    assert.ok(await page.locator('.verification-card').count());

    await page.locator('#tab-repairs').focus();
    await page.keyboard.press('ArrowRight');
    await loaded(page, 'evaluations');
    assert.equal(await active(page), 'tab-evaluations');
    await page.goBack();
    await loaded(page, 'repairs');
    assert.equal(await active(page), 'tab-repairs');
    assert.equal(new URL(page.url()).hash, '');

    await search.fill(miss);
    await page.evaluate((id) => { location.hash = id; }, id);
    await page.waitForFunction((id) => document.activeElement.closest('article')?.id === id, id);
    assert.equal(await search.inputValue(), '');
    assert.equal(await record.locator('details').getAttribute('open'), '');
    await page.reload();
    await page.waitForFunction((id) => document.activeElement.closest('article')?.id === id, id);
    assert.equal(await active(page), 'H5');
    await record.locator('.permalink').focus();
    await page.keyboard.press('Enter');
    assert.equal(await active(page), 'H5');
  });
});

test('a difference deep link opens and focuses a record on a later page', { skip: !url }, async () => {
  await inBrowser(async (page) => {
    await page.goto(new URL('#differences', url).href);
    await loaded(page, 'differences');
    const group = page.locator('.difference-model').filter({ has: page.locator('.difference-pagination:not([hidden])') }).first();
    const pager = group.locator('.difference-pagination select');
    await pager.selectOption('1');
    const id = await group.locator('.difference-card').first().getAttribute('id');
    await pager.selectOption('0');
    assert.equal(await page.evaluate((id) => !!document.getElementById(id), id), false);
    await page.evaluate((id) => { location.hash = encodeURIComponent(id); }, id);
    await page.waitForFunction((id) => document.activeElement.parentElement?.id === id, id);
    assert.equal(await pager.inputValue(), '1');
    assert.equal(await page.evaluate((id) => document.getElementById(id).open, id), true);
  });
});

test('loading keeps search usable and ignores a superseded JSON response', { skip: !url }, async () => {
  await inBrowser(async (page) => {
    await page.goto(url);
    await loaded(page, 'repairs');
    await page.evaluate(() => {
      const originalFetch = window.fetch;
      const originalSetContent = PrecisionRepairPresentation.setContent;
      const probe = window.archiveTest = { writes: 0 };
      PrecisionRepairPresentation.setContent = (content) => { probe.writes++; originalSetContent(content); };
      window.fetch = async (input, options) => {
        const response = await originalFetch(input, options);
        if (!input.endsWith('/evaluations.json')) return response;
        return { ok: response.ok, json: async () => {
          const result = await response.json();
          // Retain a parsed response even after the underlying fetch is aborted.
          await new Promise((resolve) => { probe.release = resolve; });
          return result;
        } };
      };
    });
    const search = page.locator('#search');
    await search.fill(miss);
    await page.locator('#tab-evaluations').click();
    await page.waitForFunction(() => !!window.archiveTest.release);
    assert.equal(await search.inputValue(), '');
    assert.equal(await page.locator('#reset').isVisible(), false);
    assert.equal(await page.locator('#history').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#download').isEnabled(), false);
    assert.equal(await page.locator('#library').isEnabled(), false);
    assert.equal(await search.isEnabled(), true);
    await search.fill(miss);
    assert.equal(await page.locator('#reset').isVisible(), true);
    await page.locator('#reset').focus();
    await page.keyboard.press('Enter');
    assert.equal(await search.inputValue(), '');
    assert.equal(await active(page), 'search');
    assert.equal(await page.locator('#history').getAttribute('aria-busy'), 'true');

    await page.goBack();
    await loaded(page, 'repairs');
    const before = await page.locator('#result-count').textContent();
    await page.evaluate(async () => {
      window.archiveTest.release();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.equal(await page.evaluate(() => window.archiveTest.writes), 1);
    assert.equal(await page.locator('#result-count').textContent(), before);
    assert.equal(await page.locator('#library').isEnabled(), true);
    assert.equal(await active(page), 'tab-repairs');
  });
});
