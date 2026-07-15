const state = {
  provider: null,
  signal: 'logs',
  analysisId: null,
  findings: [],
  selected: new Set(),
  filter: 'all',
  artifacts: null,
  output: 'otel',
  signalArtifacts: null,
  signalOutput: null,
  config: null,
};

// Logs review-queue: each finding is a proposed change led by a verb derived
// from finding.action. Colour is meaning, not decoration — amber = volume,
// rose = privacy; the rest stay neutral.
const verbLabels = { drop: 'Drop', sample: 'Sample', redact: 'Redact', 'remove-label': 'Un-index', normalize: 'Normalize', review: 'Review' };
const verbClasses = { drop: 'v-drop', sample: 'v-sample', redact: 'v-redact', 'remove-label': 'v-unindex', normalize: 'v-normalize', review: 'v-review' };
const configGroups = [
  ['drop', 'Drop noisy logs'],
  ['sample', 'Sample noisy logs'],
  ['redact', 'Redact sensitive attributes'],
  ['remove-label', 'Un-index high-cardinality'],
  ['normalize', 'Normalize naming'],
  ['review', 'Flagged for review'],
];
const copyLabels = { otel: 'Copy OTel config', last9: 'Copy Last9 config', markdown: 'Copy report' };
const BASELINE_KEY = 'telemetry-diet.baseline';

let analysisGeneration = 0;
let analysisInFlight = false;
let routeGeneration = 0;
let generationTimer;
let regenToken = 0;
let changeSeq = 0; // source of DOM-safe ids for change detail panels
let analysisAbort = null; // AbortController for the in-flight /api/analyze
let draftBusy = false;

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

function closeDraftModal() {
  const modal = $('#draft-modal');
  if (modal?.open) modal.close();
}

function syncScopeRoute() {
  if (!state.provider || window.location.pathname === '/') return;
  if (analysisInFlight) cancelPendingAnalysis(); // changing scope abandons the running analysis
  closeDraftModal();
  routeGeneration += 1;
  if (window.location.pathname.startsWith('/results/')) {
    state.analysisId = null;
    state.findings = [];
    state.selected = new Set();
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

async function api(path, payload, { signal } = {}) {
  const response = await fetch(path, {
    method: payload ? 'POST' : 'GET',
    headers: payload ? { 'content-type': 'application/json' } : {},
    body: payload ? JSON.stringify(payload) : undefined,
    signal,
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
    const active = button.dataset.signal === state.signal;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function cancelPendingAnalysis() {
  analysisGeneration += 1;
  analysisInFlight = false;
  if (analysisAbort) { analysisAbort.abort(); analysisAbort = null; } // stop the network request
  $('#analyze-button').disabled = false;
  if (!$('#loading-state').hidden) { // reset the loader back to the ready state
    $('#loading-state').hidden = true;
    $('#empty-state').hidden = false;
  }
  syncSignalControls();
}

function cancelRegeneration() {
  clearTimeout(generationTimer);
  generationTimer = undefined;
  regenToken += 1;     // supersede any scheduled or in-flight generation
  setDraftBusy(false); // never leave Copy/Download stuck disabled after a cancel
}

function selectSignal(signal) {
  if (!signalCopy[signal] || (state.provider === 'datadog' && signal !== 'logs')) return;
  cancelPendingAnalysis();
  cancelRegeneration();
  routeGeneration += 1;
  state.signal = signal;
  state.analysisId = null;
  state.findings = [];
  state.selected = new Set();
  state.artifacts = null;
  state.signalArtifacts = null;
  closeDraftModal();
  $('#analysis-results').hidden = true;
  $('#signal-results').hidden = true;
  $('#loading-state').hidden = true;
  $('#empty-state').hidden = false;
  syncSignalControls();
  syncDraftActions();
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
  if (analysisInFlight) cancelPendingAnalysis(); // changing service abandons the running analysis
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

function changeImpact(finding) {
  if (finding.action === 'drop') return { text: `−${formatNumber(finding.affectedCount)} events`, cls: 'vol' };
  if (finding.action === 'sample') return { text: `sample ${formatNumber(finding.affectedCount)}`, cls: 'vol' };
  if (finding.action === 'redact') return { text: 'sensitive', cls: 'risk' };
  if (finding.action === 'remove-label') return { text: 'high cardinality', cls: '' };
  if (finding.action === 'normalize') return { text: 'schema drift', cls: '' };
  return { text: 'review', cls: '' };
}

function evidenceLabel(finding) {
  const examples = finding.examplesRedacted || [];
  if (!examples.length) return `No examples returned — ${formatNumber(finding.affectedCount)} records affected`;
  if (finding.category === 'cardinality') return `Field values · redacted — ${formatNumber(finding.affectedCount)} records`;
  if (finding.category === 'drift') return `Conflicting fields — ${formatNumber(finding.affectedCount)} affected`;
  return `Matched log lines · redacted — ${examples.length} of ${formatNumber(finding.affectedCount)}`;
}

// One proposed-change row: verb · title · impact · include/skip, with a
// click-to-expand panel showing the plain-language why and the provider's
// verbatim redacted samples (no client-side reformatting).
function renderChange(finding) {
  const on = state.selected.has(finding.id);
  const article = document.createElement('article');
  article.className = `change${on ? '' : ' skip'}`;
  article.dataset.action = finding.action;
  article.dataset.category = finding.category;

  const row = document.createElement('div');
  row.className = 'change-row';

  // The row is not itself a control. A disclosure button (holding only
  // non-interactive spans) reveals the evidence, and the Include button lives
  // beside it — never nested inside another interactive element.
  // finding.id contains provider-derived field names (spaces, dots, brackets),
  // so derive the DOM id from a counter rather than interpolating it.
  const detailId = `change-detail-${changeSeq += 1}`;
  const disclosure = document.createElement('button');
  disclosure.type = 'button';
  disclosure.className = 'change-disclosure';
  disclosure.setAttribute('aria-expanded', 'false');
  disclosure.setAttribute('aria-controls', detailId);

  const verb = document.createElement('span');
  verb.className = `verb ${verbClasses[finding.action] || ''}`.trim();
  verb.textContent = verbLabels[finding.action] || finding.action;

  const title = document.createElement('span');
  title.className = 'change-title';
  title.textContent = finding.title;
  title.title = finding.title;

  const grow = document.createElement('span');
  grow.className = 'change-grow';

  const impact = changeImpact(finding);
  const impactEl = document.createElement('span');
  impactEl.className = `change-impact ${impact.cls}`.trim();
  impactEl.textContent = impact.text;

  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = '▾';

  disclosure.append(verb, title, grow, impactEl, caret);

  const include = document.createElement('button');
  include.type = 'button';
  include.className = `inc${on ? ' on' : ''}`;
  include.setAttribute('aria-pressed', String(on));
  include.setAttribute('aria-label', `${on ? 'Remove' : 'Add'} ${finding.title} ${on ? 'from' : 'to'} config`);
  include.textContent = on ? '✓ In config' : '+ Add';
  // Update via closure references — never re-select this row by finding.id.
  include.addEventListener('click', () => {
    const nowOn = !state.selected.has(finding.id);
    if (nowOn) state.selected.add(finding.id); else state.selected.delete(finding.id);
    article.classList.toggle('skip', !nowOn);
    include.classList.toggle('on', nowOn);
    include.setAttribute('aria-pressed', String(nowOn));
    include.textContent = nowOn ? '✓ In config' : '+ Add';
    regenerate();
  });

  row.append(disclosure, include);

  const detail = document.createElement('div');
  detail.className = 'change-detail';
  detail.id = detailId;
  detail.hidden = true;
  const why = document.createElement('p');
  why.className = 'why';
  const conf = document.createElement('span');
  conf.className = 'conf';
  conf.textContent = `${finding.confidence} confidence`;
  why.append(conf, document.createTextNode(finding.suggestedAction || 'Manual review recommended.'));
  const evLabel = document.createElement('div');
  evLabel.className = 'ev-label';
  evLabel.textContent = evidenceLabel(finding);
  detail.append(why, evLabel);

  const examples = finding.examplesRedacted || [];
  if (examples.length) {
    const samples = document.createElement('div');
    samples.className = 'samples';
    examples.forEach((line) => {
      const sline = document.createElement('div');
      sline.className = 'sline';
      sline.textContent = line;
      samples.append(sline);
    });
    detail.append(samples);
  } else {
    const note = document.createElement('p');
    note.className = 'ev-note';
    note.textContent = 'The provider returned no redacted examples for this finding in the selected window. The analyzer may have used field names, aggregate values, or statistical evidence.';
    detail.append(note);
  }

  if (finding.warning) {
    const warning = document.createElement('p');
    warning.className = 'finding-warning';
    warning.textContent = `Limitation: ${finding.warning}`;
    detail.append(warning);
  }

  disclosure.addEventListener('click', () => {
    const open = detail.hidden;
    detail.hidden = !open;
    disclosure.setAttribute('aria-expanded', String(open));
    article.classList.toggle('open', open);
  });

  article.append(row, detail);
  return article;
}

const filterLabels = { all: 'All', noise: 'Volume', risk: 'Privacy', cardinality: 'Cardinality', drift: 'Naming' };

// Category chips summarise the mix and filter the list. Counts come from the
// findings; chips for absent categories are hidden.
function applyChangeFilter() {
  const counts = {};
  state.findings.forEach((finding) => { counts[finding.category] = (counts[finding.category] || 0) + 1; });
  $$('#change-filters .chip').forEach((chip) => {
    const key = chip.dataset.filter;
    const count = key === 'all' ? state.findings.length : (counts[key] || 0);
    chip.hidden = key !== 'all' && count === 0;
    const active = state.filter === key;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
    chip.replaceChildren(document.createTextNode(`${filterLabels[key] || key} `));
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(count);
    chip.append(n);
  });
  $$('#findings-list .change').forEach((row) => {
    row.hidden = state.filter !== 'all' && row.dataset.category !== state.filter;
  });
}

function renderChanges() {
  const list = $('#findings-list');
  list.replaceChildren(...state.findings.map(renderChange));
  applyChangeFilter();
}

// Toggle a change in place (preserves any expanded rows) and re-derive the
// config + savings from the server.
function readBaseline() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(BASELINE_KEY) || '{}'); } catch { stored = {}; }
  const gb = Number(stored.gb);
  const cost = Number(stored.cost);
  return { gb: Number.isFinite(gb) && gb >= 0 ? gb : 40, cost: Number.isFinite(cost) && cost >= 0 ? cost : 0.5 };
}

function formatGb(gb) { return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`; }
function formatMoney(value) { return value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${Math.round(value)}`; }

// Savings are honest: the volume % comes from the server preview; GB/$ are that
// percentage applied to a baseline the user sets, always flagged directional.
function renderSavings() {
  const preview = state.artifacts.preview;
  const pct = preview.directionalReductionPercent || 0;
  const baseline = readBaseline();
  const events = preview.recordsAffected || 0;
  const sensitive = (preview.redactedFields || []).length;
  $('#reduction-percent').textContent = `−${pct}%`;
  if (pct > 0 && baseline.gb > 0) {
    const gbSaved = baseline.gb * pct / 100;
    $('#savings-data').textContent = `≈${formatGb(gbSaved)}`;
    $('#savings-cost').textContent = `≈${formatMoney(gbSaved * 30 * baseline.cost)}`;
  } else {
    $('#savings-data').textContent = '—';
    $('#savings-cost').textContent = '—';
  }
  const bits = [];
  if (events) bits.push(`≈${formatNumber(events)} records affected / window`);
  if (sensitive) bits.push(`${sensitive} sensitive attribute${sensitive > 1 ? 's' : ''} redacted`);
  bits.push(`assumes ${baseline.gb} GB/day ingest, uniform event size`);
  // Keep the analyzer's own caveat — e.g. that overlapping drop categories make
  // the reduction an upper bound — rather than silently dropping it.
  const notes = [`Directional. ${bits.join(' · ')}. Nothing is applied.`];
  if (preview.caveat) notes.push(preview.caveat);
  $('#preview-caveat').textContent = notes.join(' ');
  // The volume % only reflects dropped events; surface the other effects so the
  // savings card responds to every toggle (redact/un-index/rename/sample).
  const effects = { sample: 0, redact: 0, 'remove-label': 0, normalize: 0 };
  state.findings.forEach((finding) => {
    if (state.selected.has(finding.id) && effects[finding.action] !== undefined) effects[finding.action] += 1;
  });
  const effectText = [
    effects.sample && `${effects.sample} sampled`,
    effects.redact && `${effects.redact} sensitive redacted`,
    effects['remove-label'] && `${effects['remove-label']} un-indexed`,
    effects.normalize && `${effects.normalize} renamed`,
  ].filter(Boolean);
  $('#sv-effects').textContent = effectText.length ? `Also: ${effectText.join(' · ')}.` : '';
  renderConfigBreakdown();
}

function renderConfigBreakdown() {
  const counts = {};
  state.findings.forEach((finding) => {
    if (state.selected.has(finding.id)) counts[finding.action] = (counts[finding.action] || 0) + 1;
  });
  const total = state.selected.size;
  $('#cfg-count').textContent = `${total} change${total === 1 ? '' : 's'}`;
  $('#finding-count').textContent = `${state.findings.length} · ${total} in config`;
  const box = $('#cfg-breakdown');
  box.replaceChildren();
  const rows = configGroups.filter(([action]) => counts[action]);
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'br empty';
    empty.append(Object.assign(document.createElement('span'), { textContent: 'Nothing included yet' }));
    empty.append(Object.assign(document.createElement('b'), { textContent: '0' }));
    box.append(empty);
  } else {
    rows.forEach(([action, label]) => {
      const br = document.createElement('div');
      br.className = 'br';
      br.append(Object.assign(document.createElement('span'), { textContent: label }));
      br.append(Object.assign(document.createElement('b'), { textContent: String(counts[action]) }));
      box.append(br);
    });
  }
  syncDraftActions();
}

function currentOutput() {
  const value = state.artifacts?.[state.output];
  return state.output === 'last9' ? JSON.stringify(value, null, 2) : value || '';
}

function draftActionsReady() {
  if (!state.artifacts) return false;
  if (state.selected.size > 0) return true;
  return state.findings.length === 0 && state.output === 'markdown' && Boolean(state.artifacts.markdown);
}

function syncDraftActions() {
  const disabled = draftBusy || !draftActionsReady();
  for (const selector of ['#copy-output', '#download-output', '#toggle-config', '#modal-copy', '#modal-download']) {
    $(selector).disabled = disabled;
  }
  $('#analysis-empty-report').disabled = draftBusy || !state.artifacts?.markdown;
}

function renderOutput() {
  $('#output-code').textContent = currentOutput();
  $$('.fmt button').forEach((button) => {
    const active = button.dataset.output === state.output;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('#copy-output').textContent = copyLabels[state.output] || 'Copy config';
  syncDraftActions();
}

function renderLogLimitations(summary, countReported) {
  const limitations = [...(summary.limitations || [])].map((value) =>
    typeof value === 'string' ? value : value?.message || JSON.stringify(value));
  if (!countReported) limitations.unshift('The provider did not report the analyzed record count.');
  const panel = $('#log-limitations');
  const list = $('#log-limitations-list');
  list.replaceChildren();
  limitations.forEach((limitation) => {
    const item = document.createElement('li');
    item.textContent = limitation;
    list.append(item);
  });
  panel.hidden = limitations.length === 0;
  return limitations;
}

function renderAnalysis(data) {
  state.analysisId = data.analysisId;
  state.findings = data.findings;
  state.artifacts = data.artifacts;
  state.selected = new Set(data.artifacts.selectedIds); // smart defaults come from the server
  state.filter = 'all';
  const { summary } = data;
  $('#results-title').textContent = summary.service || 'Selected service';
  $('#results-scope').textContent = `${summary.environment || 'all environments'} · ${new Date(summary.timeWindow.start).toLocaleString()} – ${new Date(summary.timeWindow.end).toLocaleString()}`;
  const countReported = summary.recordsAnalyzed != null && Number.isFinite(Number(summary.recordsAnalyzed));
  const recordsAnalyzed = countReported ? Number(summary.recordsAnalyzed) : null;
  $('#records-total').textContent = countReported ? formatNumber(recordsAnalyzed) : '—';
  $('#records-total-label').textContent = countReported ? 'events scanned' : 'count not reported';
  const limitations = renderLogLimitations(summary, countReported);

  // Distinguish "no logs in this window" from "logs found, nothing to change".
  const hasChanges = state.findings.length > 0;
  const service = summary.service || 'this service';
  const emptyPanel = $('#analysis-empty');
  emptyPanel.hidden = hasChanges;
  $('.review-grid').hidden = !hasChanges;
  if (!hasChanges) {
    const noLogs = countReported && recordsAnalyzed === 0;
    const limitedCoverage = !countReported || limitations.length > 0;
    emptyPanel.classList.toggle('no-logs', noLogs);
    $('#analysis-empty-title').textContent = noLogs ? 'No logs found' : limitedCoverage ? 'No changes proposed' : 'Nothing to trim';
    $('#analysis-empty-copy').textContent = noLogs
      ? `No logs came back for ${service} in this window. Try a wider time window or a different scope.`
      : limitedCoverage
        ? `No changes were proposed for ${service}, but provider coverage was limited. Review the caveats before treating this scope as clean.`
        : `${service} produced no noisy or risky findings in this window.`;
    state.output = 'markdown';
  }

  renderChanges();
  renderSavings();
  renderOutput();
  $('#empty-state').hidden = true;
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
    button.setAttribute('role', 'tab');
    button.dataset.signalOutput = name;
    const active = name === state.signalOutput;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
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
  const controller = new AbortController();
  analysisAbort = controller;
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
    }, { signal: controller.signal });
    if (generation !== analysisGeneration || routeAtStart !== routeGeneration || requestedSignal !== state.signal) return;
    if (requestedSignal === 'logs') renderAnalysis(data);
    else renderSignalAnalysis(data);
    routeGeneration += 1;
    navigate(scopeRoute(`/results/${data.analysisId}`));
  } catch (error) {
    if (error.name === 'AbortError' || generation !== analysisGeneration || routeAtStart !== routeGeneration) return;
    $('#loading-state').hidden = true;
    $('#empty-state').hidden = false;
    toast(error.message);
  } finally {
    clearInterval(interval);
    if (generation === analysisGeneration) {
      analysisInFlight = false;
      analysisAbort = null;
      button.disabled = false;
      syncSignalControls();
    }
  }
}

// The draft is only safe to copy/download once it matches the current
// selection, so freeze those actions while a regeneration is in flight.
function setDraftBusy(busy) {
  draftBusy = busy;
  syncDraftActions();
}

function regenerate() {
  cancelRegeneration();
  const analysisId = state.analysisId;
  const signal = state.signal;
  if (signal !== 'logs' || !analysisId) return;
  const token = ++regenToken; // only the newest request may commit its result
  setDraftBusy(true);
  generationTimer = setTimeout(async () => {
    generationTimer = undefined;
    if (token !== regenToken || state.signal !== signal || state.analysisId !== analysisId) return;
    const selectedIds = [...state.selected];
    try {
      const { artifacts } = await api('/api/generate', { analysisId, selectedIds });
      if (token !== regenToken || state.signal !== signal || state.analysisId !== analysisId) return; // a newer toggle superseded this
      state.artifacts = artifacts;
      renderSavings();
      renderOutput();
      setDraftBusy(false);
    } catch (error) {
      if (token !== regenToken) return;
      // Resync the toggles to the artifacts we still hold so the UI never shows
      // "In config" rows paired with a draft that predates them.
      state.selected = new Set(state.artifacts ? state.artifacts.selectedIds : []);
      renderChanges();
      renderConfigBreakdown();
      setDraftBusy(false);
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
  state.selected = new Set();
  state.artifacts = null;
  state.signalArtifacts = null;
  closeDraftModal();
  $('#workbench-view').hidden = true;
  $('#connect-view').hidden = false;
  $('#analysis-results').hidden = true;
  $('#signal-results').hidden = true;
  $('#loading-state').hidden = true;
  $('#empty-state').hidden = false;
  syncDraftActions();
  document.title = 'Telemetry Diet';
  if (updateHistory) navigate('/');
}

async function restoreRoute() {
  if (analysisInFlight) cancelPendingAnalysis();
  closeDraftModal();
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
$('#go-home').addEventListener('click', reset);
window.addEventListener('popstate', restoreRoute);
$$('.fmt button').forEach((button) => button.addEventListener('click', () => {
  state.output = button.dataset.output;
  renderOutput();
}));
$$('#change-filters .chip').forEach((chip) => chip.addEventListener('click', () => {
  state.filter = chip.dataset.filter;
  applyChangeFilter();
}));
// View draft opens the full draft in a modal — a 300px config column is too
// cramped to read YAML/JSON. <dialog> gives us backdrop + Esc for free.
const draftModal = $('#draft-modal');
function openDraft() {
  if (!draftActionsReady() || draftBusy) return;
  renderOutput();
  if (typeof draftModal.showModal === 'function') draftModal.showModal();
  $('#draft-modal-close').focus();
}
$('#toggle-config').addEventListener('click', openDraft);
$('#analysis-empty-report').addEventListener('click', () => {
  state.output = 'markdown';
  openDraft();
});
$('#draft-modal-close').addEventListener('click', () => draftModal.close());
draftModal.addEventListener('click', (event) => { if (event.target === draftModal) draftModal.close(); });
(() => {
  const baseline = readBaseline();
  $('#ingest-gb').value = baseline.gb;
  $('#cost-gb').value = baseline.cost;
  const persist = () => {
    const stored = { gb: Number($('#ingest-gb').value), cost: Number($('#cost-gb').value) };
    try { localStorage.setItem(BASELINE_KEY, JSON.stringify(stored)); } catch { /* storage unavailable */ }
    if (state.signal === 'logs' && state.artifacts) renderSavings();
  };
  $('#ingest-gb').addEventListener('input', persist);
  $('#cost-gb').addEventListener('input', persist);
})();
async function copyDraft() {
  if (draftBusy || !draftActionsReady()) return;
  try {
    await navigator.clipboard.writeText(currentOutput());
    toast('Current draft copied.', true);
  } catch {
    toast('Clipboard access is unavailable in this browser.');
  }
}
function downloadDraft() {
  if (draftBusy || !draftActionsReady()) return;
  const meta = outputMeta[state.output];
  const url = URL.createObjectURL(new Blob([currentOutput()], { type: meta.type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = meta.filename;
  link.click();
  URL.revokeObjectURL(url);
}
$('#copy-output').addEventListener('click', copyDraft);
$('#download-output').addEventListener('click', downloadDraft);
$('#modal-copy').addEventListener('click', copyDraft);
$('#modal-download').addEventListener('click', downloadDraft);
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
