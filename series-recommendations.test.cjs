'use strict';

// Opt in with NUMERICBRIDGE_PREVIEW_URL and a local Chromium/Playwright install.
const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');

const preview = process.env.NUMERICBRIDGE_PREVIEW_URL;
const primary = '#v-cases .lc-selectors';
const modelChoices = primary + ' [data-choices="model"]';
const modelMore = '[data-selector-more="model"]';
const modelOptions = '.lc-option-dialog[open]';
const recommendation = '.lc-recommendation';
const empty = '.lc-module-empty';
const detail = '.lc-case-dialog[open]';
const checkpoint = 'Qwen3.5-9B-Base';
const supportedCase = 'case-qwen35-weighted-lora-bias';
const supported = { hardware: 'NVIDIA H200', library: 'PEFT', task: 'inference' };
const moeCase = 'case-qwen36-35b-a3b-vllm-b200-910c-20261123';
const issueCase = 'case-mindspeed-zero-centered-rmsnorm';
const issueId = 'issue-mindspeed-residual-peer-differences';
const seriesButton = series => '[data-model-series="' + series + '"]';

function hash(page) {
  return new URL(page.url()).hash;
}

function params(page) {
  return new URLSearchParams(hash(page).split('?')[1]);
}

async function visitCases(page, query, caseId = '') {
  const route = '#/cases' + (caseId ? '/' + caseId : '') + '?' + new URLSearchParams(query);
  await page.goto(new URL(route, preview).href, { waitUntil: 'domcontentloaded' });
  await page.locator(primary).waitFor();
}

async function findSeries(page, series) {
  const inline = page.locator(modelChoices).locator(seriesButton(series));
  if (await inline.isVisible()) return inline;
  const options = page.locator(modelOptions);
  await page.locator(modelMore).click();
  await options.locator('[data-options-search]').fill(series);
  return options.locator(seriesButton(series));
}

async function assertNoHorizontalOverflow(page, locator) {
  const { left, right, width, scrollWidth } = await locator.evaluate(element => {
    const { left, right } = element.getBoundingClientRect();
    return { left, right, width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth };
  });
  assert.ok(left >= -1 && right <= width + 1, 'recommendation fits within the viewport');
  assert.ok(scrollWidth <= width + 1, 'page does not scroll horizontally');
}

describe('model series recommendations', { skip: !preview && 'Set NUMERICBRIDGE_PREVIEW_URL for local browser coverage' }, () => {
  let browser;
  before(async () => {
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(preview).hostname), 'Use a loopback preview');
    const { chromium } = require(process.env.NUMERICBRIDGE_PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ executablePath: process.env.NUMERICBRIDGE_CHROME, timeout: 10000 });
  });
  after(async () => browser?.close());

  async function pageFor(t, mobile = false) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block'
    });
    const origin = new URL(preview).origin;
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      return request.method() === 'GET' && url.origin === origin && !url.pathname.startsWith('/v1/')
        ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => {
      await context.close();
      assert.deepEqual(errors, []);
    });
    return page;
  }

  for (const [viewport, mobile] of [['desktop', false], ['mobile', true]]) {
    test(viewport + ': choose Qwen series without size, then show a scoped Dense recommendation', async t => {
      const page = await pageFor(t, mobile);
      await visitCases(page, supported);
      const results = page.locator(recommendation);
      assert.equal(await results.locator('[data-architecture]').count(), 0);
      assert.equal(await page.locator(primary + ' [data-choices="model_size"]').count(), 0);
      const inlineChoices = await page.locator(modelChoices + ' [data-value]:not([data-value=""])').evaluateAll(buttons =>
        buttons.map(button => [button.dataset.modelSeries, button.textContent.trim()])
      );
      assert.ok(inlineChoices.length > 0);
      for (const [series, label] of inlineChoices) {
        assert.ok(series, 'nonempty primary model choices represent series, not checkpoints');
        assert.equal(label, series);
        assert.doesNotMatch(label, /(?:\d+(?:\.\d+)?\s*[bBmM]\b|\bDense\b|\bMoE\b)/);
      }

      for (const series of ['Qwen3', 'Qwen3.6', 'Qwen3.5']) {
        const choice = await findSeries(page, series);
        await choice.waitFor({ state: 'visible' });
        assert.equal((await choice.textContent()).trim(), series);
        if (mobile) await choice.tap();
        else await choice.press('Enter');
        await page.waitForFunction(value => new URLSearchParams(location.hash.split('?')[1]).get('series') === value, series);
        assert.equal(params(page).has('model'), false);
        assert.equal(params(page).has('model_size'), false);
      }

      const dense = results.locator('[data-architecture="Dense"]');
      const card = dense.locator('[data-checkpoint="' + checkpoint + '"][data-framework-version="0.20.0"]');
      await card.waitFor();
      assert.equal(await results.locator('[data-architecture="MoE"]').count(), 0);
      assert.equal(await card.locator('details').count(), 0);
      const summary = await card.innerText();
      assert.equal(await card.locator('..').locator('..').getByRole('heading').textContent(), checkpoint);
      for (const value of [/H200/, /PEFT.*0\.20\.0/, /偏置|bias/i]) assert.match(summary, value);
      assert.doesNotMatch(summary, /68c46c4b3498877f3ef123c856ecfde50c39f404/);
      if (mobile) await assertNoHorizontalOverflow(page, card);
      const trigger = card.getByRole('button',{name:/查看配置|View settings/});
      assert.doesNotMatch(summary, /推理|Inference/);
      const before = page.url();
      await trigger.click();
      const drawer = page.locator('.lc-evidence-drawer[open]');
      await drawer.waitFor();
      assert.equal(page.url(), before);
      assert.match(await drawer.innerText(), /68c46c4b3498877f3ef123c856ecfde50c39f404/);
      assert.equal(await drawer.getByRole('link').count(), 0);
      if (mobile) await drawer.locator('[data-evidence-close]').tap();
      else await page.keyboard.press('Escape');
      await drawer.waitFor({state:'hidden'});
      await page.waitForFunction(() => document.activeElement?.hasAttribute('data-evidence-preview'));
      assert.equal(page.url(), before);

      await visitCases(page,{series:'Qwen3',library:'vLLM',task:'inference'});
      const group=results.locator('.lc-scoped-recommendation').filter({has:page.getByRole('heading',{name:'Qwen/Qwen3-1.7B',exact:true})});
      await group.waitFor();
      assert.equal(await group.getByRole('heading').count(),1);
      if(mobile)await assertNoHorizontalOverflow(page,group);
      for(const [version,hardware,tp,other] of [['0.18.0+empty','Ascend 910C',4,'NVIDIA B20Z'],['0.24.0','NVIDIA B20Z',2,'Ascend 910C']]){
        const row=group.locator('[data-framework-version="'+version+'"]');
        assert.equal(await row.count(),1);
        assert.ok((await row.innerText()).includes(hardware));
        assert.ok((await row.innerText()).includes(version));
        const deps=await row.locator('.lc-scoped-dependencies li').allTextContents();
        if(tp===4){
          for(const dep of ['torch 2.9.0','torch-npu 2.9.0.post2','vllm-ascend 0.0.0','CANN 9.1.0','transformers 5.3.0'])assert.ok(deps.includes(dep),dep);
          assert.ok(!deps.includes('torch 2.11.0'));
        }else{
          assert.ok(deps.includes('torch 2.11.0'));
          assert.ok(deps.includes('transformers 5.9.0'));
          assert.ok(!deps.some(dep=>/torch-npu|CANN|vllm-ascend/i.test(dep)));
        }
        assert.ok(!deps.some(dep=>dep.toLowerCase()==='vllm '+version));
        await row.getByRole('button',{name:/查看配置|View settings/}).click();
        await drawer.waitFor();
        const settings=await drawer.innerText();
        assert.ok(settings.includes(hardware));
        assert.ok(!settings.includes(other));
        assert.match(settings,new RegExp('tensor_parallel\\s*'+tp));
        await drawer.locator('[data-evidence-close]').click();
        await drawer.waitFor({state:'hidden'});
      }
    });
  }

  test('unsupported MoE evidence, off-series records and mismatched versions cannot become recommendations', async t => {
    const page = await pageFor(t);
    const results = page.locator(recommendation);
    await visitCases(page, { series: 'Qwen3.6', hardware: 'Ascend 910C', library: 'vLLM', task: 'inference' });
    const moe = results.locator('[data-architecture="MoE"]');
    await moe.locator(empty).waitFor();
    assert.match(await moe.locator(empty).textContent(), /暂无已验证配置|No verified configuration yet/);
    assert.equal(await results.locator('[data-architecture="Dense"], [data-checkpoint], a').count(), 0);
    await page.locator('[data-model-records] a[href^="#/report/' + moeCase + '?"]').first().waitFor();

    // The catalog has a Qwen3.8 checkpoint stored under a legacy Qwen3.5 Dense group.
    // Its passing B200/vLLM evidence must not surface for the Qwen3.5 series.
    await visitCases(page, { series: 'Qwen3.5', hardware: 'NVIDIA B200', library: 'vLLM', task: 'inference' });
    await results.locator(empty).first().waitFor();
    assert.equal(await results.locator('[data-checkpoint], a').count(), 0);
    assert.doesNotMatch(await page.locator('[data-model-records]').innerText(), /Qwen3\.8/);

    await visitCases(page, { series: 'Qwen3.8', hardware: 'NVIDIA B200', library: 'vLLM', task: 'inference' });
    await results.locator('[data-checkpoint="Qwen/Qwen3.8-27B"]').first().waitFor();

    await visitCases(page, {series:'Qwen3', hardware:'Ascend 910C', library:'vLLM', task:'inference'});
    const clean = results.locator('[data-checkpoint="Qwen/Qwen3-1.7B"]').first();
    await clean.waitFor();
    assert.equal(await clean.locator('.lc-scoped-adaptation').count(), 0);
    assert.equal(await clean.locator('details').count(), 0);
    assert.doesNotMatch(await clean.innerText(), /TP 4|prefill_budget_tokens/);
    await clean.getByRole('button',{name:/查看配置|View settings/}).click();
    const drawer = page.locator('.lc-evidence-drawer[open]');
    await drawer.waitFor();
    const settings = await drawer.innerText();
    assert.match(settings, /tensor_parallel\s*4/);
    assert.match(settings, /prefill_budget_tokens/);
    assert.match(settings, /torch-npu\s*2\.9\.0\.post2/);
    assert.match(settings, /CANN\s*9\.1\.0/);
    assert.doesNotMatch(settings, /B20Z/);

    await visitCases(page, { ...supported, series: 'Qwen3.5', version: '0.0.0', alternatives: '1' });
    assert.match(await results.locator(empty).first().textContent(), /暂无已验证配置|No verified configuration yet/);
    assert.equal(await results.locator('[data-checkpoint], [data-show-alternatives], a').count(), 0);
  });

  test('legacy exact-model, case and issue hashes keep their original meanings', async t => {
    const page = await pageFor(t);
    await visitCases(page, { ...supported, model: checkpoint });
    const exact = page.locator(recommendation + ' .lc-recommend-config');
    await exact.first().waitFor();
    assert.match(await exact.first().innerText(), /Qwen3\.5-9B-Base/);
    assert.equal(params(page).get('model'), checkpoint);
    assert.equal(params(page).has('series'), false);
    assert.equal(await page.locator(recommendation + ' [data-architecture]').count(), 0);

    await visitCases(page, { ...supported, model: checkpoint }, supportedCase);
    await page.locator(detail + ' #lc-case-title').waitFor();
    assert.ok(hash(page).startsWith('#/cases/' + supportedCase + '?'));
    assert.equal(params(page).get('model'), checkpoint);
    await page.keyboard.press('Escape');
    await page.locator(detail).waitFor({ state: 'detached' });
    await page.waitForFunction(() => location.hash.startsWith('#/cases?'));
    assert.equal(params(page).get('model'), checkpoint);

    await visitCases(page, { hardware: 'Ascend 910C', model: checkpoint, library: 'MindSpeed', task: 'rl', issue: issueId }, issueCase);
    await page.locator(detail + ' #lc-case-title').waitFor();
    assert.ok(hash(page).startsWith('#/cases/' + issueCase + '?'));
    assert.equal(params(page).get('issue'), issueId);
    assert.equal(params(page).get('model'), checkpoint);
    assert.equal(params(page).has('series'), false);
    assert.equal(await page.locator('.lc-related [data-issue="' + issueId + '"]').getAttribute('aria-expanded'), 'true');
  });
});
