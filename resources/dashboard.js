const vscode = acquireVsCodeApi();
let state = { active: [], idle: [], history: [], codex: [], codexAvailable: false };
let showTimer = null;
let hideTimer = null;
let activeTooltipTask = null;
let lastStateSnapshot = '';
const collapsedSections = new Set();
const $ = id => document.getElementById(id);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function duration(task) {
  const seconds = Math.max(0, Math.floor(((task.endTime || Date.now()) - task.startTime) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${String(remainder).padStart(2, '0')}s`;
}

function icon(task) {
  return ({ codex: '✳', claude: '◈', python: 'Py', shell: '⌘', agent: '✧', other: '›' })[task.type] || '›';
}

function label(status) {
  return ({ running: 'Active', waiting: 'Waiting', quiet: 'Quiet', idle: 'Idle', completed: 'Done', failed: 'Failed', interrupted: 'Stopped', unknown: 'Unknown' })[status] || 'Unknown';
}

function sourceLabel(source) {
  return ({ vscode: 'VS Code', cli: 'CLI', exec: 'CLI' })[source] || 'Codex';
}

function taskNode(task, history = false) {
  const el = document.createElement('div');
  el.className = 'task' + (history ? ' history' : '');
  el.tabIndex = 0;
  el.dataset.id = task.id;
  el.innerHTML = '<div class="icon">' + icon(task) + '</div><div class="main"><div class="top"><span class="name">' + esc(task.terminalName || task.name) + '</span></div><div class="sub">' + esc(task.cwd ? shortPath(task.cwd) : ('Terminal · ' + (task.name || 'Shell'))) + '</div></div><div class="right"><span class="status ' + esc(task.status) + '">' + label(task.status) + '</span><span class="duration" data-counting="' + (task.status === 'idle' || task.status === 'unknown' ? 'false' : 'true') + '" data-start="' + task.startTime + '" data-end="' + (task.endTime || '') + '">' + (task.status === 'idle' || task.status === 'unknown' ? '' : duration(task)) + '</span></div>';
  el.addEventListener('click', () => vscode.postMessage({ type: 'focusTerminal', terminalId: task.terminalId }));
  el.addEventListener('mouseenter', () => {
    clearTimeout(hideTimer);
    hideTimer = null;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      showTimer = null;
      const latestTask = [...state.active, ...state.idle, ...state.history].find(item => item.id === task.id) || task;
      const latestNode = [...document.querySelectorAll('.task')].find(item => item.dataset.id === task.id) || el;
      showTooltip(latestTask, latestNode);
    }, 400);
  });
  el.addEventListener('mouseleave', scheduleHideTooltip);
  el.addEventListener('focus', () => showTooltip(task, el));
  el.addEventListener('blur', scheduleHideTooltip);
  return el;
}

function codexNode(task) {
  const el = document.createElement('div');
  el.className = 'task codexTask';
  el.tabIndex = 0;
  el.dataset.id = task.id;
  el.title = task.terminalId ? 'Focus matching terminal' : 'Open terminal in task folder';
  el.innerHTML = '<div class="icon">✳</div><div class="main"><div class="top"><span class="name">' + esc(task.name || 'Codex') + '</span></div><div class="sub codexStep">' + esc(task.currentStep || sourceLabel(task.source)) + (task.cwd ? ' · ' + esc(shortPath(task.cwd)) : '') + '</div></div><div class="right"><span class="status ' + esc(task.status) + '">' + label(task.status) + '</span><span class="duration" data-counting="' + (task.status === 'running' || task.status === 'waiting' ? 'true' : 'false') + '" data-start="' + task.startTime + '" data-end="' + (task.endTime || '') + '">' + duration(task) + '</span></div>';
  el.addEventListener('click', () => vscode.postMessage({ type: 'focusCodexTask', terminalId: task.terminalId, source: task.source, cwd: task.cwd, name: task.name, status: task.status }));
  return el;
}

function shortPath(value) {
  const parts = String(value).split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : value;
}

function showTooltip(task, el) {
  clearTimeout(hideTimer);
  hideTimer = null;
  activeTooltipTask = task;
  const tip = $('tooltip');
  const rect = el.getBoundingClientRect();
  const lines = (task.recentOutput || []).slice(-5);
  tip.innerHTML = '<div class="tiphead"><span>' + esc(task.terminalName || task.name) + '</span><span class="status ' + esc(task.status) + '">' + label(task.status) + '</span></div><div class="tipmeta">' + esc(task.type) + ' · ' + esc(duration(task)) + '</div><div class="tiplabel">COMMAND</div><div class="command">' + esc(task.command || 'No command') + '</div><div class="tiplabel">FOLDER</div><div class="command">' + esc(task.cwd || 'Unavailable') + '</div><div class="tiplabel">RECENT OUTPUT · ' + (task.lastOutputTime ? esc(timeAgo(task.lastOutputTime)) : 'No output') + '</div><div class="logs">' + (lines.length ? lines.map(esc).join('\n') : 'No output yet') + '</div>' + (task.agentState ? '<div class="tipmeta">' + esc(task.agentState) + '</div>' : '');
  tip.classList.add('show');
  const width = Math.min(310, window.innerWidth - 24);
  let left = Math.min(rect.left, window.innerWidth - width - 8);
  left = Math.max(8, left);
  let top = rect.bottom + 5;
  if (top + tip.offsetHeight > window.innerHeight) top = Math.max(8, rect.top - tip.offsetHeight - 5);
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function scheduleHideTooltip() {
  clearTimeout(showTimer);
  showTimer = null;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    const tip = $('tooltip');
    if (!tip.matches(':hover') && !document.querySelector('.task:hover')) hideTooltip();
  }, 300);
}

function hideTooltip() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  showTimer = null;
  hideTimer = null;
  activeTooltipTask = null;
  $('tooltip').classList.remove('show');
}

function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}

function setSectionCollapsed(id, collapsed) {
  const button = document.querySelector(`[data-section-toggle="${id}"]`);
  const body = $(`${id}Content`);
  if (!button || !body) return;
  button.setAttribute('aria-expanded', String(!collapsed));
  body.hidden = collapsed;
  const chevron = button.querySelector('.chevron');
  if (chevron) chevron.textContent = collapsed ? '›' : '⌄';
}

function toggleSection(id) {
  const collapsed = !collapsedSections.has(id);
  if (collapsed) collapsedSections.add(id);
  else collapsedSections.delete(id);
  setSectionCollapsed(id, collapsed);
}

function render() {
  const hoveredId = document.querySelector('.task:hover')?.dataset.id;
  const tooltipId = activeTooltipTask?.id;
  const codex = state.codex || [];
  const active = state.active || [];
  const idle = state.idle || [];
  const history = state.history || [];
  const workingCodex = codex.filter(task => task.status === 'running' || task.status === 'waiting');

  $('running').textContent = active.filter(task => task.status === 'running').length + workingCodex.length;
  $('quiet').textContent = active.filter(task => task.status === 'quiet').length;
  $('failed').textContent = history.filter(task => task.status === 'failed').length + codex.filter(task => task.status === 'failed').length;

  $('codex').replaceChildren();
  codex.forEach(task => $('codex').appendChild(codexNode(task)));
  $('codexCount').textContent = `(${codex.length})`;
  if (!codex.length) $('codex').innerHTML = '<div class="empty">No Codex tasks</div>';
  $('codexHint').textContent = state.codexAvailable
    ? (workingCodex.length ? 'Live from Codex' : 'No active Codex work')
    : 'Codex status unavailable';

  $('active').replaceChildren();
  $('idle').replaceChildren();
  $('history').replaceChildren();
  active.forEach(task => $('active').appendChild(taskNode(task)));
  idle.forEach(task => $('idle').appendChild(taskNode(task)));
  history.slice(0, 5).forEach(task => $('history').appendChild(taskNode(task, true)));

  $('activeCount').textContent = `(${active.length})`;
  $('idleCount').textContent = `(${idle.length})`;
  $('historyCount').textContent = `(${Math.min(history.length, 5)})`;
  if (!active.length) $('active').innerHTML = '<div class="empty">No active terminals</div>';
  if (!idle.length) $('idle').innerHTML = '<div class="empty">No idle terminals</div>';
  if (!history.length) $('history').innerHTML = '<div class="empty">No recent activity</div>';
  $('summary').textContent = `${active.length + workingCodex.length} active · ${idle.length} idle`;

  const restoreId = tooltipId || (showTimer ? undefined : hoveredId);
  if (restoreId) {
    const task = [...active, ...idle, ...history].find(item => item.id === restoreId);
    const node = [...document.querySelectorAll('.task')].find(item => item.dataset.id === restoreId);
    if (task && node) showTooltip(task, node);
    else if (tooltipId) hideTooltip();
  }
}

window.addEventListener('error', event => vscode.postMessage({ type: 'webviewError', message: event.message || 'script error' }));
window.addEventListener('unhandledrejection', event => vscode.postMessage({ type: 'webviewError', message: String(event.reason || 'unhandled rejection') }));
window.addEventListener('message', event => {
  if (event.data?.type !== 'state') return;
  const snapshot = JSON.stringify(event.data);
  if (snapshot === lastStateSnapshot) return;
  lastStateSnapshot = snapshot;
  state = event.data;
  render();
  vscode.postMessage({ type: 'rendered', active: state.active?.length, idle: state.idle?.length, history: state.history?.length, codex: state.codex?.length });
});
window.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
document.querySelectorAll('[data-section-toggle]').forEach(button => {
  button.addEventListener('click', () => toggleSection(button.dataset.sectionToggle));
});
$('tooltip').addEventListener('mouseenter', () => { clearTimeout(hideTimer); hideTimer = null; });
$('tooltip').addEventListener('mouseleave', scheduleHideTooltip);
setInterval(() => {
  document.querySelectorAll('.duration[data-start][data-counting="true"]').forEach(element => {
    const start = Number(element.dataset.start);
    const end = Number(element.dataset.end) || Date.now();
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const remainder = seconds % 60;
    element.textContent = hours ? `${hours}h ${minutes}m` : `${minutes}m ${String(remainder).padStart(2, '0')}s`;
  });
}, 1000);
vscode.postMessage({ type: 'ready' });
