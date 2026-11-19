import * as vscode from 'vscode';
import { createId } from '../utils/idGenerator';
import { Task, TerminalInfo, TaskStatus } from './types';
import { detectTaskKind, displayNameForKind } from '../agents/agentDetector';
import { TerminalOutputStream } from '../utils/terminalOutputStream';

const OUTPUT_FLUSH_MS = 100;
const MAX_PENDING_OUTPUT_CHARS = 32_000;

export class TaskManager {
  private terminals = new Map<string, TerminalInfo>();
  private terminalIds = new WeakMap<vscode.Terminal, string>();
  private tasks = new Map<string, Task>();
  private history: Task[] = [];
  private outputStreams = new Map<string, TerminalOutputStream>();
  private pendingOutputs = new Map<string, { text: string; skipped: boolean; timer: ReturnType<typeof setTimeout> }>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  registerTerminal(terminal: vscode.Terminal): TerminalInfo {
    const existingId = this.terminalIds.get(terminal);
    if (existingId) {
      const existing = this.terminals.get(existingId);
      if (existing) return existing;
    }
    const info: TerminalInfo = {
      id: createId('terminal'), terminal, name: terminal.name,
      createdAt: Date.now(), cwd: terminal.shellIntegration?.cwd?.fsPath, shellIntegrationAvailable: !!terminal.shellIntegration
    };
    this.terminalIds.set(terminal, info.id);
    this.terminals.set(info.id, info);
    this.changeEmitter.fire();
    return info;
  }

  updateTerminalName(terminal: vscode.Terminal): void {
    const info = this.getTerminalInfo(terminal) ?? this.registerTerminal(terminal);
    if (info.name === terminal.name) return;
    info.name = terminal.name;
    const active = info.currentTaskId ? this.tasks.get(info.currentTaskId) : undefined;
    if (active) active.terminalName = terminal.name;
    for (const task of this.history) {
      if (task.terminalId === info.id) task.terminalName = terminal.name;
    }
    this.changeEmitter.fire();
  }

  setShellIntegration(terminal: vscode.Terminal, available: boolean, cwd?: string): void {
    const info = this.getTerminalInfo(terminal) ?? this.registerTerminal(terminal);
    info.shellIntegrationAvailable = available;
    if (cwd) info.cwd = cwd;
    this.changeEmitter.fire();
  }

  startTask(terminal: vscode.Terminal, command: string, cwd?: string): Task {
    const info = this.getTerminalInfo(terminal) ?? this.registerTerminal(terminal);
    if (info.currentTaskId) {
      const previous = this.tasks.get(info.currentTaskId);
      if (previous && (previous.status === 'running' || previous.status === 'quiet')) {
        this.finishTask(previous.id, undefined, 'unknown');
      }
    }
    const kind = detectTaskKind(command);
    const task: Task = {
      id: createId('task'), terminalId: info.id, terminalName: terminal.name,
      name: displayNameForKind(kind), command, cwd: cwd ?? info.cwd,
      type: kind, status: 'running', startTime: Date.now(),
      lastOutputTime: Date.now(), recentOutput: []
    };
    info.currentTaskId = task.id;
    this.tasks.set(task.id, task);
    this.changeEmitter.fire();
    return task;
  }

  appendOutput(taskId: string, chunk: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const pending = this.pendingOutputs.get(taskId);
    const tail = chunk.slice(-MAX_PENDING_OUTPUT_CHARS);
    const combined = (pending?.text ?? '') + tail;
    const skipped = (pending?.skipped ?? false) || chunk.length > MAX_PENDING_OUTPUT_CHARS || combined.length > MAX_PENDING_OUTPUT_CHARS;
    if (pending) {
      pending.text = combined.slice(-MAX_PENDING_OUTPUT_CHARS);
      pending.skipped = skipped;
    } else {
      const timer = setTimeout(() => this.flushPendingOutput(taskId), OUTPUT_FLUSH_MS);
      this.pendingOutputs.set(taskId, { text: combined, skipped, timer });
    }
    task.lastOutputTime = Date.now();
    if (task.status === 'quiet') {
      task.status = 'running';
      this.changeEmitter.fire();
    }
  }

  private flushPendingOutput(taskId: string, notify = true): void {
    const pendingOutputs = this.pendingOutputs;
    const pending = pendingOutputs?.get(taskId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingOutputs.delete(taskId);
    const task = this.tasks.get(taskId);
    if (!task) return;
    let stream = this.outputStreams.get(taskId);
    if (!stream) { stream = new TerminalOutputStream(); this.outputStreams.set(taskId, stream); }
    if (pending.skipped) stream.resetPartialLine();
    const lineLimit = vscode.workspace.getConfiguration('terminalMonitor').get<number>('outputLineLimit', 5);
    task.recentOutput = stream.push(pending.text, lineLimit);
    if (notify) this.changeEmitter.fire();
  }

  updateQuietStates(): void {
    const threshold = vscode.workspace.getConfiguration('terminalMonitor').get<number>('quietThresholdSeconds', 15) * 1000;
    const now = Date.now();
    let changed = false;
    for (const task of this.tasks.values()) {
      if (task.status === 'running' && task.lastOutputTime && now - task.lastOutputTime >= threshold) {
        task.status = 'quiet';
        changed = true;
      }
    }
    if (changed) this.changeEmitter.fire();
  }

  finishTask(taskId: string, exitCode?: number, forcedStatus?: TaskStatus): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    this.flushPendingOutput(taskId, false);
    const outputStream = this.outputStreams.get(taskId);
    if (outputStream) {
      const lineLimit = vscode.workspace.getConfiguration('terminalMonitor').get<number>('outputLineLimit', 5);
      task.recentOutput = outputStream.flush(lineLimit);
      this.outputStreams.delete(taskId);
    }
    task.endTime = Date.now();
    task.exitCode = exitCode;
    task.status = forcedStatus ?? (exitCode === undefined ? 'unknown' : exitCode === 0 ? 'completed' : 'failed');
    const info = this.terminals.get(task.terminalId);
    if (info?.currentTaskId === taskId) info.currentTaskId = undefined;
    this.tasks.delete(taskId);
    const historyLimit = vscode.workspace.getConfiguration('terminalMonitor').get<number>('historyLimit', 10);
    if (historyLimit > 0) {
      this.history.unshift(task);
      this.history = this.history.slice(0, historyLimit);
    }
    this.changeEmitter.fire();
    return task;
  }

  closeTerminal(terminal: vscode.Terminal): void {
    const info = this.getTerminalInfo(terminal);
    if (!info) return;
    if (info.currentTaskId) this.finishTask(info.currentTaskId, undefined, 'unknown');
    this.terminals.delete(info.id);
    this.changeEmitter.fire();
  }

  reconcileTerminals(liveTerminals: readonly vscode.Terminal[]): void {
    const live = new Set(liveTerminals);
    for (const info of this.terminals.values()) {
      if (!live.has(info.terminal)) this.closeTerminal(info.terminal);
    }
  }

  getTerminalInfo(terminal: vscode.Terminal): TerminalInfo | undefined {
    const id = this.terminalIds.get(terminal);
    return id ? this.terminals.get(id) : undefined;
  }

  getTask(taskId: string): Task | undefined { return this.tasks.get(taskId) ?? this.history.find(t => t.id === taskId); }
  getActiveTasks(): Task[] { return [...this.tasks.values()]; }
  getHistory(): Task[] { return [...this.history]; }
  getTerminalById(id: string): TerminalInfo | undefined { return this.terminals.get(id); }
  getTerminals(): TerminalInfo[] { return [...this.terminals.values()]; }

  dispose(): void {
    for (const pending of this.pendingOutputs.values()) clearTimeout(pending.timer);
    this.pendingOutputs.clear();
    this.changeEmitter.dispose();
  }
}
