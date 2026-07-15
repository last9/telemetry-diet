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

async function connect(provider, button, { oauthRetry = false } = {}) {
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
      if (!loginWindow) throw new Error(`Allow popups, then log in with ${labels[provider]}.`);
      loginWindow.location.replace(data.authorizationUrl);
      toast(`Complete ${labels[provider]} login in the provider window.`);
      return;
    }
    loginWindow?.close();
    state.provider = provider;
    setOptions($('#service-select'), data.services, 'No services found');
    setOptions($('#environment-select'), data.environments, 'All environments');
    $('#provider-input').value = labels[provider];
    $('#provider-label').textContent = labels[provider];
    $('#connection-name').textContent = `${data.connection.serverInfo?.name || labels[provider]} connected`;
    $('#connection-tools').textContent = data.connection.tools?.join(' · ') || 'Read-only MCP tool session';
    $('#connect-view').hidden = true;
    $('#workbench-view').hidden = false;
    document.title = `${labels[provider]} · Telemetry Diet`;
    if (data.warning) toast(data.warning);
  } catch (error) {
    loginWindow?.close();
    toast(error.message);
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

function reset() {
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
}

$$('.source-button').forEach((button) => button.addEventListener('click', () => connect(button.dataset.provider, button)));
window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== 'telemetry-diet-oauth') return;
  const provider = event.data.provider;
  const button = $(`.source-button[data-provider="${provider}"]`);
  if (button) connect(provider, button, { oauthRetry: true });
});
$('#service-select').addEventListener('change', updateEnvironments);
$('#analyze-button').addEventListener('click', analyze);
$('#change-source').addEventListener('click', reset);
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
}).catch(() => {});
