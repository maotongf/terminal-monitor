import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodexTask, CodexTaskStatus } from '../core/types';
import { AppServerClient } from './appServerClient';

interface ThreadRow {
  id: string;
  name?: string | null;
  preview?: string | null;
  cwd?: string | null;
  source?: string;
  createdAt?: number | string;
  updatedAt?: number | string;
  status?: { type?: string; activeFlags?: string[] };
}

interface TurnItem {
  type?: string;
  status?: string;
}

interface TurnRow {
  status?: string;
  startedAt?: number | string;
  completedAt?: number | string;
  items?: Array<{ item?: TurnItem } | TurnItem>;
}

interface ListResult<T> {
  data?: T[];
}

const POLL_INTERVAL_MS = 3000;
const RECENT_WINDOW_MS = 60 * 60 * 1000;
const RECENT_TASK_LIMIT = 5;

export class CodexMonitor implements vscode.Disposable {
  private readonly client: AppServerClient;
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private available = false;
  private tasks: CodexTask[] = [];
  private lastSnapshot = '';
  private lastConnectionState: 'connected' | 'unavailable' | undefined;
  private onChange: () => void = () => undefined;

  constructor(private readonly diagnostic: (message: string) => void = () => undefined) {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    this.client = new AppServerClient(path.join(codexHome, 'app-server-control', 'app-server-control.sock'));
  }

  start(onChange: () => void): void {
    this.onChange = onChange;
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, POLL_INTERVAL_MS);
  }

  getTasks(): CodexTask[] { return this.tasks; }
  isAvailable(): boolean { return this.available; }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const folders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath).filter(Boolean) ?? [];
      const params: Record<string, unknown> = {
        limit: 100,
        sortKey: 'recency_at',
        sourceKinds: ['vscode', 'cli', 'exec']
      };
      if (folders.length) params.cwd = folders;

      const result = await this.client.request<ListResult<ThreadRow>>('thread/list', params);
      const rows = Array.isArray(result?.data) ? result.data : [];
      const now = Date.now();
      const activeRows = rows.filter(row => row.status?.type === 'active');
      const recentRows = rows
        .filter(row => row.status?.type !== 'active' && toTimestamp(row.updatedAt) >= now - RECENT_WINDOW_MS)
        .slice(0, RECENT_TASK_LIMIT);
      const selected = [...activeRows, ...recentRows];
      const tasks = await Promise.all(selected.map(row => this.readTask(row)));
      const filtered = tasks.filter((task): task is CodexTask => task !== undefined);
      filtered.sort((a, b) => {
        const activeDelta = Number(b.status === 'running' || b.status === 'waiting') - Number(a.status === 'running' || a.status === 'waiting');
        return activeDelta || b.updatedAt - a.updatedAt;
      });

      this.available = true;
      this.reportConnectionState('connected');
      this.updateTasks(filtered);
    } catch {
      this.available = false;
      this.reportConnectionState('unavailable');
      this.updateTasks([]);
    } finally {
      this.polling = false;
    }
  }

  private async readTask(thread: ThreadRow): Promise<CodexTask | undefined> {
    if (!thread.id) return undefined;

    let turn: TurnRow | undefined;
    try {
      const result = await this.client.request<ListResult<TurnRow>>('thread/turns/list', {
        threadId: thread.id,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'summary'
      });
      turn = result?.data?.[0];
    } catch {
      // Keep the thread visible from its runtime status if turn history is unavailable.
    }

    const now = Date.now();
    const updatedAt = toTimestamp(thread.updatedAt) || now;
    const flags = thread.status?.activeFlags ?? [];
    const status = taskStatus(thread.status?.type, turn?.status, flags);
    const startTime = toTimestamp(turn?.startedAt) || updatedAt || toTimestamp(thread.createdAt) || now;
    const endTime = toTimestamp(turn?.completedAt) || (status !== 'running' && status !== 'waiting' ? updatedAt : undefined);
    const name = thread.name?.trim() || thread.preview?.trim() || fallbackName(thread.source);

    return {
      id: thread.id,
      name: name.slice(0, 140),
      cwd: thread.cwd || undefined,
      source: thread.source || 'codex',
      status,
      startTime,
      endTime,
      updatedAt,
      currentStep: currentStep(status, flags, turn)
    };
  }

  private reportConnectionState(state: 'connected' | 'unavailable'): void {
    if (state === this.lastConnectionState) return;
    this.lastConnectionState = state;
    this.diagnostic(state === 'connected'
      ? 'Codex App Server connected; thread and turn status is available.'
      : 'Codex App Server is unavailable; terminal monitoring remains active.');
  }

  private updateTasks(tasks: CodexTask[]): void {
    const snapshot = JSON.stringify({ available: this.available, tasks });
    if (snapshot === this.lastSnapshot) return;
    this.lastSnapshot = snapshot;
    this.tasks = tasks;
    this.onChange();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.client.dispose();
  }
}

function taskStatus(runtimeStatus: string | undefined, turnStatus: string | undefined, flags: string[]): CodexTaskStatus {
  if (flags.some(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput' || flag === 'waitingOnExternalTool')) {
    return 'waiting';
  }
  switch (turnStatus) {
    case 'inProgress': return 'running';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'interrupted': return 'interrupted';
  }
  return runtimeStatus === 'active' ? 'running' : 'idle';
}

function currentStep(status: CodexTaskStatus, flags: string[], turn?: TurnRow): string | undefined {
  if (status === 'waiting') {
    if (flags.includes('waitingOnApproval')) return '等待你批准操作';
    if (flags.includes('waitingOnUserInput')) return '等待你的输入';
    return '等待外部工具';
  }
  if (status === 'completed') return '任务已完成';
  if (status === 'failed') return '任务执行失败';
  if (status === 'interrupted') return '任务已中断';
  if (status !== 'running') return undefined;

  const items = turn?.items ?? [];
  const last = items.length ? items[items.length - 1] : undefined;
  const item = last && 'item' in last ? last.item : last;
  switch (item?.type) {
    case 'commandExecution': return '正在运行命令';
    case 'fileChange': return '正在修改文件';
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'toolCall': return '正在调用工具';
    case 'webSearch': return '正在搜索资料';
    case 'reasoning': return '正在分析任务';
    case 'agentMessage': return '正在整理结果';
    case 'userMessage': return '正在分析任务';
    default: return 'Codex 正在处理任务';
  }
}

function toTimestamp(value: number | string | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 100_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') return numeric > 100_000_000_000 ? numeric : numeric * 1000;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function fallbackName(source: string | undefined): string {
  if (source === 'vscode') return 'Codex in VS Code';
  if (source === 'cli') return 'Codex CLI';
  return 'Codex task';
}
