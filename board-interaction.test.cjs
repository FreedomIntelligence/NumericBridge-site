'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Opt in with a running read-only local preview and an existing Playwright install.
// This suite never sends requests directly to the production site or its API.
const preview = process.env.NUMERICBRIDGE_PREVIEW_URL;
test('public board keyboard, history and failure recovery', { skip: !preview, timeout: 65000 }, async t => {
  const { chromium } = require(process.env.NUMERICBRIDGE_PLAYWRIGHT_MODULE || 'playwright');
  const origin = new URL(preview);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Use a loopback preview');
  const browser = await chromium.launch({ executablePath: process.env.NUMERICBRIDGE_CHROME || undefined, headless: true });
  t.after(() => browser.close());
  async function open(path, options = {}) {
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 950 }, serviceWorkers: 'block', ...options.context });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin.origin || !['GET', 'HEAD'].includes(request.method()) || url.pathname.startsWith('/v1/')) return route.abort();
      return options.intercept?.(route, url) || route.continue();
    });
    if (options.init) await page.addInitScript(options.init);
    await page.goto(new URL(path, origin).href);
    return { page, context, errors };
  }
  const focusId = page => page.evaluate(() => document.activeElement.id);
  const hash = page => new URL(page.url()).hash;
  const afterDebounce = page => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 155)));

  await t.test('closed drawer is inert and open drawer wraps Tab, closes, and restores its trigger', async () => {
    const { page, context, errors } = await open('/#/list');
    try {
      const row = page.locator('#lTbl .trow[data-id]').first();
      await row.waitFor();
      assert.equal(await page.locator('#drawer').evaluate(el => el.inert), true);
      await page.locator('#dwClose').evaluate(el => el.focus());
      assert.notEqual(await focusId(page), 'dwClose');
      await row.focus();
      await page.keyboard.press('Enter');
      assert.equal(await focusId(page), 'dwClose');
      assert.equal(await page.locator('#main').evaluate(el => el.inert), true);
      const focusables = await page.evaluate(() => [...document.querySelectorAll('#drawer a[href], #drawer button, #drawer summary, #drawer [tabindex]')].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length).map(el => ({ id: el.id, text: el.textContent }))) ;
      const first = page.locator('#'+focusables[0].id);
      await first.focus();
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), focusables.at(-1).text);
      await page.keyboard.press('Tab');
      assert.equal(await focusId(page), focusables[0].id);
      const originalRecord = hash(page);
      await page.locator('#dwBody').focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(hash(page), originalRecord, 'ArrowDown stays available for native reading scroll');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('main').inert);
      assert.equal(await page.locator('#main').evaluate(el => el.inert), false);
      assert.equal(await row.evaluate(el => el === document.activeElement), true);
      assert.equal(/\bid=/.test(hash(page)), false);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await t.test('Back and Forward step through opened detail; reloaded permalinks close in place', async () => {
    const { page, context, errors } = await open('/#/records');
    try {
      await page.locator('#v-records a[href^="#/list"]').click();
      const row = page.locator('#lTbl .trow[data-id]').first();
      await row.waitFor();
      const parent = hash(page), id = await row.getAttribute('data-id');
      await row.focus();
      await page.keyboard.press('Enter');
      const opened = hash(page);
      assert.equal(new URLSearchParams(opened.split('?')[1]).get('id'), id);
      await page.evaluate(() => history.back());
      await page.waitForFunction(() => document.getElementById('drawer').inert);
      assert.equal(hash(page), parent);
      assert.equal(await row.evaluate(el => el === document.activeElement), true);
      await page.evaluate(() => history.forward());
      await page.waitForFunction(() => !document.getElementById('drawer').inert);
      assert.equal(hash(page), opened);
      await page.reload();
      await page.waitForFunction(() => !document.getElementById('drawer').inert);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.getElementById('drawer').inert);
      assert.equal(hash(page), parent);
      assert.equal(await row.evaluate(el => el === document.activeElement), true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await t.test('list shortcuts keep native buttons functional and restore focus after rerender', async () => {
    const { page, context } = await open('/#/list');
    try {
      const rows = page.locator('#lTbl .trow[data-id]');
      await rows.first().waitFor();
      await rows.first().focus();
      await page.keyboard.press('j');
      assert.equal(await rows.nth(1).evaluate(el => el === document.activeElement), true);
      await page.locator('#lFbtn').focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#drawer').evaluate(el => el.inert), true);
      assert.equal(await page.locator('#lFbtn').getAttribute('aria-expanded'), 'true');
      const sort = page.locator('#lTbl [data-sort="dev"]');
      await sort.focus();
      await page.keyboard.press('Enter');
      assert.equal(await sort.evaluate(el => el === document.activeElement), true);
      assert.equal(await sort.getAttribute('aria-sort'), 'ascending');
      await page.keyboard.press('/');
      assert.equal(await focusId(page), 'lQ');
      const noMatch = 'nothing-should-match-this-20261126';
      await page.locator('#lQ').fill(noMatch);
      await page.keyboard.press('Enter');
      await page.locator('#lReset').waitFor();
      assert.equal(new URLSearchParams(hash(page).split('?')[1]).get('q'), noMatch);
      assert.match(await page.locator('#lRecNote').textContent(), /^0 /);
      await page.locator('#lReset').focus();
      await page.keyboard.press('Enter');
      assert.equal(await focusId(page), 'lQ');
      assert.equal(await page.locator('#lQ').inputValue(), '');
    } finally { await context.close(); }
  });

  await t.test('rapid Back cancels stale search, IME commits only finished text, and malformed fragments stay usable', async () => {
    const { page, context, errors } = await open('/#/records');
    try {
      await page.locator('#v-records a[href^="#/list"]').click();
      const query = page.locator('#lQ');
      await query.waitFor();
      await page.evaluate(() => {
        const input = document.getElementById('lQ');
        input.value = 'nonnavigational-draft';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        history.back();
      });
      await page.locator('#v-records h1').waitFor();
      await afterDebounce(page);
      assert.equal(hash(page), '#/records');
      assert.equal(await page.evaluate(() => document.activeElement.closest('.view').id), 'v-records');
      await page.evaluate(() => history.forward());
      await query.waitFor();
      assert.equal(await query.inputValue(), '');
      await query.evaluate(el => {
        el.value = '中';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
      });
      await afterDebounce(page);
      assert.doesNotMatch(hash(page), /[?&]q=/);
      await query.evaluate(el => {
        el.value = '中文';
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
      });
      await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('q') === '中文');
      await page.evaluate(() => location.hash = '#/toString/%E0%A4%A');
      await page.locator('#v-home .home-platforms').waitFor();
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await t.test('success, rejection and overlapping clipboard attempts keep the original button label', async () => {
    const { page, context, errors } = await open('/?lang=en#/compare', { init: () => {
      window.writes = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: value => new Promise((resolve, reject) => window.writes.push({value, resolve, reject})),
      } });
    } });
    try {
      const copy = page.locator('#cShare');
      await copy.waitFor();
      const original = await copy.innerHTML();
      await copy.click();
      await page.evaluate(() => writes[0].resolve());
      await page.waitForFunction(() => document.getElementById('cShare').textContent.includes('Copied'));
      await copy.click();
      await copy.click();
      await page.evaluate(() => { writes[2].reject(Error('denied')); writes[1].resolve(); });
      await page.waitForFunction(() => document.getElementById('cShare').textContent === 'Copy failed');
      await page.waitForFunction(markup => document.getElementById('cShare').innerHTML === markup, original);
      const written = await page.evaluate(() => writes.map(row => row.value));
      assert.equal(written.length, 3);
      assert.ok(written.every(value => value.includes('#/compare')));
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await t.test('global navigation stays at the top while desktop and mobile pages scroll', async () => {
    for (const width of [1440, 390]) {
      const { page, context, errors } = await open('/', { context: { viewport: { width, height: 840 }, hasTouch: width < 500, isMobile: width < 500 } });
      try {
        await page.locator('.home-platforms').waitFor();
        const header = page.locator('header.site');
        const start = await header.boundingBox();
        await page.evaluate(() => window.scrollTo({ top: 620, behavior: 'instant' }));
        assert.ok(await page.evaluate(() => window.scrollY >= 500));
        assert.ok(Math.abs((await header.boundingBox()).y - start.y) <= 1);
        await page.locator('#nav [data-route="how"]').click();
        await page.locator('#nav [data-route="how"][aria-current="page"]').waitFor();
        await page.evaluate(() => window.scrollTo({ top: 620, behavior: 'instant' }));
        assert.ok(await page.evaluate(() => window.scrollY >= 500));
        assert.ok(Math.abs((await header.boundingBox()).y - start.y) <= 1);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  });

  await t.test('changing routes on a narrow touch screen keeps the active navigation item in view', async () => {
    const { page, context, errors } = await open('/', { context: { viewport: { width: 320, height: 840 }, hasTouch: true, isMobile: true } });
    try {
      await page.locator('.home-platforms').waitFor();
      await page.evaluate(() => location.hash = '#/upstream');
      await page.locator('#uCards [data-up-id]').first().waitFor();
      assert.equal(await page.evaluate(() => {
        const nav = document.getElementById('nav'), active = nav.querySelector('[aria-current]');
        if (!active) return false;
        const rail = nav.getBoundingClientRect(), item = active.getBoundingClientRect();
        return item.left >= rail.left - 1 && item.right <= rail.right + 1;
      }), true);
      await page.locator('#uCards [data-up-id]').first().tap();
      await page.waitForFunction(() => !document.getElementById('drawer').inert);
      await page.locator('#dwClose').tap();
      await page.waitForFunction(() => document.getElementById('drawer').inert);
      assert.equal(hash(page), '#/upstream');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await t.test('existing glossary terms stay open on first tap and can be dismissed with Escape', async () => {
    const { page, context, errors } = await open('/#/overview', { context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } });
    try {
      const host = page.locator('#v-overview .term').first();
      await host.waitFor();
      await host.tap();
      await page.waitForFunction(() => document.getElementById('tip').classList.contains('on'));
      assert.equal(await host.getAttribute('aria-describedby'), 'tip');
      await host.tap();
      await page.waitForFunction(() => !document.getElementById('tip').classList.contains('on'));
      await host.focus();
      await page.keyboard.press('Space');
      await page.waitForFunction(() => document.getElementById('tip').classList.contains('on'));
      await page.keyboard.press('Escape');
      assert.equal(await host.getAttribute('aria-describedby'), null);
      assert.equal(await host.evaluate(el => el === document.activeElement), true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await t.test('manual animation steps stay selected; replay and offscreen pause work', async () => {
    const { page, context, errors } = await open('/');
    try {
      const flow = page.locator('#dmFlow');
      await flow.waitFor();
      const status = () => page.evaluate(() => window.NF_SCENES.flow.state());
      assert.equal((await status()).playing, false, 'reduced-motion default stays unchanged');
      await flow.locator('.dm-replay').click();
      await page.waitForFunction(() => window.NF_SCENES.flow.state().time > .08);
      const step = flow.locator('.dm-steps button').nth(2);
      await step.focus();
      await page.keyboard.press('Enter');
      assert.equal(await step.getAttribute('aria-current'), 'step');
      const stopped = await status();
      assert.equal(stopped.playing, false);
      await afterDebounce(page);
      assert.equal((await status()).time, stopped.time);
      await flow.locator('.dm-play').click();
      await page.waitForFunction(t => window.NF_SCENES.flow.state().time > t + .06, stopped.time);
      await page.evaluate(() => location.hash = '#/how');
      await page.waitForFunction(() => !window.NF_SCENES.flow.state().visible);
      const left = (await status()).time;
      await afterDebounce(page);
      assert.equal((await status()).time, left);
      const outline = page.locator('#v-how [data-go="compare"]');
      await outline.focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement.closest('section').id), 'how-compare');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await t.test('an initial data failure can retry once without reloading the page', async () => {
    let count = 0;
    const { page, context, errors } = await open('/?lang=en#/compare', { intercept: (route, url) => {
      if (url.pathname === '/data/evaluations.json' && ++count === 1) return route.fulfill({ status: 503, body: '{}' });
      return undefined;
    } });
    try {
      const retry = page.locator('#boot button');
      await retry.waitFor();
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      await retry.focus();
      await page.keyboard.press('Enter');
      await page.locator('#cTbl table').waitFor();
      assert.equal(count, 2);
      assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);
      assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Hardware Comparison');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
});
