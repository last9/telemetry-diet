import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Drives web/app.js in a fake DOM with controllable fetch + timers so we can
// force out-of-order /api/generate responses, cancel mid-flight, and fail a
// generation — verifying the regeneration token and draft-busy guards.

const analysisId = 'a1b2c3';

function analysisData(selectedIds) {
  return {
    analysisType: 'logs',
    analysisId,
    summary: { service: 'checkout-api', environment: 'production', recordsAnalyzed: 1000, timeWindow: { start: '2026-07-15T00:00:00Z', end: '2026-07-15T06:00:00Z' } },
    findings: [
      { id: 'f1', category: 'risk', action: 'redact', title: 'Redact f1', confidence: 'high', affectedCount: 10, examplesRedacted: ['a***'], suggestedAction: 'redact f1', warning: '' },
      { id: 'f2', category: 'noise', action: 'drop', title: 'Drop f2', confidence: 'high', affectedCount: 20, examplesRedacted: ['GET /x 200'], suggestedAction: 'drop f2', warning: '' },
    ],
    artifacts: { selectedIds, preview: { directionalReductionPercent: 5, recordsAffected: 50, redactedFields: [], caveat: 'cav', recordsAnalyzed: 1000, recordsAfter: 950 }, otel: 'OTEL0', last9: {}, markdown: 'MD0' },
  };
}

function makeEl(tag = '') {
  const listeners = {};
  const attributes = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    dataset: {}, className: '', id: '', textContent: '', value: '', title: '',
    hidden: false, disabled: false, open: false, options: [], style: {},
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); },
      contains(c) { return this.set.has(c); },
      toggle(c, force) { const on = force === undefined ? !this.set.has(c) : force; on ? this.set.add(c) : this.set.delete(c); return on; },
    },
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    dispatch(type) { (listeners[type] || []).forEach((fn) => fn({ stopPropagation() {}, preventDefault() {} })); },
    append() {}, replaceChildren() {},
    removeAttribute(name) { attributes.delete(name); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name); },
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, bottom: 0 }; }, scrollIntoView() {}, focus() {},
    close() { this.open = false; }, showModal() { this.open = true; },
  };
  return el;
}

function setup(selectedIds) {
  const registry = [];
  const els = new Map();
  const generateQueue = [];
  const timers = new Map();
  const storage = new Map();
  let timerSeq = 0;
  const resp = (value) => ({ ok: true, json: async () => value });

  const sourceButtons = ['sample', 'datadog', 'last9'].map((p) => Object.assign(makeEl('button'), { dataset: { provider: p } }));
  const signalButtons = ['logs', 'traces', 'metrics'].map((s) => Object.assign(makeEl('button'), { dataset: { signal: s } }));

  const query = (selector) => {
    const provider = selector.match(/^\.source-button\[data-provider="([^"]+)"\]$/)?.[1];
    if (provider) return sourceButtons.find((b) => b.dataset.provider === provider);
    if (!els.has(selector)) els.set(selector, makeEl());
    return els.get(selector);
  };
  const queryAll = (selector) => {
    if (selector === '.source-button') return sourceButtons;
    if (selector === '[data-signal]') return signalButtons;
    return [];
  };

  const location = { origin: 'http://127.0.0.1:4545', pathname: `/results/${analysisId}`, search: '?provider=sample&signal=logs&service=checkout-api&environment=production&window=6' };

  const context = vm.createContext({
    Blob, URL, URLSearchParams, Intl, Date, Promise, JSON, Set, Math, console,
    setTimeout: (fn) => { const id = ++timerSeq; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0, clearInterval() {},
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    document: {
      title: '',
      createElement: (tag) => { const el = makeEl(tag); registry.push(el); return el; },
      createTextNode: (text) => ({ nodeType: 3, textContent: text }),
      querySelector: query,
      querySelectorAll: queryAll,
    },
    fetch: async (path, opts) => {
      if (path === '/api/config') return resp({ providers: { datadog: { configured: true, mode: 'hosted-oauth' }, last9: { configured: true, mode: 'hosted-oauth' } } });
      if (path === '/api/connect') return resp({ services: ['checkout-api'], environments: ['production'], connection: { serverInfo: { name: 'Sample' }, tools: ['t'] } });
      if (path === '/api/environments') return resp({ environments: ['production'] });
      if (path.startsWith('/api/analysis/')) return resp(analysisData(selectedIds));
      if (path === '/api/generate') {
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        generateQueue.push({ body: JSON.parse(opts.body), resolve: (v) => resolve(resp(v)), reject: (e) => reject(e) });
        return promise;
      }
      return resp({});
    },
    window: {
      addEventListener() {}, requestAnimationFrame() {}, open() { return null; },
      history: { pushState() {}, replaceState() {} },
      location,
    },
  });

  return { context, registry, els, generateQueue, timers, sourceButtons, signalButtons, query };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const flushTimers = (h) => { const fns = [...h.timers.values()]; h.timers.clear(); fns.forEach((fn) => fn()); };
const includeButtons = (h) => h.registry.filter((el) => el.tagName === 'BUTTON' && typeof el.className === 'string' && el.className.split(' ').includes('inc'));

async function boot(selectedIds) {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const h = setup(selectedIds);
  vm.runInContext(source, h.context);
  for (let i = 0; i < 25; i += 1) await tick(); // config → connect → analysis → renderAnalysis
  return h;
}

test('newest selection wins when /api/generate responses arrive out of order', async () => {
  const h = await boot([]); // nothing selected → both rows show "+ Add"
  const [incF1, incF2] = includeButtons(h);
  assert.ok(incF1 && incF2, 'both include buttons rendered');

  incF1.dispatch('click'); flushTimers(h); await tick(); // generate #1: [f1]
  incF2.dispatch('click'); flushTimers(h); await tick(); // generate #2: [f1, f2]
  assert.equal(h.generateQueue.length, 2);
  assert.deepEqual(h.generateQueue[0].body.selectedIds, ['f1']);
  assert.deepEqual(h.generateQueue[1].body.selectedIds, ['f1', 'f2']);

  h.generateQueue[1].resolve({ artifacts: { ...analysisData([]).artifacts, otel: 'GEN2' } }); await tick();
  assert.equal(h.query('#output-code').textContent, 'GEN2', 'newest response committed');

  h.generateQueue[0].resolve({ artifacts: { ...analysisData([]).artifacts, otel: 'GEN1' } }); await tick();
  assert.equal(h.query('#output-code').textContent, 'GEN2', 'stale older response must not overwrite');
});

test('switching signal mid-generation cancels it and leaves the stale log draft unavailable', async () => {
  const h = await boot(['f1']);
  const [incF1] = includeButtons(h);

  incF1.dispatch('click'); flushTimers(h); await tick(); // toggle f1 off → generate in flight
  assert.equal(h.generateQueue.length, 1);
  assert.equal(h.query('#download-output').disabled, true, 'Download disabled while pending');

  h.signalButtons[1].dispatch('click'); // navigate to traces → cancelRegeneration
  assert.equal(h.query('#download-output').disabled, true, 'old log Download stays unavailable after navigation');

  h.generateQueue[0].resolve({ artifacts: { ...analysisData([]).artifacts, otel: 'GEN_LATE' } }); await tick();
  assert.equal(h.query('#output-code').textContent, 'OTEL0', 'cancelled generation must not commit');
});

test('a failed generation rolls the selection back to the committed artifacts', async () => {
  const h = await boot(['f1']); // f1 starts in config
  const [incF1] = includeButtons(h);

  incF1.dispatch('click'); flushTimers(h); await tick(); // remove f1 → generate in flight
  assert.deepEqual(h.generateQueue[0].body.selectedIds, []);

  h.generateQueue[0].reject(new Error('generate boom')); await tick();

  assert.equal(h.query('#toast').textContent, 'generate boom', 'error surfaced');
  assert.equal(h.query('#copy-output').disabled, false, 'Copy re-enabled and selection non-empty after rollback');
  const restored = includeButtons(h).some((b) => b.textContent === '✓ In config');
  assert.ok(restored, 'row re-rendered with the rolled-back selection');
});

test('all draft actions stay disabled through regeneration and baseline edits', async () => {
  const h = await boot(['f1']);
  const [, incF2] = includeButtons(h);
  const actionSelectors = ['#copy-output', '#download-output', '#toggle-config', '#modal-copy', '#modal-download'];

  incF2.dispatch('click');
  actionSelectors.forEach((selector) => assert.equal(h.query(selector).disabled, true, `${selector} disabled while pending`));

  h.query('#cost-gb').value = '0';
  h.query('#cost-gb').dispatch('input');
  actionSelectors.forEach((selector) => assert.equal(h.query(selector).disabled, true, `${selector} stays disabled after baseline render`));

  flushTimers(h); await tick();
  h.generateQueue[0].resolve({ artifacts: { ...analysisData(['f1', 'f2']).artifacts, otel: 'GEN' } }); await tick();
  actionSelectors.forEach((selector) => assert.equal(h.query(selector).disabled, false, `${selector} re-enabled for committed draft`));
});

test('zero baseline values are honored instead of replaced by defaults', async () => {
  const h = await boot(['f1']);

  h.query('#cost-gb').value = '0';
  h.query('#cost-gb').dispatch('input');
  assert.equal(h.query('#savings-cost').textContent, '≈$0');

  h.query('#ingest-gb').value = '0';
  h.query('#ingest-gb').dispatch('input');
  assert.equal(h.query('#savings-data').textContent, '—');
  assert.equal(h.query('#savings-cost').textContent, '—');
});

test('a limited zero-finding analysis stays neutral and keeps its report exportable', async () => {
  const h = await boot(['f1']);
  const empty = {
    ...analysisData([]),
    findings: [],
    summary: {
      ...analysisData([]).summary,
      recordsAnalyzed: 25,
      limitations: ['Provider marked this aggregate as partial.'],
    },
    artifacts: { ...analysisData([]).artifacts, selectedIds: [], markdown: 'EMPTY REPORT' },
  };

  vm.runInContext(`renderAnalysis(${JSON.stringify(empty)})`, h.context);

  assert.equal(h.query('#analysis-empty').hidden, false);
  assert.equal(h.query('#analysis-empty-title').textContent, 'No changes proposed');
  assert.match(h.query('#analysis-empty-copy').textContent, /coverage was limited/);
  assert.equal(h.query('#log-limitations').hidden, false);
  assert.equal(h.query('#output-code').textContent, 'EMPTY REPORT');
  assert.equal(h.query('#analysis-empty-report').disabled, false);
  assert.equal(h.query('#modal-copy').disabled, false, 'the generated Markdown report remains exportable');
});
