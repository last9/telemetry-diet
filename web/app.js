const state = {
  provider: null,
  signal: 'logs',
  analysisId: null,
  findings: [],
  artifacts: null,
  output: 'otel',
  signalArtifacts: null,
  signalOutput: null,
  config: null,
};

let analysisGeneration = 0;
let analysisInFlight = false;
let routeGeneration = 0;
let generationTimer;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const labels = { sample: 'Sample MCP', datadog: 'Datadog MCP', last9: 'Last9 MCP' };
const categorySymbols = { risk: '!', noise: '↓', cardinality: '#', drift: '↔' };
const outputMeta = {
  otel: { filename: 'telemetry-diet-collector.yaml', type: 'text/yaml' },
  last9: { filename: 'telemetry-diet-last9-draft.json', type: 'application/json' },
  markdown: { filename: 'telemetry-diet-report.md', type: 'text/markdown' },
};
const signalOutputMeta = {
  otel: { label: 'OTel / OTTL', type: 'text/yaml', extension: 'yaml' },
  collector: { label: 'Collector YAML', type: 'text/yaml', extension: 'yaml' },
  ottl: { label: 'OTTL', type: 'text/plain', extension: 'ottl' },
  markdown: { label: 'Report', type: 'text/markdown', extension: 'md' },
  json: { label: 'JSON', type: 'application/json', extension: 'json' },
};
const traceRecommendationCopy = {
  'resource-attribute-trim': 'Trim a measured resource attribute while preserving span records and protected service context.',
  'span-name-normalization': 'Normalize repeated opaque identifiers in span names while preserving the spans themselves.',
  'redundant-instrumentation-disablement': 'Review source-level disablement for this wrapper while retaining its paired boundary instrumentation.',
  'selective-low-value-leaf-filter': 'Filter only this exact low-value INTERNAL leaf span after validating error and business coverage.',
  'health-route-candidate': 'Review this exact health-route cohort; generated filters remain limited to safe INTERNAL leaves.',
  'fast-success-cohort': 'Consider targeted sampling only after validating full-trace latency and error retention.',
  'residual-head-sampling': 'Consider residual head sampling only after targeted reductions, with separately validated error retention.',
};

function routeParams() {
  return new URLSearchParams(window.location.search);
}

function scopeRoute(pathname = '/workbench') {
  const params = new URLSearchParams();
  if (state.provider) params.set('provider', state.provider);
  params.set('signal', state.signal);
  if ($('#service-select').value) params.set('service', $('#service-select').value);
  if ($('#environment-select').value) params.set('environment', $('#environment-select').value);
  params.set('window', $('#window-select').value);
  return `${pathname}?${params}`;
}

function navigate(path, { replace = false } = {}) {
  window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
}

function isProviderRoute(provider) {
  return window.location.pathname !== '/' && routeParams().get('provider') === provider;
}

function syncScopeRoute() {
  if (!state.provider || window.location.pathname === '/') return;
  routeGeneration += 1;
  if (window.location.pathname.startsWith('/results/')) {
    state.analysisId = null;
    state.findings = [];
    state.artifacts = null;
    state.signalArtifacts = null;
    $('#analysis-results').hidden = true;
    $('#signal-results').hidden = true;
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

function revealWhenOutsideViewport(element) {
  window.requestAnimationFrame(() => {
    const bounds = element.getBoundingClientRect();
    const visible = bounds.top >= 0 && bounds.top < window.innerHeight && bounds.bottom > 0;
    if (!visible) element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
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

const signalCopy = {
  logs: {
    emptyTitle: 'Ready to inspect logs',
    emptyCopy: 'Choose a scope and run a deterministic analysis. Summaries are fetched before any redacted examples.',
    analyze: 'Analyze selected window',
    loading: 'Analyzing selected window',
    loadingSteps: ['Fetching provider summaries…', 'Checking deterministic fingerprints…', 'Generating visible policy drafts…'],
  },
  traces: {
    emptyTitle: 'Ready to inspect traces',
    emptyCopy: 'Measure trace composition before drafting byte trims, selective filters, or sampling changes.',
    analyze: 'Analyze trace window',
    loading: 'Analyzing trace composition',
    loadingSteps: ['Fetching bounded trace summaries…', 'Measuring span and byte composition…', 'Drafting safe reduction levers…'],
  },
  metrics: {
    emptyTitle: 'Ready to inspect metric usage',
    emptyCopy: 'Compare the metric catalog with dashboard, alert, and indicator references across the organization.',
    analyze: 'Analyze metric references',
    loading: 'Analyzing metric references',
    loadingSteps: ['Fetching metric inventory…', 'Parsing dashboard and alert queries…', 'Classifying metric references…'],
  },
};

function syncSignalControls() {
  const copy = signalCopy[state.signal];
  const organizationWide = state.signal === 'metrics';
  $('#service-control').hidden = organizationWide;
  $('#environment-control').hidden = organizationWide;
  $('#window-control').hidden = organizationWide;
  $('#empty-title').textContent = copy.emptyTitle;
  $('#empty-copy').textContent = copy.emptyCopy;
  $('#analyze-label').textContent = copy.analyze;
  $('#loading-title').textContent = copy.loading;
  $$('[data-signal]').forEach((button) => {
    button.disabled = analysisInFlight || (state.provider === 'datadog' && button.dataset.signal !== 'logs');
    button.classList.toggle('active', button.dataset.signal === state.signal);
  });
}

function cancelPendingAnalysis() {
  analysisGeneration += 1;
  analysisInFlight = false;
  $('#analyze-button').disabled = false;
}

function cancelRegeneration() {
  clearTimeout(generationTimer);
  generationTimer = undefined;
}

function selectSignal(signal) {
  if (!signalCopy[signal] || (state.provider === 'datadog' && signal !== 'logs')) return;
  cancelPendingAnalysis();
  cancelRegeneration();
  routeGeneration += 1;
  state.signal = signal;
  state.analysisId = null;
  state.findings = [];
  state.artifacts = null;
  state.signalArtifacts = null;
  $('#analysis-results').hidden = true;
  $('#signal-results').hidden = true;
  $('#loading-state').hidden = true;
  $('#empty-state').hidden = false;
  syncSignalControls();
  syncScopeRoute();
}

async function connect(provider, button, { oauthRetry = false, restore = false, interactive = true } = {}) {
  const loginWindow = provider !== 'sample' && !oauthRetry && interactive
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
        toast(`Log in with ${labels[provider]} to restore this screen.`);
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
    const requestedSignal = params.get('signal');
    state.signal = restore && ['logs', 'traces', 'metrics'].includes(requestedSignal) ? requestedSignal : 'logs';
    if (provider === 'datadog' && state.signal !== 'logs') state.signal = 'logs';
    $('#provider-input').value = labels[provider];
    $('#provider-label').textContent = labels[provider];
    $('#connection-name').textContent = `${data.connection.serverInfo?.name || labels[provider]} connected`;
    $('#connection-tools').textContent = data.connection.tools?.join(' · ') || 'Read-only MCP tool session';
    $('#connect-view').hidden = true;
    $('#workbench-view').hidden = false;
    syncSignalControls();
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

async function connectFromButton(button) {
  const provider = button.dataset.provider;
  const restore = isProviderRoute(provider);
  const connected = await connect(provider, button, { restore });
  if (connected && restore) await restoreRoute();
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
  revealWhenOutsideViewport($('#analysis-results'));
}

function signalArtifactEntries() {
  return Object.entries(state.signalArtifacts || {}).filter(([, value]) => value !== undefined && value !== null);
}

function currentSignalOutput() {
  const value = state.signalArtifacts?.[state.signalOutput];
  return typeof value === 'string' ? value : JSON.stringify(value || {}, null, 2);
}

function renderSignalOutput() {
  const entries = signalArtifactEntries();
  if (!entries.length) {
    $('#signal-output-tabs').replaceChildren();
    $('#signal-output-code').textContent = '';
    return;
  }
  if (!entries.some(([name]) => name === state.signalOutput)) state.signalOutput = entries[0][0];
  const tabs = $('#signal-output-tabs');
  tabs.replaceChildren();
  entries.forEach(([name]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.signalOutput = name;
    button.classList.toggle('active', name === state.signalOutput);
    button.textContent = signalOutputMeta[name]?.label || name.toUpperCase();
    button.addEventListener('click', () => {
      state.signalOutput = name;
      renderSignalOutput();
    });
    tabs.append(button);
  });
  $('#signal-output-code').textContent = currentSignalOutput();
}

function renderSignalSummary(summary = {}) {
  const labelsByKey = {
    catalogCount: 'catalog metrics',
    referencedCount: 'referenced metrics',
    unreferencedCount: 'unreferenced metrics',
    underreferencedCount: 'single-reference metrics',
    protectedCount: 'protected metrics',
    totalSpans: 'spans measured',
    totalBytes: 'bytes measured',
    recommendationCount: 'recommendations',
  };
  const entries = Object.entries(summary)
    .filter(([, value]) => typeof value === 'number' || typeof value === 'string')
    .slice(0, 4);
  const band = $('#signal-summary-band');
  band.replaceChildren();
  entries.forEach(([key, value], index) => {
    const item = document.createElement('div');
    const symbol = document.createElement('span');
    symbol.className = `summary-symbol ${['noise', 'risk', 'cardinality', 'drift'][index]}`;
    symbol.textContent = ['Σ', '✓', '↓', '!'][index];
    const copy = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = typeof value === 'number' ? formatNumber(value) : value;
    const label = document.createElement('small');
    label.textContent = labelsByKey[key] || key.replace(/([A-Z])/g, ' $1').toLowerCase();
    copy.append(strong, label);
    item.append(symbol, copy);
    band.append(item);
  });
}

function renderMetricResults(metrics) {
  const rows = Array.isArray(metrics) ? metrics : Object.values(metrics || {});
  $('#metric-results').hidden = state.signal !== 'metrics';
  const body = $('#metric-results-body');
  body.replaceChildren();
  rows.forEach((metric) => {
    const row = document.createElement('tr');
    const values = [
      metric.name,
      metric.status,
      formatNumber(metric.referenceCount ?? metric.totalCount ?? metric.total_count),
      metric.protected || metric.whitelisted ? 'Protected' : 'Review',
    ];
    values.forEach((value) => {
      const cell = document.createElement('td');
      cell.textContent = value ?? '';
      row.append(cell);
    });
    body.append(row);
  });
  return rows.length;
}

function renderTraceFindings(findings) {
  const list = $('#signal-findings-list');
  list.replaceChildren();
  findings.forEach((finding) => {
    const item = document.createElement('article');
    item.className = 'finding';
    item.dataset.category = finding.category || 'noise';
    const icon = document.createElement('span');
    icon.className = 'finding-icon';
    icon.textContent = categorySymbols[finding.category] || '→';
    const copy = document.createElement('div');
    copy.className = 'finding-copy';
    const titleLine = document.createElement('div');
    titleLine.className = 'finding-title-line';
    const title = document.createElement('strong');
    title.textContent = finding.title || finding.category?.replaceAll('-', ' ') || 'Recommendation';
    titleLine.append(title);
    if (finding.confidence) {
      const confidence = document.createElement('span');
      confidence.className = 'confidence';
      confidence.textContent = `${finding.confidence} confidence`;
      titleLine.append(confidence);
    }
    const action = document.createElement('p');
    action.textContent = finding.suggestedAction || finding.description || traceRecommendationCopy[finding.category] || '';
    const evidence = document.createElement('p');
    evidence.className = 'finding-examples';
    const measuredBytes = finding.evidence?.measuredBytes;
    const observedSpans = finding.evidence?.observedSpanCount;
    evidence.textContent = [
      measuredBytes == null ? null : `${formatNumber(measuredBytes)} measured bytes`,
      observedSpans == null ? null : `${formatNumber(observedSpans)} spans`,
      finding.preserves?.length ? `Preserves ${finding.preserves.join(', ')}` : null,
    ].filter(Boolean).join(' · ');
    copy.append(titleLine, action, evidence);
    item.append(icon, copy);
    list.append(item);
  });
}

function renderSignalAnalysis(data) {
  state.analysisId = data.analysisId;
  state.signalArtifacts = data.artifacts || {};
  state.signalOutput = Object.keys(state.signalArtifacts)[0] || null;
  const result = data.result || {};
  $('#metric-results').hidden = state.signal !== 'metrics';
  const metricsCount = state.signal === 'metrics' ? renderMetricResults(result.metrics) : 0;
  const findings = state.signal === 'traces' ? result.recommendations || [] : [];
  renderTraceFindings(findings);
  renderSignalSummary(result.summary);
  const limitations = [...new Set([...(result.limitations || []), ...(result.warnings || [])])];
  const limitationList = $('#signal-limitations');
  limitationList.replaceChildren();
  (limitations.length ? limitations : ['Review every draft against representative production traffic before applying it.']).forEach((limitation) => {
    const item = document.createElement('li');
    item.textContent = typeof limitation === 'string' ? limitation : limitation.message || JSON.stringify(limitation);
    limitationList.append(item);
  });
  $('#signal-results-title').textContent = data.title || (state.signal === 'metrics' ? 'Metric usage' : 'Trace intelligence');
  $('#signal-results-scope').textContent = data.scope || (state.signal === 'metrics' ? 'Organization-wide reference scan' : `${$('#service-select').value} · ${$('#environment-select').value || 'all environments'}`);
  $('#signal-total').textContent = formatNumber(state.signal === 'metrics' ? metricsCount : result.summary?.totalSpans);
  $('#signal-total-label').textContent = state.signal === 'metrics' ? 'metrics classified' : 'spans measured';
  $('#signal-finding-count').textContent = state.signal === 'metrics' ? `${metricsCount} metrics` : `${findings.length} findings`;
  renderSignalOutput();
  $('#loading-state').hidden = true;
  $('#empty-state').hidden = true;
  $('#analysis-results').hidden = true;
  $('#signal-results').hidden = false;
  revealWhenOutsideViewport($('#signal-results'));
}

async function analyze() {
  const requestedSignal = state.signal;
  const generation = ++analysisGeneration;
  const routeAtStart = routeGeneration;
  const button = $('#analyze-button');
  analysisInFlight = true;
  button.disabled = true;
  syncSignalControls();
  $('#empty-state').hidden = true;
  $('#analysis-results').hidden = true;
  $('#signal-results').hidden = true;
  $('#loading-state').hidden = false;
  revealWhenOutsideViewport($('#loading-state'));
  const loadingSteps = signalCopy[requestedSignal].loadingSteps;
  let step = 0;
  const interval = setInterval(() => {
    const nextStep = Math.min(step + 1, loadingSteps.length - 1);
    if (nextStep === step) return;
    step = nextStep;
    $('#loading-copy').textContent = loadingSteps[step];
  }, 650);
  try {
    const data = await api('/api/analyze', {
      provider: state.provider,
      service: $('#service-select').value,
      environment: $('#environment-select').value || undefined,
      timeWindow: timeWindow(),
      signal: requestedSignal,
    });
    if (generation !== analysisGeneration || routeAtStart !== routeGeneration || requestedSignal !== state.signal) return;
    if (requestedSignal === 'logs') renderAnalysis(data);
    else renderSignalAnalysis(data);
    routeGeneration += 1;
    navigate(scopeRoute(`/results/${data.analysisId}`));
  } catch (error) {
    if (generation !== analysisGeneration || routeAtStart !== routeGeneration) return;
    $('#loading-state').hidden = true;
    $('#empty-state').hidden = false;
    toast(error.message);
  } finally {
    clearInterval(interval);
    if (generation === analysisGeneration) {
      analysisInFlight = false;
      button.disabled = false;
      syncSignalControls();
    }
  }
}

function regenerate() {
  cancelRegeneration();
  const analysisId = state.analysisId;
  const signal = state.signal;
  if (signal !== 'logs' || !analysisId) return;
  generationTimer = setTimeout(async () => {
    generationTimer = undefined;
    if (state.signal !== signal || state.analysisId !== analysisId) return;
    const selectedIds = $$('[data-finding]:checked').map((input) => input.dataset.finding);
    try {
      const { artifacts } = await api('/api/generate', { analysisId, selectedIds });
      if (state.signal !== signal || state.analysisId !== analysisId) return;
      state.artifacts = artifacts;
      renderPreview();
      renderOutput();
    } catch (error) {
      toast(error.message);
    }
  }, 120);
}

function reset({ updateHistory = true } = {}) {
  cancelPendingAnalysis();
  cancelRegeneration();
  routeGeneration += 1;
  state.provider = null;
  state.signal = 'logs';
  state.analysisId = null;
  state.findings = [];
  state.artifacts = null;
  state.signalArtifacts = null;
  $('#workbench-view').hidden = true;
  $('#connect-view').hidden = false;
  $('#analysis-results').hidden = true;
  $('#signal-results').hidden = true;
  $('#loading-state').hidden = true;
  $('#empty-state').hidden = false;
  document.title = 'Telemetry Diet';
  if (updateHistory) navigate('/');
}

async function restoreRoute() {
  const generation = ++routeGeneration;
  const pathname = window.location.pathname;
  const isCurrent = () => generation === routeGeneration && window.location.pathname === pathname;
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
    const connected = await connect(provider, $(`.source-button[data-provider="${provider}"]`), { restore: true, interactive: false });
    if (!connected || !isCurrent()) return;
  }
  if (pathname === '/workbench') {
    $('#analysis-results').hidden = true;
    $('#signal-results').hidden = true;
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
    if (!isCurrent()) return;
    state.signal = data.analysisType || routeParams().get('signal') || 'logs';
    syncSignalControls();
    if (state.signal === 'logs') renderAnalysis(data);
    else renderSignalAnalysis(data);
  } catch (error) {
    if (!isCurrent()) return;
    navigate(scopeRoute('/workbench'), { replace: true });
    $('#analysis-results').hidden = true;
    $('#signal-results').hidden = true;
    $('#empty-state').hidden = false;
    toast(error.message);
  }
}

$$('.source-button').forEach((button) => button.addEventListener('click', () => connectFromButton(button)));
window.addEventListener('message', async (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== 'telemetry-diet-oauth') return;
  const provider = event.data.provider;
  const button = $(`.source-button[data-provider="${provider}"]`);
  if (!button) return;
  const restore = isProviderRoute(provider);
  const connected = await connect(provider, button, { oauthRetry: true, restore, interactive: false });
  if (connected && restore) await restoreRoute();
});
$('#service-select').addEventListener('change', updateEnvironments);
$('#environment-select').addEventListener('change', syncScopeRoute);
$('#window-select').addEventListener('change', syncScopeRoute);
$$('[data-signal]').forEach((button) => button.addEventListener('click', () => selectSignal(button.dataset.signal)));
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
$('#copy-signal-output').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(currentSignalOutput());
    toast('Current draft copied.', true);
  } catch {
    toast('Clipboard access is unavailable in this browser.');
  }
});
$('#download-signal-output').addEventListener('click', () => {
  const meta = signalOutputMeta[state.signalOutput] || signalOutputMeta.markdown;
  const url = URL.createObjectURL(new Blob([currentSignalOutput()], { type: meta.type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `telemetry-diet-${state.signal}-${state.signalOutput || 'report'}.${meta.extension}`;
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
