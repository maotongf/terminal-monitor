import * as vscode from 'vscode';

export type TaskStatus = 'running' | 'quiet' | 'idle' | 'completed' | 'failed' | 'unknown';
export type TaskKind = 'codex' | 'claude' | 'agent' | 'python' | 'shell' | 'other';

export interface TerminalInfo {
  id: string;
  terminal: vscode.Terminal;
  name: string;
  createdAt: number;
  cwd?: string;
  shellIntegrationAvailable: boolean;
  currentTaskId?: string;
}

export interface Task {
  id: string;
  terminalId: string;
  terminalName: string;
  name: string;
  command: string;
  cwd?: string;
  type: TaskKind;
  status: TaskStatus;
  startTime: number;
  endTime?: number;
  lastOutputTime?: number;
  exitCode?: number;
  recentOutput: string[];
  agentState?: string;
}

export interface DashboardTask {
  id: string;
  terminalId: string;
  terminalName: string;
  name: string;
  command: string;
  cwd?: string;
  type: TaskKind;
  status: TaskStatus;
  startTime: number;
  endTime?: number;
  lastOutputTime?: number;
  exitCode?: number;
  recentOutput: string[];
  agentState?: string;
  terminalOrder: number;
}

export type CodexTaskStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'idle';

export interface CodexTask {
  id: string;
  terminalId?: string;
  name: string;
  cwd?: string;
  source: string;
  status: CodexTaskStatus;
  waitingReason?: 'approval' | 'input' | 'tool';
  startTime: number;
  endTime?: number;
  updatedAt: number;
  currentStep?: string;
}
