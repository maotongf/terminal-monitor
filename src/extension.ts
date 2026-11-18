import * as vscode from 'vscode';
import { TaskManager } from './core/taskManager';
import { TerminalWatcher } from './monitor/terminalWatcher';
import { Notifier } from './notification/notifier';
import { DashboardProvider } from './ui/dashboardProvider';
import { CodexMonitor } from './codex/codexMonitor';

export function activate(context: vscode.ExtensionContext): void {
  const taskManager = new TaskManager(context);
  const notifier = new Notifier();
  const watcher = new TerminalWatcher(taskManager, notifier);
  const codexMonitor = new CodexMonitor(
    message => watcher.logDashboard(message),
    context.extension.packageJSON.version,
    (task, transition) => notifier.notifyCodexTransition(task, transition)
  );
  watcher.start();

  const dashboard = new DashboardProvider(context, taskManager, codexMonitor, message => watcher.logDashboard(message));
  codexMonitor.start(() => dashboard.refresh());
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('terminalMonitor.dashboard', dashboard, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('terminalMonitor.refresh', () => {
      const count = watcher.refresh();
      dashboard.refresh();
      vscode.window.showInformationMessage(
        `Terminal Monitor found ${count} open terminal(s). See Output > Terminal Monitor for diagnostics.`
      );
    }),
    vscode.commands.registerCommand('terminalMonitor.show', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.terminalMonitor');
    }),
    { dispose: () => watcher.dispose() },
    { dispose: () => codexMonitor.dispose() },
    { dispose: () => dashboard.dispose() },
    { dispose: () => taskManager.dispose() },
    new vscode.Disposable(() => undefined)
  );

  const quietTimer = setInterval(() => taskManager.updateQuietStates(), 1000);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(quietTimer)));
}

export function deactivate(): void { /* resources are disposed through context.subscriptions */ }
