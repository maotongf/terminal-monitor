import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodexNotificationTransition, CodexTask, CodexTaskStatus } from '../core/types';
import { AppServerClient } from './appServerClient';
import { extractRecentReply } from './recentReply';

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
  id?: string;
  status?: string;
  startedAt?: number | string;
  completedAt?: number | string;
  items?: Array<{ item?: TurnItem } | TurnItem>;
}

interface ThreadItemRow {
  item?: {
    type?: string;
    phase?: string | null;
    text?: string | null;
    moderation?: { moderated?: boolean | null } | null;
  };
}

interface ListResult<T> {
  data?: T[];
  nextCursor?: string | null;
}

const POLL_INTERVAL_MS = 3000;
const IDLE_POLL_INTERVAL_MS = 10_000;
const MAX_POLL_BACKOFF_MS = 60_000;
const MAX_CONCURRENT_TURN_READS = 4;
const RECENT_TASK_CACHE_LIMIT = 100;
const RECENT_WINDOW_MS = 60 * 60 * 1000;
const RECENT_TASK_LIMIT = 5;
const RECENT_REPLY_LIMIT = 10;
const RECENT_REPLY_CACHE_LIMIT = 100;
const RECENT_REPLY_CACHE_TTL_MS = 60_000;
const EMPTY_REPLY_CACHE_TTL_MS = 2_000;

interface CachedRecentTask {
  fingerprint: string;
  task: CodexTask;
}

interface TaskReadResult {
  task?: CodexTask;
  turnReadSucceeded: boolean;
}

interface PollMetrics {
  threadListPages: number;
  activeThreads: number;
  recentThreads: number;
  recentCacheHits: number;
  turnRequests: number;
  turnReadFailures: number;
  turnReadsInFlight: number;
  maxConcurrentTurnReads: number;
}

export class CodexMonitor implements vscode.Disposable {
  private readonly client: AppServerClient;
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private refreshRequested = false;
  private polling = false;
  private failureCount = 0;
  private available = false;
  private lastSync?: number;
  private tasks: CodexTask[] = [];
  private lastSnapshot = '';
  private lastConnectionState: 'connected' | 'unavailable' | undefined;
  private lastPollMetricsSnapshot = '';
  private lastPollMetrics?: PollMetrics;
  private recentTaskCache = new Map<string, CachedRecentTask>();
  private scopeLabel?: string;
  private paginationIncomplete = false;
  private recentReplyCache = new Map<string, { expiresAt: number; reply?: string }>();
  private recentReplyRequests = new Map<string, Promise<string | undefined>>();
  private notificationStates = new Map<string, { status: CodexTaskStatus; waitingReason?: CodexTask['waitingReason'] }>();
  private notifiedCodexTransitions = new Set<string>();
  private notificationBaselineReady = false;
  private onChange: () => void = () => undefined;

  constructor(
    private readonly diagnostic: (message: string) => void = () => undefined,
    clientVersion = 'unknown',
    private readonly onCodexTransition?: (task: CodexTask, transition: CodexNotificationTransition) => void
  ) {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    this.client = new AppServerClient(path.join(codexHome, 'app-server-control', 'app-server-control.sock'), clientVersion);
  }

  start(onChange: () => void): void {
    this.onChange = onChange;
    if (this.started) return;
    this.started = true;
    void this.pollAndSchedule();
  }

  getTasks(): CodexTask[] { return this.tasks; }
  isAvailable(): boolean { return this.available; }
  getLastSync(): number | undefined { return this.lastSync; }
  getScopeLabel(): string { return this.scopeLabel ?? this.resolveScopeInfo().label; }
  getPaginationIncomplete(): boolean { return this.paginationIncomplete; }

  refresh(): void {
    if (!this.started) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.polling) {
      this.refreshRequested = true;
      return;
    }
    this.refreshRequested = false;
    void this.pollAndSchedule();
  }

  async getRecentReply(threadId: string, turnId: string): Promise<string | undefined> {
    if (!this.available || !turnId || !this.tasks.some(task => task.id === threadId && task.turnId === turnId)) return undefined;
    const key = `${threadId}:${turnId}`;
    const cached = this.recentReplyCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.reply;
    if (cached) this.recentReplyCache.delete(key);

    const pending = this.recentReplyRequests.get(key);
    if (pending) return pending;

    const request = this.fetchRecentReply(threadId, turnId, key);
    this.recentReplyRequests.set(key, request);
    try {
      return await request;
    } finally {
      this.recentReplyRequests.delete(key);
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const previousScopeLabel = this.scopeLabel;
    const previousPaginationIncomplete = this.paginationIncomplete;
    const metrics: PollMetrics = {
      threadListPages: 0, activeThreads: 0, recentThreads: 0, recentCacheHits: 0,
      turnRequests: 0, turnReadFailures: 0, turnReadsInFlight: 0, maxConcurrentTurnReads: 0
    };
    try {
      const scopeInfo = this.resolveScopeInfo();
      this.scopeLabel = scopeInfo.label;
      this.paginationIncomplete = false;
      const params: Record<string, unknown> = {
        limit: 100,
        sortKey: 'recency_at',
        sourceKinds: ['vscode', 'cli', 'exec']
      };
      if (scopeInfo.folders.length) params.cwd = scopeInfo.folders;

      const rows = await this.listAllThreads(params, metrics);
      const now = Date.now();
      const activeRows = rows.filter(row => row.status?.type === 'active');
      const recentRows = rows
        .filter(row => row.status?.type !== 'active' && toTimestamp(row.updatedAt) >= now - RECENT_WINDOW_MS)
        .slice(0, RECENT_TASK_LIMIT);
      metrics.activeThreads = activeRows.length;
      metrics.recentThreads = recentRows.length;

      const cachedTasks: CodexTask[] = [];
      const rowsToRead: Array<{ row: ThreadRow; isActive: boolean }> = activeRows.map(row => ({ row, isActive: true }));
      for (const row of recentRows) {
        const cached = this.getCachedRecentTask(row);
        if (cached) {
          metrics.recentCacheHits++;
          cachedTasks.push(cached);
        } else {
          rowsToRead.push({ row, isActive: false });
        }
      }

      const readTasks = await mapWithConcurrency(rowsToRead, MAX_CONCURRENT_TURN_READS, async ({ row, isActive }) => {
        metrics.turnRequests++;
        metrics.turnReadsInFlight++;
        metrics.maxConcurrentTurnReads = Math.max(metrics.maxConcurrentTurnReads, metrics.turnReadsInFlight);
        try {
          const result = await this.readTaskWithResult(row);
          if (!result.turnReadSucceeded) metrics.turnReadFailures++;
          if (result.task?.turnId && !isActive && result.turnReadSucceeded) this.cacheRecentTask(row, result.task);
          return result.task;
        } finally {
          metrics.turnReadsInFlight--;
        }
      });
      const filtered = [...cachedTasks, ...readTasks].filter((task): task is CodexTask => task !== undefined);
      filtered.sort((a, b) => {
        const activeDelta = Number(b.status === 'running' || b.status === 'waiting') - Number(a.status === 'running' || a.status === 'waiting');
        return activeDelta || b.updatedAt - a.updatedAt;
      });

      this.available = true;
      this.failureCount = 0;
      this.lastSync = Date.now();
      this.reportConnectionState('connected');
      this.updateTasks(filtered);
      this.reportPollMetrics(metrics, true);
    } catch {
      const connectionChanged = this.available;
      this.scopeLabel = this.resolveScopeInfo().label;
      const scopeChanged = previousScopeLabel !== undefined && previousScopeLabel !== this.scopeLabel;
      if (metrics.threadListPages > 1) this.paginationIncomplete = true;
      const paginationChanged = previousPaginationIncomplete !== this.paginationIncomplete;
      this.available = false;
      this.failureCount++;
      this.reportConnectionState('unavailable');
      if (connectionChanged || scopeChanged || paginationChanged) this.onChange();
      this.reportPollMetrics(metrics, false);
    } finally {
      this.polling = false;
    }
  }

  private async pollAndSchedule(): Promise<void> {
    if (!this.started) return;
    await this.poll();
    if (!this.started) return;
    if (this.refreshRequested) {
      this.refreshRequested = false;
      void this.pollAndSchedule();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pollAndSchedule();
    }, this.nextPollDelayMs());
  }

  private nextPollDelayMs(): number {
    if (this.available) return this.tasks.some(task => task.status === 'running' || task.status === 'waiting')
      ? POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
    return Math.min(POLL_INTERVAL_MS * (2 ** Math.max(1, this.failureCount)), MAX_POLL_BACKOFF_MS);
  }

  private resolveScopeInfo(): { folders: string[]; label: string } {
    const folders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath).filter(Boolean) ?? [];
    const configuredScope = vscode.workspace.getConfiguration('terminalMonitor').get<'workspace' | 'all'>('codexScope', 'workspace');
    if (!folders.length) return { folders: [], label: '全部会话 · 无工作区' };
    if (configuredScope === 'all') return { folders: [], label: '全部会话' };
    return { folders, label: '当前工作区' };
  }

  private async listAllThreads(params: Record<string, unknown>, metrics: PollMetrics): Promise<ThreadRow[]> {
    const rows: ThreadRow[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    while (true) {
      metrics.threadListPages++;
      const result = await this.client.request<ListResult<ThreadRow>>('thread/list', {
        ...params,
        ...(cursor ? { cursor } : {})
      });
      for (const row of Array.isArray(result?.data) ? result.data : []) {
        if (!row.id || seenIds.has(row.id)) continue;
        seenIds.add(row.id);
        rows.push(row);
      }

      const nextCursor = result?.nextCursor || undefined;
      if (!nextCursor) break;
      if (seenCursors.has(nextCursor)) {
        this.paginationIncomplete = true;
        this.diagnostic('Codex thread/list repeated a pagination cursor; some sessions may not be shown.');
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return rows;
  }

  private getCachedRecentTask(thread: ThreadRow): CodexTask | undefined {
    const fingerprint = recentThreadFingerprint(thread);
    if (!fingerprint) return undefined;
    const cached = this.recentTaskCache.get(thread.id);
    if (!cached || cached.fingerprint !== fingerprint) return undefined;
    this.recentTaskCache.delete(thread.id);
    this.recentTaskCache.set(thread.id, cached);
    return cached.task;
  }

  private cacheRecentTask(thread: ThreadRow, task: CodexTask): void {
    const fingerprint = recentThreadFingerprint(thread);
    if (!fingerprint) return;
    this.recentTaskCache.delete(thread.id);
    this.recentTaskCache.set(thread.id, { fingerprint, task });
    while (this.recentTaskCache.size > RECENT_TASK_CACHE_LIMIT) {
      const oldestId = this.recentTaskCache.keys().next().value;
      if (oldestId === undefined) break;
      this.recentTaskCache.delete(oldestId);
    }
  }

  private reportPollMetrics(metrics: PollMetrics, success: boolean): void {
    this.lastPollMetrics = { ...metrics };
    const snapshot = `${success}:${metrics.threadListPages}:${metrics.activeThreads}:${metrics.recentThreads}:${metrics.recentCacheHits}:${metrics.turnRequests}:${metrics.turnReadFailures}:${metrics.maxConcurrentTurnReads}`;
    if (snapshot === this.lastPollMetricsSnapshot) return;
    this.lastPollMetricsSnapshot = snapshot;
    this.diagnostic(
      `Codex poll ${success ? 'succeeded' : 'failed'}: threadListPages=${metrics.threadListPages}, active=${metrics.activeThreads}, ` +
      `recent=${metrics.recentThreads}, recentCacheHits=${metrics.recentCacheHits}, ` +
      `turnReads=${metrics.turnRequests}, turnReadFailures=${metrics.turnReadFailures}, ` +
      `peakTurnConcurrency=${metrics.maxConcurrentTurnReads}.`
    );
  }

  private async readTask(thread: ThreadRow): Promise<CodexTask | undefined> {
    return (await this.readTaskWithResult(thread)).task;
  }

  private async readTaskWithResult(thread: ThreadRow): Promise<TaskReadResult> {
    if (!thread.id) return { turnReadSucceeded: false };

    let turn: TurnRow | undefined;
    let turnReadSucceeded = false;
    try {
      const result = await this.client.request<ListResult<TurnRow>>('thread/turns/list', {
        threadId: thread.id,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'summary'
      });
      turn = result?.data?.[0];
      turnReadSucceeded = true;
    } catch {
      // Keep the thread visible from its runtime status if turn history is unavailable.
    }

    const now = Date.now();
    const updatedAt = toTimestamp(thread.updatedAt) || now;
    const flags = thread.status?.activeFlags ?? [];
    const status = taskStatus(thread.status?.type, turn?.status, flags);
    const startTime = toTimestamp(turn?.startedAt);
    const endTime = toTimestamp(turn?.completedAt) || (status !== 'running' && status !== 'waiting' ? updatedAt : undefined);
    const name = thread.name?.trim() || thread.preview?.trim() || fallbackName(thread.source);

    return { turnReadSucceeded, task: {
      id: thread.id,
      turnId: turn?.id,
      name: name.slice(0, 140),
      cwd: thread.cwd || undefined,
      source: thread.source || 'codex',
      status,
      waitingReason: flags.includes('waitingOnApproval') ? 'approval' : flags.includes('waitingOnUserInput') ? 'input' : flags.includes('waitingOnExternalTool') ? 'tool' : undefined,
      startTime,
      endTime,
      updatedAt,
      currentStep: currentStep(status, flags, turn)
    } };
  }

  private async fetchRecentReply(threadId: string, turnId: string, cacheKey: string): Promise<string | undefined> {
    let reply: string | undefined;
    try {
      const result = await this.client.request<ListResult<ThreadItemRow>>('thread/items/list', {
        threadId,
        turnId,
        limit: RECENT_REPLY_LIMIT,
        sortDirection: 'desc',
        deferOutput: { commandExecution: true, mcpToolCall: true }
      });
      reply = extractRecentReply(Array.isArray(result?.data) ? result.data : []);
    } catch {
      // Keep the hover compact when history is unavailable; the next hover may retry.
    }

    if (!this.tasks.some(task => task.id === threadId && task.turnId === turnId)) return undefined;
    this.recentReplyCache.delete(cacheKey);
    this.recentReplyCache.set(cacheKey, {
      reply,
      expiresAt: Date.now() + (reply ? RECENT_REPLY_CACHE_TTL_MS : EMPTY_REPLY_CACHE_TTL_MS)
    });
    while (this.recentReplyCache.size > RECENT_REPLY_CACHE_LIMIT) {
      const oldestKey = this.recentReplyCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.recentReplyCache.delete(oldestKey);
    }
    return reply;
  }

  private reportConnectionState(state: 'connected' | 'unavailable'): void {
    if (state === this.lastConnectionState) return;
    this.lastConnectionState = state;
    this.diagnostic(state === 'connected'
      ? 'Codex App Server connected; thread and turn status is available.'
      : 'Codex App Server is unavailable; terminal monitoring remains active.');
  }

  private updateTasks(tasks: CodexTask[]): void {
    this.trackCodexTransitions(tasks);
    const activeTurns = new Set(tasks.filter(task => task.turnId).map(task => `${task.id}:${task.turnId}`));
    for (const key of this.recentReplyCache.keys()) {
      if (!activeTurns.has(key)) this.recentReplyCache.delete(key);
    }
    const snapshot = JSON.stringify({ available: this.available, scope: this.getScopeLabel(), paginationIncomplete: this.paginationIncomplete, tasks });
    if (snapshot === this.lastSnapshot) return;
    this.lastSnapshot = snapshot;
    this.tasks = tasks;
    this.onChange();
  }

  private trackCodexTransitions(tasks: CodexTask[]): void {
    const currentKeys = new Set<string>();
    for (const task of tasks) {
      const key = JSON.stringify([task.id, task.turnId ?? '']);
      currentKeys.add(key);
      const previous = this.notificationStates.get(key);
      if (this.notificationBaselineReady && previous) {
        let transition: CodexNotificationTransition | undefined;
        if (task.status === 'completed' && previous.status !== 'completed') transition = 'completed';
        else if (task.status === 'failed' && previous.status !== 'failed') transition = 'failed';
        else if (task.status === 'waiting' && task.waitingReason === 'approval' &&
          !(previous.status === 'waiting' && previous.waitingReason === 'approval')) transition = 'approval';

        if (transition) {
          const notificationKey = `${key}\u0000${transition}`;
          if (!this.notifiedCodexTransitions.has(notificationKey)) {
            this.notifiedCodexTransitions.add(notificationKey);
            this.onCodexTransition?.(task, transition);
          }
        }
      }
      this.notificationStates.set(key, { status: task.status, waitingReason: task.waitingReason });
    }

    for (const key of this.notificationStates.keys()) {
      if (!currentKeys.has(key)) this.notificationStates.delete(key);
    }
    for (const key of this.notifiedCodexTransitions) {
      const turnKey = key.slice(0, key.lastIndexOf('\u0000'));
      if (!currentKeys.has(turnKey)) this.notifiedCodexTransitions.delete(key);
    }
    this.notificationBaselineReady = true;
  }

  dispose(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.client.dispose();
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, limit));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
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
  const normalized = items.map(entry => 'item' in entry ? entry.item : entry as TurnItem).filter((item): item is TurnItem => !!item);
  const item = [...normalized].reverse().find(entry => entry.status === 'inProgress' || entry.status === 'running');
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

function recentThreadFingerprint(thread: ThreadRow): string | undefined {
  const updatedAt = toTimestamp(thread.updatedAt);
  if (!thread.id || !updatedAt) return undefined;
  return JSON.stringify([
    updatedAt,
    thread.status?.type,
    [...(thread.status?.activeFlags ?? [])].sort(),
    thread.name,
    thread.preview,
    thread.cwd,
    thread.source
  ]);
}

function fallbackName(source: string | undefined): string {
  if (source === 'vscode') return 'Codex in VS Code';
  if (source === 'cli') return 'Codex CLI';
  return 'Codex task';
}
