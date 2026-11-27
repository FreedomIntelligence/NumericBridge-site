'use strict';

// Opt in with NUMERICBRIDGE_PREVIEW_URL and an installed Playwright/Chromium.
const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');

const preview = process.env.NUMERICBRIDGE_PREVIEW_URL;
const root = '#v-cases';
const detail = '.lc-case-dialog[open]';
const options = '.lc-option-dialog[open]';
const launchDetail = '.lc-recommendation [data-case]';
const pick = '[data-pick-solution]';
const result = '#lc-solution-result';
const exampleParams = { hardware: 'Ascend 910C', model: 'google/gemma-4-31B-it', library: 'vLLM', task: 'inference' };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function holdGET(page, path, response) {
  const arrived = deferred(), release = deferred();
  await page.route(url => url.pathname === path, async route => {
    assert.equal(route.request().method(), 'GET');
    arrived.resolve();
    await release.promise;
    if (response) await route.fulfill(response);
    else await route.fallback();
  });
  return { arrived: arrived.promise, release: release.resolve };
}

async function focused(page, selector) {
  await page.waitForFunction(sel => document.activeElement?.matches(sel), selector);
}

function hash(page) {
  return new URL(page.url()).hash;
}

function params(page) {
  return new URLSearchParams(hash(page).split('?')[1]);
}

async function visitCases(page, suffix = '') {
  await page.goto(new URL('#/cases' + suffix, preview).href, { waitUntil: 'domcontentloaded' });
  await page.locator(root + ' .lc-selectors').waitFor();
}

async function openCase(page) {
  await page.locator(launchDetail).press('Enter');
  await page.locator(detail).waitFor();
  await focused(page, '#lc-case-title');
}

async function returnedToList(page, listHash) {
  await page.waitForFunction(expected => location.hash === expected && !document.body.classList.contains('locked'), listHash);
  await focused(page, launchDetail);
  assert.equal(await page.locator(detail).count(), 0);
}

describe('public cases interactions', { skip: !preview && 'Set NUMERICBRIDGE_PREVIEW_URL for the GET-only browser tests' }, () => {
  let browser;
  before(async () => {
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(preview).hostname), 'Use a loopback preview');
    const { chromium } = require(process.env.NUMERICBRIDGE_PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ executablePath: process.env.NUMERICBRIDGE_CHROME, timeout: 10000 });
  });
  after(async () => browser?.close());

  async function pageFor(t) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    t.after(() => context.close());
    // No submissions or actual clipboard writes; keep tests on public local data.
    const origin = new URL(preview).origin;
    await context.route('**/*', route => {
      const request = route.request(), requested = new URL(request.url());
      return request.method() === 'GET' && requested.origin === origin && !requested.pathname.startsWith('/v1/') ? route.continue() : route.abort();
    });
    await context.addInitScript(() => {
      window.clipboardCalls = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: text => new Promise(resolve => window.clipboardCalls.push({ text, resolve }))
      } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    return page;
  }

  test('native options Escape/close returns focus; choosing a model focuses its live selector', async t => {
    const page = await pageFor(t);
    await visitCases(page, '?' + new URLSearchParams({ ...exampleParams, model: 'gemma4' }));
    const opener = '[data-selector-more="model"]';
    assert.equal(await page.locator('.lc-recommendation [data-pick-model]').count(), 0);
    assert.match(await page.locator('.lc-recommendation .lc-module-empty').textContent(), /整个模型系列/);
    await page.locator(opener).press('Enter');
    await focused(page, options + ' [data-options-search]');
    await page.keyboard.press('Escape');
    await page.locator(options).waitFor({ state: 'detached' });
    await focused(page, opener);
    await page.locator('body.locked').waitFor({ state: 'detached' });
    await page.locator(opener).press('Enter');
    await page.locator('[data-options-close]').press('Enter');
    await focused(page, opener);
    await page.locator(opener).press('Enter');
    await page.locator('[data-options-search]').fill(exampleParams.model);
    await page.locator(options + ' [data-choose-field="model"][data-value="' + exampleParams.model + '"]').press('Enter');
    await focused(page, '.lc-selectors [data-choose-field="model"][aria-pressed="true"], .lc-selectors [data-selector-more="model"]');
    assert.equal(params(page).get('model'), exampleParams.model);
    assert.equal(await page.locator(options).count(), 0);
  });

  test('Back/Forward restores case detail and its opener; explicit close and Escape return to the list', async t => {
    const page = await pageFor(t);
    await visitCases(page, '?' + new URLSearchParams(exampleParams));
    const listHash = hash(page);
    const historyLength = await page.evaluate(() => history.length);
    await openCase(page);
    const solution = 'gemma4-rms-reference-pow-20261124';
    await page.locator(pick + '[data-pick-solution="' + solution + '"]').press('Enter');
    const caseHash = hash(page);
    assert.match(caseHash, /^#\/cases\/[^?]+\?/);
    assert.equal(params(page).get('solution'), solution);
    assert.equal(await page.evaluate(() => history.length), historyLength + 1);
    await page.goBack();
    await returnedToList(page, listHash);
    await page.goForward();
    await focused(page, '#lc-case-title');
    assert.equal(hash(page), caseHash);
    assert.equal(await page.locator(result).getAttribute('data-solution'), solution);
    await page.locator('[data-detail-close]').press('Enter');
    await returnedToList(page, listHash);
    await page.goForward();
    await focused(page, '#lc-case-title');
    await page.keyboard.press('Escape');
    await returnedToList(page, listHash);
  });

  test('issue detail preserves context and returns to the correct opener among issues in the same case', async t => {
    const page = await pageFor(t);
    await visitCases(page, '?' + new URLSearchParams({ hardware: 'Ascend 910C', model: 'Qwen3.5-9B-Base', library: 'MindSpeed', task: 'rl' }));
    const issue = 'issue-mindspeed-residual-peer-differences';
    const opener = '[data-issue="' + issue + '"]';
    const listHash = hash(page);
    await page.locator(opener).press('Enter');
    await focused(page, '#lc-case-title');
    assert.equal(params(page).get('issue'), issue);
    assert.equal(await page.locator(opener).getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.lc-list [aria-expanded="true"]').count(), 1);
    await page.goBack();
    await focused(page, opener);
    assert.equal(hash(page), listHash);
    assert.equal(await page.locator(opener).getAttribute('aria-expanded'), 'false');
  });

  test('evaluation history stays newest first without displaying dates in the case lists', async t => {
    const page = await pageFor(t);
    await visitCases(page, '?' + new URLSearchParams({ model: 'google/gemma-4-12B' }));
    const rows = page.locator('[data-model-records] .lc-evaluation-links > li');
    await rows.first().waitFor();
    const evaluations = await page.evaluate(async () => (await window.NumericBridgeCatalog.load('./data/evaluations.json')).document.evaluations);
    const dates = new Map(evaluations.map(row => [row.id, row.date]));
    const links = await rows.evaluateAll(items => items.map(item => item.querySelector('a').getAttribute('href')));
    const history = links.map(href => {
      const id = new URLSearchParams(href.split('?')[1]).get('comparison');
      return { href, id, date: dates.get(id) };
    });
    assert.ok(new Set(history.map(row => row.date)).size > 1, 'fixture has multiple evaluation dates');
    assert.equal(await rows.locator('time').count(), 0);
    for (const row of history) assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(history, history.slice().sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)));

    const first = history[0];
    assert.equal(await rows.first().getByRole('link').count(), 1);
    await rows.first().getByRole('link').press('Enter');
    const reportMeta = page.locator('#v-report .lc-report-head h1 + p');
    await reportMeta.waitFor();
    assert.ok((await reportMeta.textContent()).endsWith(first.date));

    const recordQuery = new URLSearchParams({ ev: first.id, group: 'eval', sort: 'date' });
    await page.goto(new URL('#/list?' + recordQuery, preview).href);
    const groupMeta = page.locator('#v-list .gsub');
    await groupMeta.waitFor();
    assert.ok((await groupMeta.textContent()).includes(first.date));
  });

  test('keyboard alternative-version action leaves focus at the updated recommendation', async t => {
    const page = await pageFor(t);
    await visitCases(page, '?' + new URLSearchParams({ ...exampleParams, version: '0.0.0' }));
    await page.locator('[data-show-alternatives]').press('Enter');
    await focused(page, '.lc-recommendation h2');
    assert.equal(params(page).get('alternatives'), '1');
    assert.equal(await page.locator('[data-show-alternatives]').count(), 0);
    assert.equal(await page.locator('.lc-recommendation h3').count(), 1);
  });

  test('open solution survives pending evidence, clipboard race, a shared URL and report round-trip', async t => {
    const page = await pageFor(t);
    const held = await holdGET(page, '/data/solution-results.json');
    t.after(held.release);
    await visitCases(page, '/case-mindspeed-zero-centered-rmsnorm?alternatives=1');
    await focused(page, '#lc-case-title');
    assert.equal(await page.locator(result).getAttribute('aria-busy'), 'true');
    await page.locator('[data-copy]').press('Enter');
    const firstURL = page.url();
    const selected = 'solution-mindspeed-selective-fp32-projection';
    await page.locator(pick + '[data-pick-solution="' + selected + '"][aria-pressed="false"]').press('Enter');
    const report = page.locator(result + ' a').first();
    assert.equal(params(page).get('solution'), selected);
    const shared = page.url();
    await page.evaluate(() => {
      window.clipboardCalls[0].resolve();
    });
    assert.equal(await page.locator('[data-copy]').textContent(), '复制链接');
    await page.locator('[data-copy]').press('Enter');
    assert.deepEqual(await page.evaluate(() => window.clipboardCalls.map(call => call.text)), [firstURL, shared]);
    await page.evaluate(() => window.clipboardCalls[1].resolve());
    await page.getByRole('button', { name: '已复制' }).waitFor();

    await held.arrived;
    await report.focus();
    await page.evaluate(() => { window.focusedReport = document.activeElement; });
    held.release();
    await page.waitForFunction(sel => !document.querySelector(sel)?.hasAttribute('aria-busy'), result);
    assert.equal(await page.evaluate(() => document.activeElement === window.focusedReport && window.focusedReport.isConnected), true);
    assert.equal(await page.locator(result).getAttribute('data-solution'), selected);
    await report.press('Enter');
    await page.locator('#v-report .lc-report-head').waitFor();
    await page.locator('#v-report article > a').press('Enter');
    await focused(page, '#lc-case-title');
    assert.equal(params(page).get('solution'), selected);
    assert.equal(params(page).get('alternatives'), '1');
    assert.equal(await page.locator(result).getAttribute('data-solution'), selected);

    const sharedPage = await pageFor(t);
    await sharedPage.goto(shared, { waitUntil: 'domcontentloaded' });
    await focused(sharedPage, '#lc-case-title');
    const historyLength = await sharedPage.evaluate(() => history.length);
    assert.equal(await sharedPage.locator(result).getAttribute('data-solution'), selected);
    await sharedPage.keyboard.press('Escape');
    await focused(sharedPage, root + ' .lc-intro h1');
    assert.match(hash(sharedPage), /^#\/cases\?/);
    assert.equal(params(sharedPage).has('solution'), false);
    assert.equal(await sharedPage.evaluate(() => history.length), historyLength);
  });

  test('optional credits do not hold the case library or replace existing detail focus', async t => {
    const page = await pageFor(t);
    const id = 'case-gemma4-bf16-910c-b200-20261124';
    const held = await holdGET(page, '/data/acknowledgments.json', { json: { entries: [
      { case_id: id, mode: 'nickname', name: 'Test credit', contribution: { zh: '测试署名', en: 'Test attribution' } }
    ] } });
    t.after(held.release);
    await visitCases(page, '?' + new URLSearchParams(exampleParams));
    await openCase(page);
    await held.arrived;
    assert.equal(await page.getByText('Test credit', { exact: false }).count(), 0);
    held.release();
    await page.locator(detail).getByText('Test credit', { exact: false }).waitFor();
    await focused(page, '#lc-case-title');
  });

  test('retry recovers after a failed index request and focuses the loaded library heading', async t => {
    const page = await pageFor(t);
    await page.route('**/data/search-index.json', route => route.fulfill({ status: 503 }), { times: 1 });
    await page.goto(new URL('#/cases', preview).href, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-retry]').press('Enter');
    await focused(page, root + ' .lc-intro h1');
  });

  test('vLLM is highlighted without a task filter, and records page below issues', async t => {
    const page = await pageFor(t);
    await page.setViewportSize({width:1280,height:900});
    await visitCases(page);
    const records = page.locator('[data-model-records]');
    const issues = page.locator('.lc-related');
    const rows = records.locator('.lc-evaluation-links > li');
    const pane = records.locator('.lc-evaluation-page');
    const prev = records.locator('[data-evaluation-page="prev"]');
    const next = records.locator('[data-evaluation-page="next"]');
    const picked = page.locator('[data-choices="library"] [data-value="vLLM"][data-task="inference"]');
    assert.deepEqual([...params(page)], [['library', 'vLLM']]);
    assert.equal(await picked.getAttribute('aria-pressed'), 'true');
    await picked.waitFor({state:'visible'});
    assert.equal(await rows.count(), 8);
    assert.ok((await issues.boundingBox()).y < (await records.boundingBox()).y);
    assert.ok(await prev.isDisabled());
    assert.equal(await issues.locator('.lc-list').isVisible(), false);
    const sidebar = page.locator('.lc-demand');
    const footer = records.locator('.lc-pagination');
    const recommendation = page.locator('.lc-recommendation');
    const bottom = async locator => { const box = await locator.boundingBox(); return box.y + box.height; };
    const aligned = async () => {
      assert.ok(Math.abs(await bottom(records) - await bottom(sidebar)) <= 1);
      assert.ok(Math.abs(await bottom(records) - await bottom(footer) - 13) <= 1);
    };
    await aligned();
    for (const [module, label] of [[recommendation, '暂时没有推荐配置'], [issues, '暂时没有相关的问题']]) {
      const empty = module.locator('.lc-module-empty');
      assert.equal(await empty.textContent(), label);
      const bounds = await empty.boundingBox();
      const body = await module.locator('.lc-module-body').boundingBox();
      assert.ok(Math.abs((bounds.y + bounds.height/2) - (body.y + body.height/2)) <= 1);
    }
    const firstPage = await rows.allTextContents();
    const height = (await pane.boundingBox()).height;
    await next.press('Enter');
    await page.evaluate(() => scrollTo({top:0,behavior:'instant'}));
    assert.ok(await rows.count() <= 8);
    assert.notDeepEqual(await rows.allTextContents(), firstPage);
    assert.equal((await pane.boundingBox()).height, height);
    await aligned();
    assert.ok(await prev.isEnabled());
    const secondPage = await rows.allTextContents();
    const entry = rows.first().getByRole('link');
    await entry.press('Enter');
    await page.locator('#v-report .lc-report-head').waitFor();
    const back = page.locator('#v-report .lc-report-back');
    assert.match(await back.textContent(), /返回评测记录/);
    await back.press('Enter');
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-evaluation-detail'));
    assert.equal(await page.locator(detail).count(), 0);
    assert.deepEqual(await rows.allTextContents(), secondPage);
    await prev.press('Enter');
    assert.deepEqual(await rows.allTextContents(), firstPage);
    await page.setViewportSize({width:1050,height:750});
    await page.evaluate(() => scrollTo({top:0,behavior:'instant'}));
    await aligned();
    await page.setViewportSize({width:390,height:850});
    assert.ok((await issues.boundingBox()).y < (await records.boundingBox()).y);
    assert.equal(await rows.first().getByRole('link').count(), 1);
    await rows.first().getByRole('link').click();
    await page.locator('#v-report .lc-report-head').waitFor();
    await page.locator('#v-report .lc-report-back').click();
    await rows.first().waitFor();
    assert.deepEqual(await rows.allTextContents(), firstPage);
    await next.press('Enter');
    await page.locator('[data-reset]').press('Enter');
    assert.deepEqual([...params(page)], [['library', 'vLLM']]);
    assert.deepEqual(await rows.allTextContents(), firstPage);
    await visitCases(page, '?library=');
    assert.deepEqual([...params(page)], [['library', '']]);
  });
});
