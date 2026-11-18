import { TaskKind } from '../core/types';

export interface AgentAdapter {
  id: string;
  displayName: string;
  detect(commandLine: string): boolean;
  kind: TaskKind;
}
