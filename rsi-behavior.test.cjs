'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

// Opt in against a preview serving the public RSI snapshot; all requests are GETs.
const preview = process.env.NUMERICBRIDGE_PREVIEW_URL;
const url = preview && new URL('/rsi.html', preview).href;
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
    const response = await page.request.get(new URL('./data/rsi.json', url).href);
    assert.equal(response.ok(), true);
    await run(page, await response.json());
  } finally { await browser.close(); }
}

const active = (page) => page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
const selected = (page) => page.locator('#run-id').textContent();
const message = (page) => page.locator('#message').textContent();
const waitForRun = (page, id) => page.waitForFunction(id => document.getElementById('run-id').textContent === id, id);
const waitForRefresh = (page) => page.waitForFunction(() => !document.getElementById('refresh').hasAttribute('aria-disabled'));
const waitForMessage = (page, text) => page.waitForFunction(text => document.getElementById('message').textContent.includes(text), text);
const firstSummary = (page) => page.locator('#rounds summary').first();
async function openFirstRound(page) {
  await firstSummary(page).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#rounds details').first().getAttribute('open'), '');
}

function gate() {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  return {wait, release};
}

async function fixtureRoute(page, fixture) {
  const state = { data: fixture, requests: 0, status: 200 };
  await page.route('**/data/rsi.json', async (route) => {
    assert.equal(route.request().method(), 'GET');
    ++state.requests;
    if (state.hold) await state.hold.wait;
    const body = state.body ?? JSON.stringify(state.data);
    await route.fulfill({status: state.status, contentType: 'application/json', body});
  });
  return state;
}

test('the public snapshot retains the default resting controls and collapsed rounds', {skip: !url}, async () => {
  await inBrowser(async (page, fixture) => {
    await page.goto(url);
    await waitForRun(page, fixture.current_run);
    assert.equal(await active(page), 'BODY');
    assert.equal(await page.locator('#run-count').textContent(), String(fixture.runs.length));
    assert.equal(await page.locator('#round-filter').inputValue(), 'all');
    assert.equal(await page.locator('#rounds details[open]').count(), 0);
    assert.equal(await message(page), '');
    assert.equal(new URL(page.url()).hash, '');
  });
});

test('RSI refresh stays keyboard-accessible, coalesces, and preserves active focus and expansion', {skip: !url}, async () => {
  await inBrowser(async (page, fixture) => {
    await page.clock.install();
    const state = await fixtureRoute(page, fixture);
    await page.goto(url);
    await waitForRun(page, fixture.current_run);
    const summary = firstSummary(page);
    await page.locator('#run-search').fill('npu-rsi');
    await page.locator('#round-filter').selectOption('rejected');
    await openFirstRound(page);

    // Hold a real page GET while the Enter key and the interval both attempt to refresh.
    await page.clock.fastForward(59000);
    state.hold = gate();
    await page.locator('#refresh').focus();
    const requested = page.waitForRequest('**/data/rsi.json');
    await page.keyboard.press('Enter');
    await requested;
    assert.equal(await page.locator('#refresh').getAttribute('aria-disabled'), 'true');
    assert.equal(await active(page), 'refresh');
    await page.keyboard.press('Enter');
    await page.clock.fastForward(1000);
    state.hold.release();
    state.hold = undefined;
    await waitForRefresh(page);
    assert.equal(state.requests, 2);
    assert.equal(await active(page), 'refresh');
    assert.equal(await page.locator('#rounds details').first().getAttribute('open'), '');

    // A changed periodic response still restores the summary that held keyboard focus.
    const current = state.data.runs.find(run => run.id === fixture.current_run);
    const priorRounds = current.rounds.filter(round => round.status === 'rejected').length;
    current.rounds.push({...current.rounds[0], index: Math.max(...current.rounds.map(round => round.index)) + 1, status: 'rejected'});
    await summary.focus();
    await page.clock.fastForward(60000);
    await page.waitForFunction(count => document.querySelectorAll('#rounds details').length === count, priorRounds + 1);
    assert.equal(await active(page), 'SUMMARY');
    assert.equal(await summary.evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('#rounds details').first().getAttribute('open'), '');
    assert.equal(await page.locator('#round-filter').inputValue(), 'rejected');
    assert.equal(await page.locator('#run-search').inputValue(), 'npu-rsi');

    const visibleRun = page.locator('#runs button').first();
    await visibleRun.focus();
    current.status = 'running';
    await page.clock.fastForward(60000);
    await page.waitForFunction(() => document.querySelector('#run-status .badge.running'));
    assert.equal(await visibleRun.evaluate(el => el === document.activeElement), true);

    // The periodic check waits while hidden and catches up once the page is visible.
    const requests = state.requests;
    await page.evaluate(() => Object.defineProperty(document, 'hidden', {configurable: true, value: true}));
    await page.clock.fastForward(60000);
    assert.equal(state.requests, requests);
    const resumed = page.waitForRequest('**/data/rsi.json');
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await resumed;
    await waitForRefresh(page);
    assert.equal(state.requests, requests + 1);
  });
});

test('RSI run selection restores by URL, Back/Forward, fallback, and filtering', {skip: !url}, async () => {
  await inBrowser(async (page, fixture) => {
    const state = await fixtureRoute(page, fixture);
    const [first, second, third] = fixture.runs;
    await page.goto(url);
    await waitForRun(page, first.id);
    await openFirstRound(page);
    await page.locator('#round-filter').selectOption('accepted');
    assert.equal(await page.locator('#rounds details[open]').count(), 0);
    await page.locator('#round-filter').selectOption('rejected');
    assert.equal(await page.locator('#rounds details').first().getAttribute('open'), '');

    const secondButton = page.locator('#runs button').nth(1);
    await secondButton.focus();
    await page.keyboard.press('Enter');
    assert.equal(await selected(page), second.id);
    assert.equal(await secondButton.evaluate(el => el === document.activeElement), true);
    assert.equal(await secondButton.getAttribute('aria-pressed'), 'true');
    await page.locator('#runs button').nth(2).click();
    assert.equal(await selected(page), third.id);
    await page.goBack();
    await waitForRun(page, second.id);
    await page.goBack();
    await waitForRun(page, first.id);
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await page.locator('#rounds details').first().getAttribute('open'), '');
    await page.goForward();
    await waitForRun(page, second.id);
    await page.reload();
    await waitForRun(page, second.id);
    await page.evaluate(() => { location.hash = 'workspace'; });
    assert.equal(await selected(page), second.id);
    await page.goBack();

    state.data = {...fixture, current_run: third.id, runs: fixture.runs.filter(run => run.id !== second.id)};
    await page.locator('#refresh').click();
    await waitForRun(page, third.id);
    assert.equal(new URL(page.url()).hash, '#' + second.id);
    state.data = {...fixture, current_run: third.id};
    await page.locator('#refresh').click();
    await waitForRun(page, second.id);

    await page.goto(new URL('#%zz', url).href);
    await waitForRun(page, third.id);
    assert.equal(await message(page), '');
    await page.evaluate(() => { location.hash = ''; });
    state.data = fixture;
    await page.locator('#refresh').click();
    await waitForRun(page, first.id);
    assert.equal(new URL(page.url()).hash, '');
  });
});

test('RSI errors preserve coherent data, time out, and recover on retry', {skip: !url}, async () => {
  await inBrowser(async (page, fixture) => {
    await page.clock.install();
    const state = await fixtureRoute(page, fixture);
    state.status = 503;
    await page.goto(url);
    await waitForMessage(page, 'HTTP 503');
    assert.doesNotMatch(await message(page), /保留已有画面/);
    assert.equal(await page.locator('#rounds details').count(), 0);

    state.status = 200;
    await page.locator('#refresh').click();
    await waitForRun(page, fixture.current_run);
    await openFirstRound(page);
    const before = await page.locator('#snapshot-time').textContent();
    state.data = {...fixture, observed_at: '2026-05-01T00:00:00Z', runs: [ {...fixture.runs[0], rounds: null}, ...fixture.runs.slice(1) ]};
    await page.locator('#refresh').click();
    await waitForMessage(page, '快照格式不兼容');
    assert.match(await message(page), /保留已有画面/);
    assert.equal(await page.locator('#snapshot-time').textContent(), before);
    assert.equal(await page.locator('#rounds details').first().getAttribute('open'), '');
    assert.equal(await selected(page), fixture.current_run);

    state.body = '{incomplete JSON';
    await page.locator('#refresh').click();
    await waitForRefresh(page);
    assert.match(await message(page), /快照格式不兼容/);
    assert.equal(await page.locator('#snapshot-time').textContent(), before);
    state.body = undefined;

    state.data = fixture;
    state.hold = gate();
    await page.locator('#refresh').click();
    await page.clock.fastForward(15000);
    await waitForMessage(page, '请求超时');
    state.hold.release();
    state.hold = undefined;
    await waitForRefresh(page);
    assert.equal(await active(page), 'refresh');
    await page.locator('#refresh').click();
    await waitForRefresh(page);
    assert.equal(await message(page), '');
    assert.equal(await page.locator('#rounds details').first().getAttribute('open'), '');

    state.data = {...fixture, observed_at: 'invalid date', current_run: null, runs: []};
    await page.locator('#refresh').click();
    await waitForRefresh(page);
    assert.equal(await page.locator('#snapshot-time').textContent(), '—');
    assert.equal(await page.locator('#run-count').textContent(), '0');
    assert.equal(await selected(page), '');
    assert.equal(await page.locator('#rounds details').count(), 0);
    assert.equal(await message(page), '');
  });
});
