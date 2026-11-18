import { AgentAdapter } from './agentAdapter';
import { TaskKind } from '../core/types';

const adapters: AgentAdapter[] = [
  { id: 'codex', displayName: 'Codex', kind: 'codex', detect: c => /(^|[\\/\s])codex(?:\.exe)?(?:\s|$)/i.test(c) },
  { id: 'claude', displayName: 'Claude Code', kind: 'claude', detect: c => /(^|[\\/\s])claude(?:\.exe)?(?:\s|$)/i.test(c) },
  { id: 'python', displayName: 'Python', kind: 'python', detect: c => /(^|[\\/\s])(?:python|python3|py)(?:\.exe)?(?:\s|$)/i.test(c) },
  { id: 'shell', displayName: 'Shell', kind: 'shell', detect: c => /(^|[\\/\s])(?:bash|zsh|sh|fish|pwsh|powershell)(?:\.exe)?(?:\s|$)/i.test(c) }
];

export function detectTaskKind(commandLine: string): TaskKind {
  const command = commandLine.trim();
  for (const adapter of adapters) {
    if (adapter.detect(command)) return adapter.kind;
  }
  // Generic agent commands can be configured later; unknown commands remain generic.
  if (/(agent|cursor|aider|opencode|gemini)/i.test(command)) return 'agent';
  return 'other';
}

export function displayNameForKind(kind: TaskKind): string {
  switch (kind) {
    case 'codex': return 'Codex';
    case 'claude': return 'Claude Code';
    case 'python': return 'Python';
    case 'shell': return 'Shell';
    case 'agent': return 'Agent';
    default: return 'Task';
  }
}
