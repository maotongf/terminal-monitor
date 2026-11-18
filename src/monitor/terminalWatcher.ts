import * as vscode from 'vscode';
import { TaskManager } from '../core/taskManager';
import { Task } from '../core/types';
import { Notifier } from '../notification/notifier';

export class TerminalWatcher implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private readers = new Map<string, Promise<void>>();
  private output = vscode.window.createOutputChannel('Terminal Monitor');
  private syncTimer?: ReturnType<typeof setInterval>;
  private lastSnapshot?: string;

  constructor(private readonly tasks: TaskManager, private readonly notifier: Notifier) {}

  start(): void {
    // Subscribe first so terminals opened during the initial scan are not missed.
    this.disposables.push(vscode.window.onDidOpenTerminal(terminal => {
      this.tasks.registerTerminal(terminal);
      this.syncTerminals('terminal-open');
    }));
    this.disposables.push(vscode.window.onDidCloseTerminal(terminal => {
      this.tasks.closeTerminal(terminal);
      this.syncTerminals('terminal-close');
    }));
    this.disposables.push(vscode.window.onDidChangeTerminalShellIntegration(event => {
      const cwd = event.shellIntegration.cwd?.fsPath;
      this.tasks.setShellIntegration(event.terminal, true, cwd);
      this.output.appendLine('Shell Integration became available for a terminal.');
    }));
    this.disposables.push(vscode.window.onDidStartTerminalShellExecution(event => {
      const command = event.execution.commandLine.value;
      const cwd = event.execution.cwd?.fsPath ?? event.terminal.shellIntegration?.cwd?.fsPath;
      const task = this.tasks.startTask(event.terminal, String(command), cwd);
      this.output.appendLine(`Command started: type=${task.type}.`);
      this.readOutput(event.execution, task);
    }));
    this.disposables.push(vscode.window.onDidEndTerminalShellExecution(async event => {
      const info = this.tasks.getTerminalInfo(event.terminal);
      const taskId = info?.currentTaskId;
      if (!taskId) return;
      // Drain any buffered output before moving the task into history.
      await this.readers.get(taskId);
      const task = this.tasks.finishTask(taskId, event.exitCode);
      if (task) {
        this.output.appendLine(`Command ended: type=${task.type}, exitCode=${event.exitCode ?? 'unknown'}.`);
        this.notifier.notifyTaskEnd(task);
      }
    }));

    this.output.appendLine(`Watcher started in ${vscode.env.remoteName ?? 'local'} extension host.`);
    this.syncTerminals('startup');
    this.syncTimer = setInterval(() => this.syncTerminals('poll'), 1000);
  }

  refresh(): number {
    return this.syncTerminals('manual-refresh');
  }

  logDashboard(message: string): void {
    this.output.appendLine(message);
  }

  private syncTerminals(reason: string): number {
    const terminals = vscode.window.terminals;
    let shellIntegrationCount = 0;

    for (const terminal of terminals) {
      const info = this.tasks.registerTerminal(terminal);
      this.tasks.updateTerminalName(terminal);
      const cwd = terminal.shellIntegration?.cwd?.fsPath;
      if (terminal.shellIntegration) {
        shellIntegrationCount++;
        if (!info.shellIntegrationAvailable || (cwd && info.cwd !== cwd)) {
          this.tasks.setShellIntegration(terminal, true, cwd);
        }
      }
    }

    const host = vscode.env.remoteName ?? 'local';
    const snapshot = `${host}:${terminals.length}:${shellIntegrationCount}`;
    if (snapshot !== this.lastSnapshot || reason === 'manual-refresh') {
      this.lastSnapshot = snapshot;
      this.output.appendLine(
        `${reason}: host=${host}, terminals=${terminals.length}, shellIntegration=${shellIntegrationCount}.`
      );
    }
    return terminals.length;
  }

  private readOutput(execution: vscode.TerminalShellExecution, task: Task): void {
    if (this.readers.has(task.id)) return;
    const reader = (async () => {
      try {
        for await (const chunk of execution.read()) {
          this.tasks.appendOutput(task.id, chunk);
        }
      } catch {
        // Some shells/interactive programs do not expose a readable execution stream.
      }
    })();
    this.readers.set(task.id, reader);
    void reader.finally(() => this.readers.delete(task.id));
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.output.dispose();
  }
}
