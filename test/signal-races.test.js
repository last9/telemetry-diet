import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeElement({ id = '', provider, signal } = {}) {
  const listeners = new Map();
  const descendants = {
    strong: { textContent: provider ? `Log in with ${provider}` : '' },
    small: { textContent: '' },
  };
  return {
    id,
    dataset: {
      ...(provider ? { provider: provider.toLowerCase() } : {}),
      ...(signal ? { signal } : {}),
    },
    value: id === 'window-select' ? '6' : '',
    options: [],
    hidden: id === 'workbench-view',
    disabled: false,
    className: '',
    textContent: '',
    style: {},
    classList: { toggle() {} },
    addEventListener(name, listener) { listeners.set(name, listener); },
    append() {},
    click() { return listeners.get('click')?.(); },
    getBoundingClientRect() { return { top: 0, bottom: 20 }; },
    querySelector(selector) { return descendants[selector] || fakeElement(); },
    removeAttribute() {},
    replaceChildren() {},
    scrollIntoView() {},
    setAttribute() {},
  };
}

async function createHarness() {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const elements = new Map();
  const sourceButtons = ['sample', 'datadog', 'last9'].map((provider) => fakeElement({ provider }));
  const signalButtons = ['logs', 'traces', 'metrics'].map((signal) => fakeElement({ signal }));
  const historyCalls = [];
  const requests = [];
  const pending = new Map();
  const timeouts = new Map();
  let nextTimer = 0;
  const location = {
    origin: 'http://127.0.0.1:4571',
    pathname: '/',
    search: '',
  };
  const element = (selector) => {
    const provider = selector.match(/^\.source-button\[data-provider="([^"]+)"\]$/)?.[1];
    if (provider) return sourceButtons.find((button) => button.dataset.provider === provider);
    if (!elements.has(selector)) elements.set(selector, fakeElement({ id: selector.startsWith('#') ? selector.slice(1) : '' }));
    return elements.get(selector);
  };
  const respond = (path, value) => {
    const request = pending.get(path)?.shift();
    assert.ok(request, `expected a pending ${path} request`);
    request.resolve({ ok: true, json: async () => value });
  };
  const context = vm.createContext({
    Blob,
    URL,
    URLSearchParams,
    Intl,
    console,
    document: {
      title: '',
      createElement: () => fakeElement(),
      querySelector: element,
      querySelectorAll: (selector) => {
        if (selector === '.source-button') return sourceButtons;
        if (selector === '[data-signal]') return signalButtons;
        return [];
      },
    },
    fetch: async (path, options = {}) => {
      requests.push({ path, options });
      if (path === '/api/config') {
        return {
          ok: true,
          json: async () => ({ providers: { datadog: { configured: false }, last9: { configured: false } } }),
        };
      }
      const request = deferred();
      if (!pending.has(path)) pending.set(path, []);
      pending.get(path).push(request);
      return request.promise;
    },
    navigator: { clipboard: { writeText: async () => {} } },
    setInterval: () => ++nextTimer,
    clearInterval() {},
    setTimeout(callback) {
      const id = ++nextTimer;
      timeouts.set(id, callback);
      return id;
    },
    clearTimeout(id) { timeouts.delete(id); },
    window: {
      addEventListener() {},
      history: {
        pushState(_state, _title, path) { historyCalls.push(path); },
        replaceState(_state, _title, path) { historyCalls.push(path); },
      },
      innerHeight: 800,
      location,
      open() { return null; },
      requestAnimationFrame(callback) { callback(); },
    },
  });

  vm.runInContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  return { context, element, historyCalls, location, pending, requests, respond, timeouts };
}

test('analyze ignores a completion after the selected signal changes', async () => {
  const harness = await createHarness();
  vm.runInContext("state.provider = 'sample'; state.signal = 'logs'", harness.context);
  const analysis = vm.runInContext('analyze()', harness.context);
  await new Promise((resolve) => setImmediate(resolve));

  vm.runInContext("selectSignal('metrics')", harness.context);
  harness.respond('/api/analyze', {
    analysisId: 'old-log-analysis',
    analysisType: 'logs',
    summary: { service: 'api', timeWindow: { start: new Date(0).toISOString(), end: new Date(1).toISOString() }, recordsAnalyzed: 0 },
    findings: [],
    artifacts: { selectedIds: [], preview: { recordsAnalyzed: 0, recordsAfter: 0, directionalReductionPercent: 0, caveat: '' }, otel: '', last9: {}, markdown: '' },
  });
  await analysis;

  assert.equal(vm.runInContext('state.signal', harness.context), 'metrics');
  assert.equal(vm.runInContext('state.analysisId', harness.context), null);
  assert.equal(harness.historyCalls.some((path) => path.includes('/results/old-log-analysis')), false);
  const payload = JSON.parse(harness.requests.find(({ path }) => path === '/api/analyze').options.body);
  assert.equal(payload.signal, 'logs');
});

test('an older route restore cannot overwrite a newer result route', async () => {
  const harness = await createHarness();
  vm.runInContext("state.provider = 'sample'", harness.context);
  harness.element('#workbench-view').hidden = false;
  harness.location.pathname = '/results/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  harness.location.search = '?provider=sample&signal=logs';
  const first = vm.runInContext('restoreRoute()', harness.context);
  await new Promise((resolve) => setImmediate(resolve));

  harness.location.pathname = '/results/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  harness.location.search = '?provider=sample&signal=metrics';
  const second = vm.runInContext('restoreRoute()', harness.context);
  await new Promise((resolve) => setImmediate(resolve));
  harness.respond('/api/analysis/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', {
    analysisId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    analysisType: 'metrics',
    result: { summary: {}, metrics: [], limitations: [] },
    artifacts: { markdown: '', json: {} },
  });
  await second;
  harness.respond('/api/analysis/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', {
    analysisId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    analysisType: 'logs',
    summary: { service: 'stale', timeWindow: { start: new Date(0).toISOString(), end: new Date(1).toISOString() }, recordsAnalyzed: 0 },
    findings: [],
    artifacts: { selectedIds: [], preview: { recordsAnalyzed: 0, recordsAfter: 0, directionalReductionPercent: 0, caveat: '' }, otel: '', last9: {}, markdown: '' },
  });
  await first;

  assert.equal(vm.runInContext('state.analysisId', harness.context), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert.equal(vm.runInContext('state.signal', harness.context), 'metrics');
});

test('switching signals cancels pending log draft regeneration', async () => {
  const harness = await createHarness();
  vm.runInContext("state.provider = 'sample'; state.signal = 'logs'; state.analysisId = 'log-analysis'; regenerate()", harness.context);
  assert.equal(harness.timeouts.size, 1);

  vm.runInContext("selectSignal('traces')", harness.context);
  assert.equal(harness.timeouts.size, 0);
  assert.equal(harness.requests.some(({ path }) => path === '/api/generate'), false);
});
