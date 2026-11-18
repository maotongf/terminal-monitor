import * as vscode from 'vscode';
import { CodexNotificationTransition, CodexTask, Task } from '../core/types';

export class Notifier {
  notifyTaskEnd(task: Task): void {
    const config = vscode.workspace.getConfiguration('terminalMonitor');
    const duration = (task.endTime ?? Date.now()) - task.startTime;
    if (task.status === 'completed' && config.get<boolean>('completionNotifications', true) && duration >= 30_000) {
      void vscode.window.showInformationMessage(`${task.terminalName}: ${task.name} completed.`);
    } else if (task.status === 'failed' && config.get<boolean>('failureNotifications', true)) {
      void vscode.window.showErrorMessage(`${task.terminalName}: ${task.name} failed (exit ${task.exitCode ?? 'unknown'}).`);
    }
  }

  notifyCodexTransition(task: CodexTask, transition: CodexNotificationTransition): void {
    const config = vscode.workspace.getConfiguration('terminalMonitor');
    const title = task.name || 'Codex 任务';
    if (transition === 'completed' && config.get<boolean>('codexCompletionNotifications', true)) {
      void vscode.window.showInformationMessage(`Codex：${title} 已完成。`);
    } else if (transition === 'failed' && config.get<boolean>('codexFailureNotifications', true)) {
      void vscode.window.showErrorMessage(`Codex：${title} 失败。`);
    } else if (transition === 'approval' && config.get<boolean>('codexApprovalNotifications', true)) {
      void vscode.window.showWarningMessage(`Codex：${title} 等待你批准操作。`);
    }
  }
}
