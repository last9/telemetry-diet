import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

function fakeElement({ id = '', provider } = {}) {
  const descendants = {
    strong: { textContent: provider ? `Log in with ${provider}` : '' },
    small: { textContent: '' },
  };
  return {
    id,
    dataset: provider ? { provider: provider.toLowerCase() } : {},
    value: id === 'window-select' ? '6' : '',
    options: [],
    hidden: id === 'workbench-view',
    className: '',
    textContent: '',
    classList: { toggle() {} },
    addEventListener() {},
    append() {},
    querySelector(selector) { return descendants[selector] || fakeElement(); },
    removeAttribute() {},
    replaceChildren() {},
    setAttribute() {},
  };
}

test('refresh preserves a provider route when OAuth must be resumed interactively', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const historyCalls = [];
  const openCalls = [];
  const fetchCalls = [];
  const elements = new Map();
  const sourceButtons = ['sample', 'datadog', 'last9'].map((provider) => fakeElement({ provider }));
  const element = (selector) => {
    const provider = selector.match(/^\.source-button\[data-provider="([^"]+)"\]$/)?.[1];
    if (provider) return sourceButtons.find((button) => button.dataset.provider === provider);
    if (!elements.has(selector)) elements.set(selector, fakeElement({ id: selector.startsWith('#') ? selector.slice(1) : '' }));
    return elements.get(selector);
  };
  const location = {
    origin: 'http://127.0.0.1:4571',
    pathname: '/workbench',
    search: '?provider=last9&service=checkout&environment=*&window=6',
  };
  const context = vm.createContext({
    Blob,
    URL,
    URLSearchParams,
    Intl,
    clearTimeout() {},
    console,
    document: {
      title: '',
      createElement: () => fakeElement(),
      querySelector: element,
      querySelectorAll: (selector) => selector === '.source-button' ? sourceButtons : [],
    },
    fetch: async (path) => {
      fetchCalls.push(path);
      const value = path === '/api/config'
        ? { providers: { datadog: { configured: true, mode: 'hosted-oauth' }, last9: { configured: true, mode: 'hosted-oauth' } } }
        : { authorizationRequired: true, authorizationUrl: 'https://app.last9.io/oauth' };
      return { ok: true, json: async () => value };
    },
    navigator: { clipboard: { writeText: async () => {} } },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    window: {
      addEventListener() {},
      history: {
        pushState(...args) { historyCalls.push(['push', ...args]); },
        replaceState(...args) { historyCalls.push(['replace', ...args]); },
      },
      location,
      open(...args) { openCalls.push(args); return null; },
    },
  });

  vm.runInContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(fetchCalls.includes('/api/connect'));
  assert.deepEqual(openCalls, []);
  assert.deepEqual(historyCalls, []);
  assert.equal(location.pathname, '/workbench');
  assert.equal(location.search, '?provider=last9&service=checkout&environment=*&window=6');
});
