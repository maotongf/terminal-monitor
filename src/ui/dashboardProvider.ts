import * as vscode from 'vscode';
import * as path from 'node:path';
import { TaskManager } from '../core/taskManager';
import { CodexTask, CodexTerminalBindingReason, DashboardTask, Task, TerminalInfo } from '../core/types';
import { CodexMonitor } from '../codex/codexMonitor';

export class DashboardProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private visibilitySubscription?: vscode.Disposable;
  private changeSubscription: vscode.Disposable;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private terminalOrder = new Map<string, number>();
  private terminalActivity = new Map<string, number>();
  private readonly codexTerminalBindings = new Map<string, { id: string; confidence: number; reason: CodexTerminalBindingReason }>();
  private closedCodexTaskTurns = new Map<string, string>();
  private knownTerminalIds: Set<string>;
  private readonly historyFallbackTerminals = new Map<string, vscode.Terminal>();
  private activeTerminalSubscription: vscode.Disposable;
  private lastPostedStateSnapshot = '';
  private lastPostCounts = '';
  private lastRenderedSnapshot = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tasks: TaskManager,
    private readonly codex: CodexMonitor,
    private readonly diagnostic: (message: string) => void = () => undefined
  ) {
    this.knownTerminalIds = new Set(tasks.getTerminals().map(terminal => terminal.id));
    this.changeSubscription = tasks.onDidChange(() => {
      this.captureClosedTerminalTasks();
      this.schedulePostState();
    });
    this.recordActiveTerminal(vscode.window.activeTerminal);
    this.activeTerminalSubscription = vscode.window.onDidChangeActiveTerminal(terminal => this.recordActiveTerminal(terminal));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.visibilitySubscription?.dispose();
    this.view = view;
    this.visibilitySubscription = view.onDidChangeVisibility(() => {
      if (!view.visible) return;
      this.syncTerminalNames();
      this.postState();
    });
    this.diagnostic('Dashboard webview resolved.');
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'resources')]
    };
    view.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'focusTerminal' && typeof message.terminalId === 'string') {
        this.focusTerminal(message);
      } else if (message?.type === 'focusCodexTask') {
        await this.focusCodexTask(message);
      } else if (message?.type === 'loadCodexReply' && typeof message.taskId === 'string' && typeof message.turnId === 'string') {
        const reply = await this.codex.getRecentReply(message.taskId, message.turnId);
        if (this.view) {
          void this.view.webview.postMessage({ type: 'codexReply', taskId: message.taskId, turnId: message.turnId, reply: reply ?? null });
        }
      } else if (message?.type === 'bindCodexTerminal' && typeof message.taskId === 'string') {
        await this.chooseCodexTerminal(message.taskId);
      } else if (message?.type === 'ready' || message?.type === 'refresh') {
        this.diagnostic(`Dashboard message: ${message.type}.`);
        this.postState();
      } else if (message?.type === 'rendered') {
        const active = Number(message.active) || 0;
        const idle = Number(message.idle) || 0;
        const history = Number(message.history) || 0;
        const codex = Number(message.codex) || 0;
        const snapshot = `${active}:${idle}:${history}:${codex}`;
        if (snapshot !== this.lastRenderedSnapshot) {
          this.lastRenderedSnapshot = snapshot;
          this.diagnostic(`Dashboard rendered: codex=${codex}, active=${active}, idle=${idle}, recent=${history}.`);
        }
      } else if (message?.type === 'webviewError') {
        this.diagnostic(`Dashboard webview error: ${String(message.message || 'unknown error')}`);
      }
    }, undefined, this.context.subscriptions);
    view.webview.html = this.getHtml(view.webview);
    this.postState();
  }

  refresh(): void {
    this.postState();
  }

  private schedulePostState(): void {
    if (!this.view || !this.view.visible) return;
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => { this.renderTimer = undefined; this.postState(); }, 500);
  }

  private syncTerminalNames(): void {
    for (const terminal of vscode.window.terminals) this.tasks.updateTerminalName(terminal);
  }

  private postState(): void {
    const codexSnapshot = this.codex.getTasks();
    this.closedCodexTaskTurns ??= new Map();
    this.pruneClosedCodexTaskTurns(codexSnapshot);
    this.pruneStaleMappings(codexSnapshot);
    const view = this.view;
    if (!view || view.visible === false) return;
    const terminals = this.tasks.getTerminals();
    terminals.forEach((terminal, index) => this.terminalOrder.set(terminal.id, index));
    const codexTasks: CodexTask[] = codexSnapshot
      .filter(task => !this.closedCodexTaskTurns.has(task.id))
      .map(task => this.bindCodexTask(task));
    const trackedCliTerminals = new Set(codexTasks
      .filter(task => task.source === 'cli' && (task.status === 'running' || task.status === 'waiting') && task.terminalId &&
        (this.codexTerminalBindings.get(task.id)?.confidence ?? 0) >= 2)
      .map(task => task.terminalId as string));
    const active: DashboardTask[] = this.tasks.getActiveTasks()
      .filter(task => task.type !== 'codex' || !trackedCliTerminals.has(task.terminalId))
      .map(task => this.toDashboard(task));
    const history: DashboardTask[] = this.tasks.getHistory().map(task => this.toDashboard(task));
    const idle: DashboardTask[] = terminals
      .filter(t => !t.currentTaskId && !isHiddenTerminal(t))
      .map(t => ({
        id: `idle-${t.id}`, terminalId: t.id, terminalName: t.name,
        name: t.name, command: '', cwd: t.cwd, type: 'other', status: t.shellIntegrationAvailable ? 'idle' : 'unknown',
        startTime: t.createdAt, recentOutput: [], terminalOpen: true, terminalOrder: this.terminalOrder.get(t.id) ?? 0
      }));
    const order = (a: DashboardTask, b: DashboardTask) => a.terminalOrder - b.terminalOrder;
    active.sort(order);
    idle.sort(order);
    const codexAvailable = this.codex.isAvailable();
    const state = {
      type: 'state', active, idle, history, codex: codexTasks, codexAvailable,
      codexScope: this.codex.getScopeLabel?.() ?? '当前工作区',
      paginationIncomplete: this.codex.getPaginationIncomplete?.() ?? false,
      // Successful poll timestamps advance every few seconds without changing visible data.
      // The webview only needs this timestamp while disconnected.
      codexLastSync: codexAvailable ? undefined : this.codex.getLastSync()
    };
    const snapshot = JSON.stringify(state);
    if (snapshot === this.lastPostedStateSnapshot) return;
    this.lastPostedStateSnapshot = snapshot;
    const counts = `${active.length}:${idle.length}:${history.length}:${codexTasks.length}`;
    if (counts !== this.lastPostCounts) {
      this.lastPostCounts = counts;
      this.diagnostic(`Dashboard state queued: codex=${codexTasks.length}, active=${active.length}, idle=${idle.length}, recent=${history.length}.`);
    }
    void view.webview.postMessage(state).then(accepted => {
      if (!accepted) {
        if (this.lastPostedStateSnapshot === snapshot) this.lastPostedStateSnapshot = '';
        this.diagnostic('Dashboard state was not accepted by the webview.');
      }
    }, error => {
      if (this.lastPostedStateSnapshot === snapshot) this.lastPostedStateSnapshot = '';
      this.diagnostic(`Dashboard postMessage failed: ${String(error)}`);
    });
  }

  private toDashboard(task: Task): DashboardTask {
    const fallback = this.historyFallbackTerminals.get(task.id);
    const fallbackIsOpen = !!fallback && vscode.window.terminals.includes(fallback);
    if (fallback && !fallbackIsOpen) this.historyFallbackTerminals.delete(task.id);
    const fallbackInfo = fallbackIsOpen && fallback ? this.tasks.getTerminalInfo(fallback) : undefined;
    const terminalInfo = this.tasks.getTerminalById(task.terminalId);
    const terminalId = fallbackInfo?.id ?? task.terminalId;
    return {
      ...task,
      terminalId,
      terminalOpen: !!terminalInfo || fallbackIsOpen,
      terminalOrder: this.terminalOrder.get(terminalId) ?? 0
    };
  }

  private focusTerminal(message: Record<string, unknown>): void {
    const terminalId = typeof message.terminalId === 'string' ? message.terminalId : undefined;
    if (!terminalId) return;
    const info = this.tasks.getTerminalById(terminalId);
    if (info) {
      info.terminal.show(false);
      return;
    }

    const taskId = typeof message.taskId === 'string' ? message.taskId : undefined;
    const fallback = taskId ? this.historyFallbackTerminals.get(taskId) : undefined;
    if (fallback && vscode.window.terminals.includes(fallback)) {
      fallback.show(false);
      return;
    }

    const candidates = [...this.tasks.getHistory(), ...this.tasks.getActiveTasks()];
    const task = (taskId ? candidates.find(candidate => candidate.id === taskId) : undefined) ??
      candidates.find(candidate => candidate.terminalId === terminalId);
    if (task?.cwd) {
      const terminal = vscode.window.createTerminal({ name: `Recent · ${task.name}`.slice(0, 60), cwd: vscode.Uri.file(task.cwd) });
      this.historyFallbackTerminals.set(task.id, terminal);
      terminal.show(false);
    } else if (task) {
      void vscode.window.showInformationMessage('原终端已关闭，且没有可用的工作目录。');
    }
  }

  private pruneStaleMappings(codexTasks: CodexTask[]): void {
    const terminalIds = new Set(this.tasks.getTerminals().map(terminal => terminal.id));
    for (const terminalId of this.terminalOrder.keys()) {
      if (!terminalIds.has(terminalId)) this.terminalOrder.delete(terminalId);
    }
    for (const terminalId of this.terminalActivity.keys()) {
      if (!terminalIds.has(terminalId)) this.terminalActivity.delete(terminalId);
    }
    const codexTaskIds = new Set(codexTasks.map(task => task.id));
    for (const [taskId, binding] of this.codexTerminalBindings) {
      if (!codexTaskIds.has(taskId) || !terminalIds.has(binding.id)) this.codexTerminalBindings.delete(taskId);
    }
    const historyTaskIds = new Set(this.tasks.getHistory().map(task => task.id));
    const liveTerminals = new Set(vscode.window.terminals);
    for (const [taskId, terminal] of this.historyFallbackTerminals) {
      if (!historyTaskIds.has(taskId) || !liveTerminals.has(terminal)) this.historyFallbackTerminals.delete(taskId);
    }
  }

  private captureClosedTerminalTasks(): void {
    const liveTerminalIds = new Set(this.tasks.getTerminals().map(terminal => terminal.id));
    const closedTerminalIds = new Set([...this.knownTerminalIds].filter(id => !liveTerminalIds.has(id)));
    if (closedTerminalIds.size) {
      const codexTasks = new Map(this.codex.getTasks().map(task => [task.id, task] as const));
      for (const [taskId, binding] of this.codexTerminalBindings) {
        if (!closedTerminalIds.has(binding.id)) continue;
        const task = codexTasks.get(taskId);
        if (!task) continue;
        this.closedCodexTaskTurns.set(taskId, task.turnId ?? '');
        this.diagnostic(`Codex task hidden after its linked terminal closed: ${taskId.slice(0, 8)}.`);
      }
    }
    this.knownTerminalIds = liveTerminalIds;
  }

  private pruneClosedCodexTaskTurns(codexTasks: CodexTask[]): void {
    const currentTasks = new Map(codexTasks.map(task => [task.id, task] as const));
    for (const [taskId, closedTurnId] of this.closedCodexTaskTurns) {
      const task = currentTasks.get(taskId);
      if (!task || (task.turnId ?? '') !== closedTurnId) this.closedCodexTaskTurns.delete(taskId);
    }
  }

  private bindCodexTask(task: CodexTask): CodexTask {
    const binding = this.codexTerminalBindings.get(task.id);
    if (binding && !this.tasks.getTerminalById(binding.id)) this.codexTerminalBindings.delete(task.id);

    const openMatches = this.tasks.getTerminals().filter(terminal => !task.cwd || samePath(terminal.cwd, task.cwd));
    const nameMatches = openMatches.filter(terminal => terminalNameMatches(task.name, terminal.name));
    if (nameMatches.length === 1) return this.bindTerminal(task, nameMatches[0].id, 2, 'titleAndFolder');

    if (binding && this.tasks.getTerminalById(binding.id)) {
      return { ...task, terminalId: binding.id, terminalBindingConfidence: binding.confidence, terminalBindingReason: binding.reason };
    }

    const isCliTask = !!task.cwd && (task.source === 'cli' || task.source === 'exec');
    const matching = isCliTask
      ? [...this.tasks.getActiveTasks(), ...this.tasks.getHistory()].filter(candidate =>
        candidate.type === 'codex' && samePath(candidate.cwd, task.cwd))
      : [];
    const terminalIds = [...new Set(matching.map(candidate => candidate.terminalId))];

    let terminalId = terminalIds.length === 1 ? terminalIds[0] : undefined;
    let reason: CodexTerminalBindingReason | undefined = terminalId ? 'relatedTask' : undefined;
    if (!terminalId && terminalIds.length > 1 && task.startTime) {
      const byStartTime = matching
        .filter(candidate => terminalIds.includes(candidate.terminalId))
        .sort((left, right) => Math.abs(left.startTime - task.startTime) - Math.abs(right.startTime - task.startTime));
      const first = byStartTime[0];
      const second = byStartTime.find(candidate => candidate.terminalId !== first?.terminalId);
      if (first && (!second || Math.abs(first.startTime - task.startTime) + 2_000 < Math.abs(second.startTime - task.startTime))) {
        terminalId = first.terminalId;
        reason = 'relatedTask';
      }
    }

    if (!terminalId && openMatches.length) {
      terminalId = this.preferredTerminal(nameMatches.length ? nameMatches : openMatches)?.id;
      if (terminalId) reason = 'recentActivity';
    }

    if (!terminalId) return task;
    const confidence = task.startTime && matching.some(candidate => candidate.terminalId === terminalId &&
      Math.abs(candidate.startTime - task.startTime) <= 30_000) ? 2 : 1;
    return this.bindTerminal(task, terminalId, confidence, reason ?? 'recentActivity');
  }

  private bindTerminal(task: CodexTask, terminalId: string, confidence: number, reason: CodexTerminalBindingReason): CodexTask {
    const existing = this.codexTerminalBindings.get(task.id);
    if (existing && existing.confidence >= confidence && this.tasks.getTerminalById(existing.id)) {
      return { ...task, terminalId: existing.id, terminalBindingConfidence: existing.confidence, terminalBindingReason: existing.reason };
    }
    this.codexTerminalBindings.set(task.id, { id: terminalId, confidence, reason });
    return { ...task, terminalId, terminalBindingConfidence: confidence, terminalBindingReason: reason };
  }

  private async focusCodexTask(message: Record<string, unknown>): Promise<void> {
    const taskId = typeof message.taskId === 'string' ? message.taskId : undefined;
    if (taskId && this.closedCodexTaskTurns.has(taskId)) return;

    const directId = typeof message.terminalId === 'string' ? message.terminalId : undefined;
    const direct = directId ? this.tasks.getTerminalById(directId) : undefined;
    if (direct) {
      direct.terminal.show(false);
      return;
    }

    const cwd = typeof message.cwd === 'string' ? message.cwd : undefined;
    const source = typeof message.source === 'string' ? message.source : '';
    const name = typeof message.name === 'string' ? message.name : '';
    const candidates = new Map<string, TerminalInfo>();
    for (const terminal of this.tasks.getTerminals()) {
      if (name && terminalNameMatches(name, terminal.name) && (!cwd || samePath(terminal.cwd, cwd))) {
        candidates.set(terminal.id, terminal);
      }
    }
    if (cwd && (source === 'cli' || source === 'exec')) {
      for (const task of [...this.tasks.getActiveTasks(), ...this.tasks.getHistory()]) {
        if (task.type !== 'codex' || !samePath(task.cwd, cwd)) continue;
        const terminal = this.tasks.getTerminalById(task.terminalId);
        if (terminal) candidates.set(terminal.id, terminal);
      }
    }
    if (cwd && !candidates.size) {
      for (const terminal of this.tasks.getTerminals()) {
        if (samePath(terminal.cwd, cwd)) candidates.set(terminal.id, terminal);
      }
    }

    if (candidates.size === 1) {
      candidates.values().next().value?.terminal.show(false);
      return;
    }
    if (candidates.size > 1) {
      this.preferredTerminal([...candidates.values()])?.terminal.show(false);
      return;
    }

    if (!cwd && this.tasks.getTerminals().length) {
      const active = this.preferredTerminal(this.tasks.getTerminals());
      active?.terminal.show(false);
      return;
    }

    const taskName = typeof message.name === 'string' && message.name.trim() ? message.name.trim() : 'Codex task';
    const options: vscode.TerminalOptions = { name: `Codex · ${taskName}`.slice(0, 60) };
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (cwd) options.cwd = vscode.Uri.file(cwd);
    else if (workspace) options.cwd = workspace.uri;
    const terminal = vscode.window.createTerminal(options);
    terminal.show();
  }

  private async chooseCodexTerminal(taskId: string): Promise<void> {
    const task = this.codex.getTasks().find(candidate => candidate.id === taskId);
    if (!task) return;
    const choices = this.tasks.getTerminals().map(terminal => ({
      label: terminal.name, description: terminal.cwd, terminal
    }));
    const selected = await vscode.window.showQuickPick(choices, { placeHolder: '选择此 Codex 任务对应的终端' });
    if (!selected) return;
    this.codexTerminalBindings.set(taskId, { id: selected.terminal.id, confidence: 3, reason: 'manual' });
    selected.terminal.terminal.show(false);
    this.postState();
  }

  private recordActiveTerminal(terminal?: vscode.Terminal): void {
    if (!terminal) return;
    const info = this.tasks.getTerminalInfo(terminal) ?? this.tasks.registerTerminal(terminal);
    this.terminalActivity.set(info.id, Date.now());
  }

  private preferredTerminal(candidates: TerminalInfo[]): TerminalInfo | undefined {
    const active = vscode.window.activeTerminal;
    const activeInfo = active ? this.tasks.getTerminalInfo(active) : undefined;
    if (activeInfo && candidates.some(candidate => candidate.id === activeInfo.id)) return activeInfo;
    return [...candidates].sort((left, right) => {
      const leftActivity = this.terminalActivity.get(left.id) ?? left.createdAt;
      const rightActivity = this.terminalActivity.get(right.id) ?? right.createdAt;
      return rightActivity - leftActivity || (this.terminalOrder.get(right.id) ?? 0) - (this.terminalOrder.get(left.id) ?? 0);
    })[0];
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'dashboard.js'));
    const copyUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'copy.zh-CN.js'));
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
<title>Terminal Monitor</title>
<style>
:root{color-scheme:light dark;--line:var(--vscode-widget-border);--muted:var(--vscode-descriptionForeground);--card:var(--vscode-editorWidget-background);--green:var(--vscode-testing-iconPassed,#3fb950);--yellow:var(--vscode-editorWarning-foreground,#d9a441);--red:var(--vscode-errorForeground,#f14c4c);--blue:var(--vscode-textLink-foreground)}
*{box-sizing:border-box}body{padding:8px 9px 14px;margin:0;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);background:var(--vscode-sideBar-background)}
.header{display:flex;align-items:center;justify-content:space-between;margin:2px 2px 11px}.brand{font-size:13px;font-weight:650}.live{font-size:10px;color:var(--green);display:flex;align-items:center;gap:5px}.dot{width:6px;height:6px;border-radius:50%;background:var(--green)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:12px}.stat{padding:8px 9px;border:1px solid var(--line);border-radius:12px;background:var(--card)}.num{font-size:16px;font-weight:650;line-height:1.2}.label{font-size:10px;color:var(--muted);margin-top:3px}
.sectionGroup{margin-top:9px;border:1px solid var(--line);border-radius:12px;background:var(--card);overflow:hidden;box-shadow:0 1px 2px #0001}.sectionToggle{width:100%;display:flex;align-items:center;justify-content:space-between;padding:10px 11px;border:0;background:transparent;color:var(--vscode-foreground);font:inherit;font-size:11px;font-weight:650;text-align:left;cursor:pointer}.sectionToggle:hover{background:var(--vscode-list-hoverBackground)}.sectionToggle:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-2px}.sectionTitle{display:flex;align-items:center;gap:6px}.count{color:var(--muted);font-weight:500}.chevron{font-size:16px;line-height:12px;color:var(--muted)}.sectionContent{padding:0 5px 4px}.sectionHint{padding:0 8px 5px;font-size:10px;color:var(--muted)}
.task{position:relative;display:flex;align-items:center;gap:9px;padding:8px 6px;border-bottom:1px solid var(--line);min-height:48px;cursor:pointer;transition:background .12s ease}.task:last-child{border-bottom:0}.task:hover{background:var(--vscode-list-hoverBackground)}.icon{width:29px;height:29px;flex:0 0 29px;display:flex;align-items:center;justify-content:center;border-radius:9px;background:var(--vscode-toolbar-hoverBackground);font-size:14px}.main{min-width:0;flex:1}.top{display:flex;align-items:center;gap:6px;min-width:0}.name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.sub{font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}.right{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:0 0 auto}.status{font-size:9px;padding:3px 7px;border-radius:20px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);white-space:nowrap}.status.running{color:var(--green)}.status.waiting,.status.quiet{color:var(--yellow)}.status.failed{color:var(--red)}.status.completed{color:var(--blue)}.status.interrupted{color:var(--muted)}.duration{font-size:9px;color:var(--muted);font-variant-numeric:tabular-nums}.empty{color:var(--muted);font-size:11px;text-align:center;padding:13px 8px}.history{opacity:.86}.history .icon{font-size:12px}.codexTask{min-height:52px}.codexStep{color:var(--vscode-foreground)}.task:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-2px}
.tooltip{position:fixed;z-index:10;display:none;width:min(310px,calc(100vw - 24px));max-height:260px;overflow:auto;padding:11px 12px;border:1px solid var(--line);border-radius:13px;background:var(--vscode-editorWidget-background);box-shadow:0 8px 26px #0003;pointer-events:auto}.tooltip.show{display:block}.tiphead{display:flex;justify-content:space-between;align-items:center;gap:8px;font-weight:650}.tipmeta{color:var(--muted);font-size:10px;margin-top:6px;overflow-wrap:anywhere}.tiplabel{font-size:10px;color:var(--muted);margin:10px 0 4px}.logs{font-family:var(--vscode-editor-font-family,monospace);font-size:10px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45;background:var(--vscode-textCodeBlock-background);padding:7px;border-radius:8px;max-height:90px;overflow:auto}.logs.reply{max-height:110px}.command{font-family:var(--vscode-editor-font-family,monospace);font-size:10px;overflow-wrap:anywhere}
/* Quiet, theme-aware status colors: color is paired with a localized label. */
:root{--state-running:var(--vscode-charts-blue,#4c9be8);--state-done:var(--vscode-testing-iconPassed,#3fb950);--state-waiting:var(--vscode-editorWarning-foreground,#d9a441);--state-tool:var(--vscode-charts-purple,#b180d7);--state-failed:var(--vscode-errorForeground,#f14c4c);--state-muted:var(--vscode-descriptionForeground,#8b949e)}
.status{border:1px solid color-mix(in srgb,var(--vscode-foreground) 12%,transparent);background:var(--vscode-editorWidget-background)}.status.running{color:var(--state-running);border-color:color-mix(in srgb,var(--state-running) 40%,transparent);background:color-mix(in srgb,var(--state-running) 12%,var(--vscode-editorWidget-background))}.status.completed{color:var(--state-done);border-color:color-mix(in srgb,var(--state-done) 40%,transparent);background:color-mix(in srgb,var(--state-done) 12%,var(--vscode-editorWidget-background))}.status.waiting{color:var(--state-waiting);border-color:color-mix(in srgb,var(--state-waiting) 45%,transparent);background:color-mix(in srgb,var(--state-waiting) 12%,var(--vscode-editorWidget-background))}.status.waitingTool{color:var(--state-tool);border-color:color-mix(in srgb,var(--state-tool) 40%,transparent);background:color-mix(in srgb,var(--state-tool) 12%,var(--vscode-editorWidget-background))}.status.failed{color:var(--state-failed);border-color:color-mix(in srgb,var(--state-failed) 40%,transparent);background:color-mix(in srgb,var(--state-failed) 12%,var(--vscode-editorWidget-background))}.status.quiet,.status.idle,.status.unknown,.status.interrupted{color:var(--state-muted)}.status:focus-visible,.task:focus-visible,.sectionToggle:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
.stat.runningStat .num{color:var(--state-running)}.stat.waitingStat .num{color:var(--state-waiting)}.stat.failedStat .num{color:var(--state-failed)}.task{transition:background .12s ease,border-color .12s ease}.task:hover{border-radius:8px}.moreButton{width:100%;padding:7px;border:0;background:transparent;color:var(--vscode-textLink-foreground);font:inherit;font-size:10px;cursor:pointer}.moreButton:hover{text-decoration:underline}.footer{display:flex;justify-content:space-between;padding:10px 3px 2px;color:var(--muted);font-size:10px}
@media(max-width:300px){body{padding:6px}.stats{gap:4px}.stat{padding:6px}.label{font-size:9px}.task{gap:6px;padding-inline:4px}.icon{width:25px;height:25px;flex-basis:25px}.status{font-size:8px;padding:2px 5px}.right{max-width:78px}}
</style></head><body>
<div class="header"><div id="brand" class="brand" data-copy="brand"></div><div class="live" id="connectionStatus"></div></div>
<div class="stats"><div class="stat runningStat"><div class="num" id="running">0</div><div class="label" data-copy="running"></div></div><div class="stat waitingStat"><div class="num" id="waiting">0</div><div class="label" data-copy="waiting"></div></div><div class="stat failedStat"><div class="num" id="failed">0</div><div class="label" data-copy="failed" id="failedLabel"></div></div></div>
<section class="sectionGroup"><button class="sectionToggle" type="button" data-section-toggle="codex" aria-expanded="true" aria-controls="codexContent"><span class="sectionTitle"><span data-copy="codex"></span> <span class="count" id="codexCount">(0)</span></span><span class="chevron">⌄</span></button><div class="sectionContent" id="codexContent"><div class="sectionHint" id="codexHint"></div><div id="codex"></div></div></section>
<section class="sectionGroup"><button class="sectionToggle" type="button" data-section-toggle="active" aria-expanded="true" aria-controls="activeContent"><span class="sectionTitle"><span data-copy="active"></span> <span class="count" id="activeCount">(0)</span></span><span class="chevron">⌄</span></button><div class="sectionContent" id="activeContent"><div id="active"></div></div></section>
<section class="sectionGroup"><button class="sectionToggle" type="button" data-section-toggle="idle" aria-expanded="true" aria-controls="idleContent"><span class="sectionTitle"><span data-copy="idle"></span> <span class="count" id="idleCount">(0)</span></span><span class="chevron">⌄</span></button><div class="sectionContent" id="idleContent"><div id="idle"></div></div></section>
<section class="sectionGroup"><button class="sectionToggle" type="button" data-section-toggle="history" aria-expanded="true" aria-controls="historyContent"><span class="sectionTitle"><span data-copy="history"></span> <span class="count" id="historyCount">(0)</span></span><span class="chevron">⌄</span></button><div class="sectionContent" id="historyContent"><div id="history"></div><button class="moreButton" id="historyMore" hidden></button></div></section>
<div class="footer"><span id="summary"></span><span id="syncLabel" data-copy="autoSync"></span></div><div id="tooltip" class="tooltip" role="tooltip"></div>
<script nonce="${nonce}" src="${copyUri}"></script><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
  }

  dispose(): void {
    this.changeSubscription.dispose();
    this.activeTerminalSubscription.dispose();
    this.visibilitySubscription?.dispose();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.historyFallbackTerminals.clear();
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function samePath(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function terminalNameMatches(taskName: string, terminalName: string): boolean {
  const name = taskName.trim().toLocaleLowerCase();
  const terminal = terminalName.trim().toLocaleLowerCase();
  const genericNames = new Set(['codex', 'codex cli', 'codex task', 'codex in vs code']);
  return name.length >= 5 && !genericNames.has(name) && terminal.includes(name);
}

function isHiddenTerminal(info: TerminalInfo): boolean {
  const options = info.terminal.creationOptions;
  return !!options && 'hideFromUser' in options && options.hideFromUser === true;
}
