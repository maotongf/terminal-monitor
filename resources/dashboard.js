const vscode = acquireVsCodeApi();
let state = { active: [], idle: [], history: [], codex: [], codexAvailable: false, codexLastSync: undefined };
let showTimer = null;
let hideTimer = null;
let activeTooltipTask = null;
let lastStateSnapshot = '';
const codexReplies = new Map();
const codexReplyRequestedAt = new Map();
const collapsedSections = new Set(vscode.getState()?.collapsedSections || []);
let showAllHistory = false;
const $ = id => document.getElementById(id);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function duration(task) {
  if (!task.startTime) return '';
  const seconds = Math.max(0, Math.floor(((task.endTime || Date.now()) - task.startTime) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}小时${minutes}分` : `${minutes}分${String(remainder).padStart(2, '0')}秒`;
}

function icon(task) {
  return ({ codex: '✳', claude: '◈', python: 'Py', shell: '⌘', agent: '✧', other: '›' })[task.type] || '›';
}

function label(status, task) {
  if (status === 'waiting' && task?.waitingReason === 'tool') return '等待工具';
  return ({ running: '进行中', waiting: '等待你', quiet: '暂无输出', idle: '空闲', completed: '已完成', failed: '失败', interrupted: '已中断', unknown: '未知' })[status] || '未知';
}

function sourceLabel(source) {
  return ({ vscode: 'VS Code', cli: '命令行', exec: '命令行' })[source] || 'Codex';
}

function taskNode(task, history = false, el) {
  const isNew = !el;
  if (!el) el = document.createElement('div');
  el.className = 'task' + (history ? ' history' : '');
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-describedby', 'tooltip');
  el.dataset.id = task.id;
  el._task = task;
  const stateClass = task.status === 'waiting' && task.waitingReason === 'tool' ? 'waitingTool' : task.status;
  el.innerHTML = '<div class="icon">' + icon(task) + '</div><div class="main"><div class="top"><span class="name">' + esc(task.terminalName || task.name) + '</span></div><div class="sub">' + esc(task.cwd ? shortPath(task.cwd) : ('终端 · ' + (task.name || 'Shell'))) + '</div></div><div class="right"><span class="status ' + esc(stateClass) + '">' + label(task.status, task) + '</span><span class="duration" data-counting="' + (task.status === 'idle' || task.status === 'unknown' ? 'false' : 'true') + '" data-start="' + task.startTime + '" data-end="' + (task.endTime || '') + '">' + (task.status === 'idle' || task.status === 'unknown' ? '' : duration(task)) + '</span></div>';
  if (isNew) {
    el.addEventListener('click', () => vscode.postMessage({ type: 'focusTerminal', terminalId: el._task.terminalId }));
    el.addEventListener('keydown', event => activateByKeyboard(event, el));
    attachTooltip(el);
  }
  return el;
}

function activateByKeyboard(event, el) {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); }
}

function latestTask(id, fallback) {
  const task = [...(state.codex || []), ...(state.active || []), ...(state.idle || []), ...(state.history || [])].find(item => item.id === id) || fallback;
  if (task && typeof task.source === 'string' && !task.recentReply) {
    const reply = codexReplies.get(codexReplyKey(task));
    if (reply) return { ...task, recentReply: reply };
  }
  return task;
}

function codexReplyKey(task) {
  return `${task.id}:${task.turnId || ''}`;
}

function requestCodexReply(task) {
  if (!task.turnId || task.recentReply || task.status === 'running' || task.status === 'waiting') return;
  const key = codexReplyKey(task);
  const now = Date.now();
  if (now - (codexReplyRequestedAt.get(key) || 0) < 3000) return;
  codexReplyRequestedAt.set(key, now);
  vscode.postMessage({ type: 'loadCodexReply', taskId: task.id, turnId: task.turnId });
}

function attachTooltip(el) {
  el.addEventListener('mouseenter', () => {
    clearTimeout(hideTimer);
    hideTimer = null;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      showTimer = null;
      const task = latestTask(el.dataset.id, el._task);
      showTooltip(task, el);
    }, 400);
  });
  el.addEventListener('mouseleave', scheduleHideTooltip);
  el.addEventListener('focus', () => showTooltip(latestTask(el.dataset.id, el._task), el));
  el.addEventListener('blur', scheduleHideTooltip);
 }

function codexNode(task, el) {
  const isNew = !el;
  if (!el) el = document.createElement('div');
  el.className = 'task codexTask' + (task.status === 'waiting' && task.waitingReason === 'tool' ? ' waitingToolRow' : '');
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-describedby', 'tooltip');
  el.dataset.id = task.id;
  el._task = task;
  const stateClass = task.status === 'waiting' && task.waitingReason === 'tool' ? 'waitingTool' : task.status;
  el.innerHTML = '<div class="icon">✳</div><div class="main"><div class="top"><span class="name">' + esc(task.name || 'Codex') + '</span></div><div class="sub codexStep">' + esc(task.currentStep || sourceLabel(task.source)) + (task.cwd ? ' · ' + esc(shortPath(task.cwd)) : '') + '</div></div><div class="right"><span class="status ' + esc(stateClass) + '">' + label(task.status, task) + '</span><span class="duration" data-counting="' + (task.status === 'running' || task.status === 'waiting' ? 'true' : 'false') + '" data-start="' + task.startTime + '" data-end="' + (task.endTime || '') + '">' + duration(task) + '</span></div>';
  if (isNew) {
    el.addEventListener('click', () => { const t=el._task; vscode.postMessage({ type: 'focusCodexTask', terminalId: t.terminalId, source: t.source, cwd: t.cwd, name: t.name, status: t.status }); });
    el.addEventListener('keydown', event => activateByKeyboard(event, el));
    el.addEventListener('contextmenu', event => { event.preventDefault(); vscode.postMessage({ type: 'bindCodexTerminal', taskId: el._task.id }); });
    attachTooltip(el);
  }
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
  const scrollTop = tip.scrollTop;
  const selection = captureTooltipSelection(tip);
  const rect = el.getBoundingClientRect();
  const isCodex = typeof task.source === 'string';
  if (isCodex) requestCodexReply(task);
  const title = isCodex ? task.name : (task.terminalName || task.name);
  const statusText = label(task.status, task);
  const elapsed = task.status === 'idle' || task.status === 'unknown' || !task.startTime ? '' : ' · <span class="tipDuration" data-start="' + task.startTime + '" data-end="' + (task.endTime || '') + '">' + esc(duration(task)) + '</span>';
  const header = '<div class="tiphead"><span style="overflow-wrap:anywhere">' + esc(title) + '</span></div>';
  const status = '<div class="tipmeta">' + esc(statusText) + elapsed + '</div>';
  let body = '';
  if (isCodex) {
    // These fields come from the Codex thread and turn response, not terminal output.
    if (task.currentStep) body += '<div style="margin-top:8px">' + esc(task.currentStep) + '</div>';
    if (task.recentReply) body += '<div class="tiplabel">最近回复</div><div class="logs reply">' + esc(task.recentReply) + '</div>';
    body += '<div class="tipmeta">Codex' + (task.updatedAt ? ' · 更新于 <span class="tipUpdated" data-updated="' + task.updatedAt + '">' + esc(timeAgo(task.updatedAt)) + '</span>' : '') + '</div>';
    body += '<div class="tipmeta">右键任务可更换关联终端</div>';
  } else {
    const lines = (task.recentOutput || []).filter(line => String(line).trim()).slice(-3);
    if (lines.length) body += '<div class="logs" style="margin-top:8px">' + esc(lines.join('\n').slice(-600)) + '</div>';
    else if (task.command) body += '<div class="command" style="margin-top:8px">' + esc(task.command.slice(0, 240)) + '</div>';
    if (task.exitCode !== undefined && task.exitCode !== 0) body += '<div class="tipmeta">退出码 ' + esc(task.exitCode) + '</div>';
  }
  const folder = task.cwd ? '<div class="tipmeta" title="' + esc(task.cwd) + '">' + esc(shortPath(task.cwd)) + '</div>' : '';
  tip.innerHTML = header + status + body + folder;
  tip.scrollTop = scrollTop;
  if (selection) restoreTooltipSelection(tip, selection);
  tip.classList.add('show');
  const width = Math.min(310, window.innerWidth - 24);
  let left = Math.min(rect.left, window.innerWidth - width - 8);
  left = Math.max(8, left);
  let top = rect.bottom + 5;
  if (top + tip.offsetHeight > window.innerHeight) top = Math.max(8, rect.top - tip.offsetHeight - 5);
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function captureTooltipSelection(root) {
  const selection = window.getSelection?.();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return undefined;
  const offset = (node, position) => {
    const range=document.createRange(); range.selectNodeContents(root); range.setEnd(node,position); return range.toString().length;
  };
  try { return { anchor:offset(selection.anchorNode,selection.anchorOffset), focus:offset(selection.focusNode,selection.focusOffset) }; }
  catch { return undefined; }
}

function restoreTooltipSelection(root, saved) {
  const position = target => {
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT); let node; let remaining=target; let last;
    while ((node=walker.nextNode())) { last=node; if (remaining<=node.textContent.length) return [node,remaining]; remaining-=node.textContent.length; }
    return last ? [last,last.textContent.length] : [root,0];
  };
  try {
    const selection=window.getSelection?.(); if(!selection)return;
    const [anchorNode,anchorOffset]=position(saved.anchor); const [focusNode,focusOffset]=position(saved.focus);
    selection.setBaseAndExtent(anchorNode,anchorOffset,focusNode,focusOffset);
  } catch { /* The selected text may have disappeared in the updated task output. */ }
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
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function updateConnectionStatus() {
  const connection = $('connectionStatus');
  if (!connection) return;
  connection.textContent = state.codexAvailable
    ? '已连接'
    : ((state.codex || []).length
      ? '连接中断 · ' + (state.codexLastSync ? '上次同步 ' + timeAgo(state.codexLastSync) : '显示上次数据')
      : 'Codex 未连接');
  connection.style.color = state.codexAvailable ? 'var(--green)' : 'var(--yellow)';
}

function setSectionCollapsed(id, collapsed) {
  const button = document.querySelector(`[data-section-toggle="${id}"]`);
  const body = $(`${id}Content`);
  if (!button || !body) return;
  button.setAttribute('aria-expanded', String(!collapsed));
  body.hidden = collapsed;
  const chevron = button.querySelector('.chevron');
  if (chevron) chevron.textContent = collapsed ? '›' : '⌄';
  vscode.setState({ ...(vscode.getState() || {}), collapsedSections: [...collapsedSections] });
}

function toggleSection(id) {
  const collapsed = !collapsedSections.has(id);
  if (collapsed) collapsedSections.add(id);
  else collapsedSections.delete(id);
  setSectionCollapsed(id, collapsed);
}

function updateList(id, items, createOrUpdate) {
  const container = $(id);
  const existing = new Map([...container.children].filter(node => node.dataset?.id).map(node => [node.dataset.id, node]));
  items.forEach((item, index) => {
    const node = createOrUpdate(item, existing.get(item.id));
    existing.delete(item.id);
    const atIndex = container.children[index];
    if (atIndex !== node) container.insertBefore(node, atIndex || null);
  });
  existing.forEach(node => node.remove());
  return container;
}

function render() {
  const focusedId = document.activeElement?.closest?.('.task')?.dataset.id;
  const hoveredId = document.querySelector('.task:hover')?.dataset.id;
  const tooltipId = activeTooltipTask?.id;
  const codex = state.codex || [];
  const active = state.active || [];
  const idle = state.idle || [];
  const history = state.history || [];
  const workingCodex = codex.filter(task => task.status === 'running' || task.status === 'waiting');
  updateConnectionStatus();

  $('running').textContent = active.filter(task => task.status === 'running' || task.status === 'quiet').length + codex.filter(task => task.status === 'running').length;
  $('waiting').textContent = codex.filter(task => task.status === 'waiting' && task.waitingReason !== 'tool').length;
  const terminalFailures = history.filter(task => task.status === 'failed');
  const duplicateCodexFailures = codex.filter(task => task.status === 'failed' && (task.source === 'cli' || task.source === 'exec') && task.terminalBindingConfidence >= 2 &&
    terminalFailures.some(terminalTask => terminalTask.terminalId === task.terminalId && Math.abs(terminalTask.startTime - task.startTime) <= 30_000)).length;
  $('failed').textContent = terminalFailures.length + codex.filter(task => task.status === 'failed').length - duplicateCodexFailures;

  updateList('codex', codex, codexNode);
  $('codexCount').textContent = `(${codex.length})`;
  if (!codex.length) $('codex').innerHTML = '<div class="empty">暂无 Codex 任务</div>';
  const codexStatusHint = state.codexAvailable
    ? (workingCodex.length ? '实时状态' : '暂无活动任务')
    : (codex.length ? '连接中断 · ' + (state.codexLastSync ? '上次同步 ' + timeAgo(state.codexLastSync) : '显示上次数据') : 'Codex 未连接');
  $('codexHint').textContent = (state.codexScope || '当前工作区') + ' · ' + codexStatusHint +
    (state.paginationIncomplete ? ' · 会话列表未完整加载' : '');

  updateList('active', active, (task, node) => taskNode(task, false, node));
  updateList('idle', idle, (task, node) => taskNode(task, false, node));
  const shownHistory = showAllHistory ? history : history.slice(0, 5);
  updateList('history', shownHistory, (task, node) => taskNode(task, true, node));

  $('activeCount').textContent = `(${active.length})`;
  $('idleCount').textContent = `(${idle.length})`;
  $('historyCount').textContent = `(${history.length})`;
  if (!active.length) $('active').innerHTML = '<div class="empty">没有活动终端</div>';
  if (!idle.length) $('idle').innerHTML = '<div class="empty">没有空闲终端</div>';
  if (!history.length) $('history').innerHTML = '<div class="empty">暂无最近任务</div>';
  $('historyMore').hidden = history.length <= 5;
  $('historyMore').textContent = showAllHistory ? '收起' : `查看更多（${history.length - 5}）`;
  $('summary').textContent = `${Number($('running').textContent)} 项进行中 · ${idle.length} 个空闲终端`;

  const restoreId = tooltipId || (showTimer ? undefined : hoveredId);
  if (focusedId) {
    const focused = [...document.querySelectorAll('.task')].find(item => item.dataset.id === focusedId);
    if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }
  if (restoreId) {
    const task = [...codex, ...active, ...idle, ...history].find(item => item.id === restoreId);
    const node = [...document.querySelectorAll('.task')].find(item => item.dataset.id === restoreId);
    if (task && node) showTooltip(task, node);
    else if (tooltipId) hideTooltip();
  }
}

window.addEventListener('error', event => vscode.postMessage({ type: 'webviewError', message: event.message || 'script error' }));
window.addEventListener('unhandledrejection', event => vscode.postMessage({ type: 'webviewError', message: String(event.reason || 'unhandled rejection') }));
window.addEventListener('message', event => {
  if (event.data?.type === 'codexReply') {
    const { taskId, turnId, reply } = event.data;
    const task = (state.codex || []).find(item => item.id === taskId && item.turnId === turnId);
    if (!task) return;
    const key = codexReplyKey(task);
    if (typeof reply === 'string' && reply.trim()) {
      codexReplies.set(key, reply);
      task.recentReply = reply;
    } else {
      codexReplies.delete(key);
      delete task.recentReply;
    }
    if (activeTooltipTask?.id === taskId) {
      const node = [...document.querySelectorAll('.task')].find(item => item.dataset.id === taskId);
      if (node) showTooltip(task, node);
    }
    return;
  }
  if (event.data?.type !== 'state') return;
  const snapshot = JSON.stringify({ ...event.data, codexLastSync: event.data.codexAvailable ? undefined : event.data.codexLastSync });
  if (snapshot === lastStateSnapshot) return;
  lastStateSnapshot = snapshot;
  state = event.data;
  const liveReplyKeys = new Set((state.codex || []).map(task => {
    const key = codexReplyKey(task);
    const reply = codexReplies.get(key);
    if (reply) task.recentReply = reply;
    return key;
  }));
  for (const key of codexReplies.keys()) if (!liveReplyKeys.has(key)) codexReplies.delete(key);
  for (const key of codexReplyRequestedAt.keys()) if (!liveReplyKeys.has(key)) codexReplyRequestedAt.delete(key);
  render();
  vscode.postMessage({ type: 'rendered', active: state.active?.length, idle: state.idle?.length, history: state.history?.length, codex: state.codex?.length });
});
window.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
document.querySelectorAll('[data-section-toggle]').forEach(button => {
  button.addEventListener('click', () => toggleSection(button.dataset.sectionToggle));
  const collapsed = collapsedSections.has(button.dataset.sectionToggle);
  setSectionCollapsed(button.dataset.sectionToggle, collapsed);
});
$('historyMore').addEventListener('click', () => { showAllHistory = !showAllHistory; render(); });
$('tooltip').addEventListener('mouseenter', () => { clearTimeout(hideTimer); hideTimer = null; });
$('tooltip').addEventListener('mouseleave', scheduleHideTooltip);
setInterval(() => {
  document.querySelectorAll('.duration[data-start][data-counting="true"]').forEach(element => {
    const start = Number(element.dataset.start);
    if (!start) { element.textContent = ''; return; }
    const end = Number(element.dataset.end) || Date.now();
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const remainder = seconds % 60;
    element.textContent = hours ? `${hours}小时${minutes}分` : `${minutes}分${String(remainder).padStart(2, '0')}秒`;
  });
  document.querySelectorAll('.tipDuration[data-start]').forEach(element => {
    const start=Number(element.dataset.start); const end=Number(element.dataset.end) || Date.now();
    const seconds=Math.max(0,Math.floor((end-start)/1000)); const hours=Math.floor(seconds/3600); const minutes=Math.floor(seconds%3600/60); const remainder=seconds%60;
    element.textContent=hours?`${hours}小时 ${minutes}分钟`:`${minutes}分${String(remainder).padStart(2,'0')}秒`;
  });
  document.querySelectorAll('.tipUpdated[data-updated]').forEach(element => { element.textContent=timeAgo(Number(element.dataset.updated)); });
  updateConnectionStatus();
}, 1000);
vscode.postMessage({ type: 'ready' });
