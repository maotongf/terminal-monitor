import * as vscode from 'vscode';
import { Task } from '../core/types';

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
}
