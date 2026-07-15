const state = {
  provider: null,
  analysisId: null,
  findings: [],
  artifacts: null,
  output: 'otel',
  config: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const labels = { sample: 'Sample MCP', datadog: 'Datadog MCP', last9: 'Last9 MCP' };
const categorySymbols = { risk: '!', noise: '↓', cardinality: '#', drift: '↔' };
const outputMeta = {
  otel: { filename: 'telemetry-diet-collector.yaml', type: 'text/yaml' },
  last9: { filename: 'telemetry-diet-last9-draft.json', type: 'application/json' },
  markdown: { filename: 'telemetry-diet-report.md', type: 'text/markdown' },
};

function routeParams() {
  return new URLSearchParams(window.location.search);
}

function scopeRoute(pathname = '/workbench') {
  const params = new URLSearchParams();
  if (state.provider) params.set('provider', state.provider);
  if ($('#service-select').value) params.set('service', $('#service-select').value);
  if ($('#environment-select').value) params.set('environment', $('#environment-select').value);
  params.set('window', $('#window-select').value);
  return `${pathname}?${params}`;
}

function navigate(path, { replace = false } = {}) {
  window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
}

function syncScopeRoute() {
  if (!state.provider || window.location.pathname === '/') return;
  if (window.location.pathname.startsWith('/results/')) {
    state.analysisId = null;
    state.findings = [];
    state.artifacts = null;
    $('#analysis-results').hidden = true;
    $('#empty-state').hidden = false;
    navigate(scopeRoute('/workbench'));
    return;
  }
  navigate(scopeRoute('/workbench'), { replace: true });
}

async function api(path, payload) {
  const response = await fetch(path, {
    method: payload ? 'POST' : 'GET',
    headers: payload ? { 'content-type': 'application/json' } : {},
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

let toastTimer;
function toast(message, success = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast visible${success ? ' success' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = 'toast'; }, 4200);
}

function setOptions(select, values, emptyLabel = 'No values returned') {
  select.replaceChildren();
  if (!values.length) {
    const option = document.createElement('option');
    option.textContent = emptyLabel;
    option.value = '';
    select.append(option);
    return;
  }
  values.forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === '*' ? (select.id === 'service-select' ? 'All services' : 'All environments') : value;
    select.append(option);
  });
}

async function connect(provider, button, { oauthRetry = false, restore = false } = {}) {
  const loginWindow = provider !== 'sample' && !oauthRetry
    ? window.open('about:blank', `telemetry-diet-${provider}-oauth`, 'popup,width=620,height=760')
    : null;
  $$('.source-button').forEach((source) => { source.disabled = true; });
  button.setAttribute('aria-busy', 'true');
  const original = button.querySelector('strong').textContent;
  button.querySelector('strong').textContent = `Connecting ${labels[provider]}…`;
  try {
    const data = await api('/api/connect', { provider });
    if (data.authorizationRequired) {
      if (!loginWindow) {
        navigate('/', { replace: true });
        toast(`Log in with ${labels[provider]} again to restore this screen.`);
        return false;
      }
      loginWindow.location.replace(data.authorizationUrl);
      toast(`Complete ${labels[provider]} login in the provider window.`);
      return false;
    }
    loginWindow?.close();
    state.provider = provider;
    setOptions($('#service-select'), data.services, 'No services found');
    setOptions($('#environment-select'), data.environments, 'All environments');
    const params = routeParams();
    const requestedService = params.get('service');
    if (restore && requestedService && [...$('#service-select').options].some(({ value }) => value === requestedService)) {
      $('#service-select').value = requestedService;
      const scoped = await api('/api/environments', { provider, service: requestedService });
      setOptions($('#environment-select'), scoped.environments, 'All environments');
    }
    const requestedEnvironment = params.get('environment');
    if (restore && requestedEnvironment && [...$('#environment-select').options].some(({ value }) => value === requestedEnvironment)) {
      $('#environment-select').value = requestedEnvironment;
    }
    const requestedWindow = params.get('window');
    if (restore && requestedWindow && [...$('#window-select').options].some(({ value }) => value === requestedWindow)) {
      $('#window-select').value = requestedWindow;
    }
    $('#provider-input').value = labels[provider];
    $('#provider-label').textContent = labels[provider];
    $('#connection-name').textContent = `${data.connection.serverInfo?.name || labels[provider]} connected`;
    $('#connection-tools').textContent = data.connection.tools?.join(' · ') || 'Read-only MCP tool session';
    $('#connect-view').hidden = true;
    $('#workbench-view').hidden = false;
    if (!restore) navigate(scopeRoute('/workbench'));
    document.title = `${labels[provider]} · Telemetry Diet`;
    if (data.warning) toast(data.warning);
    return true;
  } catch (error) {
    loginWindow?.close();
    toast(error.message);
    return false;
  } finally {
    button.removeAttribute('aria-busy');
    button.querySelector('strong').textContent = original;
    $$('.source-button').forEach((source) => { source.disabled = false; });
  }
}

async function updateEnvironments() {
  try {
    const { environments } = await api('/api/environments', { provider: state.provider, service: $('#service-select').value });
    setOptions($('#environment-select'), environments, 'All environments');
    syncScopeRoute();
  } catch (error) {
    toast(error.message);
  }
}

function timeWindow() {
  const end = new Date();
  const start = new Date(end.getTime() - Number($('#window-select').value) * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
}

function renderFindings(selectedIds) {
  const list = $('#findings-list');
  list.replaceChildren();
  state.findings.forEach((finding) => {
    const item = document.createElement('article');
    item.className = 'finding';
    item.dataset.category = finding.category;

    const icon = document.createElement('span');
    icon.className = 'finding-icon';
    icon.textContent = categorySymbols[finding.category] || '?';

    const copy = document.createElement('div');
    copy.className = 'finding-copy';
    const titleLine = document.createElement('div');
    titleLine.className = 'finding-title-line';
    const title = document.createElement('strong');
    title.textContent = finding.title;
    const confidence = document.createElement('span');
    confidence.className = 'confidence';
    confidence.textContent = `${finding.confidence} confidence`;
    titleLine.append(title, confidence);
    const action = document.createElement('p');
    action.textContent = finding.suggestedAction;
    const examples = document.createElement('p');
    examples.className = 'finding-examples';
    examples.title = finding.examplesRedacted.join(' · ');
    examples.textContent = finding.examplesRedacted.join(' · ') || finding.warning;
    const affected = document.createElement('span');
    affected.className = 'affected';
    affected.textContent = `${formatNumber(finding.affectedCount)} records affected in selected window`;
    copy.append(titleLine, action, examples, affected);

    const toggle = document.createElement('label');
    toggle.className = 'policy-toggle';
    toggle.title = `Include ${finding.title} in generated drafts`;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = selectedIds.includes(finding.id);
    input.dataset.finding = finding.id;
    input.setAttribute('aria-label', `Include ${finding.title} in generated policy`);
    input.addEventListener('change', regenerate);
    toggle.append(input, document.createElement('span'));

    item.append(icon, copy, toggle);
    list.append(item);
  });
}

function renderPreview() {
  const preview = state.artifacts.preview;
  $('#before-count').textContent = formatNumber(preview.recordsAnalyzed);
  $('#after-count').textContent = formatNumber(preview.recordsAfter);
  $('#reduction-percent').textContent = `${preview.directionalReductionPercent}% affected`;
  $('#preview-caveat').textContent = preview.caveat;
  const retained = preview.recordsAnalyzed ? (preview.recordsAfter / preview.recordsAnalyzed) * 100 : 100;
  $('#impact-retained').style.width = `${retained}%`;
  $('#impact-removed').style.width = `${100 - retained}%`;
  $('#noise-summary').textContent = `${preview.directionalReductionPercent}%`;
}

function currentOutput() {
  const value = state.artifacts?.[state.output];
  return state.output === 'last9' ? JSON.stringify(value, null, 2) : value || '';
}

function renderOutput() {
  $('#output-code').textContent = currentOutput();
  $$('.output-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.output === state.output));
}

function renderAnalysis(data) {
  state.analysisId = data.analysisId;
  state.findings = data.findings;
  state.artifacts = data.artifacts;
  const { summary, findings, artifacts } = data;
  $('#results-title').textContent = summary.service || 'Selected service';
  $('#results-scope').textContent = `${summary.environment || 'all environments'} · ${new Date(summary.timeWindow.start).toLocaleString()} – ${new Date(summary.timeWindow.end).toLocaleString()}`;
  $('#records-total').textContent = formatNumber(summary.recordsAnalyzed);
  $('#risk-summary').textContent = findings.filter((finding) => finding.category === 'risk').length;
  $('#cardinality-summary').textContent = findings.filter((finding) => finding.category === 'cardinality').length;
  $('#drift-summary').textContent = findings.filter((finding) => finding.category === 'drift').length;
  $('#finding-count').textContent = `${findings.length} findings`;
  renderFindings(artifacts.selectedIds);
  renderPreview();
  renderOutput();
  $('#loading-state').hidden = true;
  $('#analysis-results').hidden = false;
}

async function analyze() {
  const button = $('#analyze-button');
  button.disabled = true;
  $('#empty-state').hidden = true;
  $('#analysis-results').hidden = true;
  $('#loading-state').hidden = false;
  const loadingSteps = ['Fetching provider summaries…', 'Checking deterministic fingerprints…', 'Generating visible policy drafts…'];
  let step = 0;
  const interval = setInterval(() => { $('#loading-copy').textContent = loadingSteps[Math.min(++step, loadingSteps.length - 1)]; }, 650);
  try {
    const data = await api('/api/analyze', {
      provider: state.provider,
      service: $('#service-select').value,
      environment: $('#environment-select').value || undefined,
      timeWindow: timeWindow(),
      signal: 'logs',
    });
    renderAnalysis(data);
    navigate(scopeRoute(`/results/${data.analysisId}`));
  } catch (error) {
    $('#loading-state').hidden = true;
    $('#empty-state').hidden = false;
    toast(error.message);
  } finally {
    clearInterval(interval);
    button.disabled = false;
  }
}

let generationTimer;
function regenerate() {
  clearTimeout(generationTimer);
  generationTimer = setTimeout(async () => {
    const selectedIds = $$('[data-finding]:checked').map((input) => input.dataset.finding);
    try {
      const { artifacts } = await api('/api/generate', { analysisId: state.analysisId, selectedIds });
      state.artifacts = artifacts;
      renderPreview();
      renderOutput();
    } catch (error) {
      toast(error.message);
    }
  }, 120);
}

function reset({ updateHistory = true } = {}) {
  state.provider = null;
  state.analysisId = null;
  state.findings = [];
  state.artifacts = null;
  $('#workbench-view').hidden = true;
  $('#connect-view').hidden = false;
  $('#analysis-results').hidden = true;
  $('#loading-state').hidden = true;
  $('#empty-state').hidden = false;
  document.title = 'Telemetry Diet';
  if (updateHistory) navigate('/');
}

async function restoreRoute() {
  const pathname = window.location.pathname;
  if (pathname === '/') {
    reset({ updateHistory: false });
    return;
  }
  const provider = routeParams().get('provider');
  if (!['sample', 'datadog', 'last9'].includes(provider)) {
    navigate('/', { replace: true });
    reset({ updateHistory: false });
    return;
  }
  if (state.provider !== provider || $('#workbench-view').hidden) {
    const connected = await connect(provider, $(`.source-button[data-provider="${provider}"]`), { restore: true });
    if (!connected) return;
  }
  if (pathname === '/workbench') {
    $('#analysis-results').hidden = true;
    $('#loading-state').hidden = true;
    $('#empty-state').hidden = false;
    return;
  }
  const resultMatch = pathname.match(/^\/results\/([a-f0-9-]+)$/i);
  if (!resultMatch) {
    navigate(scopeRoute('/workbench'), { replace: true });
    return;
  }
  try {
    const data = await api(`/api/analysis/${resultMatch[1]}`);
    renderAnalysis(data);
  } catch (error) {
    navigate(scopeRoute('/workbench'), { replace: true });
    $('#analysis-results').hidden = true;
    $('#empty-state').hidden = false;
    toast(error.message);
  }
}

$$('.source-button').forEach((button) => button.addEventListener('click', () => connect(button.dataset.provider, button)));
window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== 'telemetry-diet-oauth') return;
  const provider = event.data.provider;
  const button = $(`.source-button[data-provider="${provider}"]`);
  if (button) connect(provider, button, { oauthRetry: true });
});
$('#service-select').addEventListener('change', updateEnvironments);
$('#environment-select').addEventListener('change', syncScopeRoute);
$('#window-select').addEventListener('change', syncScopeRoute);
$('#analyze-button').addEventListener('click', analyze);
$('#change-source').addEventListener('click', reset);
window.addEventListener('popstate', restoreRoute);
$$('.output-tabs button').forEach((button) => button.addEventListener('click', () => {
  state.output = button.dataset.output;
  renderOutput();
}));
$('#copy-output').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(currentOutput());
    toast('Current draft copied.', true);
  } catch {
    toast('Clipboard access is unavailable in this browser.');
  }
});
$('#download-output').addEventListener('click', () => {
  const meta = outputMeta[state.output];
  const url = URL.createObjectURL(new Blob([currentOutput()], { type: meta.type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = meta.filename;
  link.click();
  URL.revokeObjectURL(url);
});
api('/api/config').then((config) => {
  state.config = config;
  for (const provider of ['datadog', 'last9']) {
    const button = $(`.source-button[data-provider="${provider}"]`);
    const small = button.querySelector('small');
    if (config.providers[provider].mode === 'hosted-oauth') small.textContent = 'Provider login · read-only tools';
    else if (!config.providers[provider].configured) small.textContent = 'Provider endpoint is not configured';
  }
  return restoreRoute();
}).catch((error) => toast(error.message));
