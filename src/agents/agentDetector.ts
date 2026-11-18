import { AgentAdapter } from './agentAdapter';
import { TaskKind } from '../core/types';

const adapters: AgentAdapter[] = [
  { id: 'codex', displayName: 'Codex', kind: 'codex', detect: c => c === 'codex' || c === 'codex.exe' || c === '@openai/codex' },
  { id: 'claude', displayName: 'Claude Code', kind: 'claude', detect: c => c === 'claude' || c === 'claude.exe' },
  { id: 'python', displayName: 'Python', kind: 'python', detect: c => /^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/.test(c) || c === 'py' || c === 'py.exe' },
  { id: 'shell', displayName: 'Shell', kind: 'shell', detect: c => /^(?:bash|zsh|sh|fish|pwsh|powershell)(?:\.exe)?$/.test(c) }
];

export function detectTaskKind(commandLine: string): TaskKind {
  const command = executable(commandLine);
  const basename = command.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const normalized = basename.replace(/\.cmd$|\.exe$/i, '');
  for (const adapter of adapters) if (adapter.detect(normalized)) return adapter.kind;
  if (/^(?:agent|cursor|cursor-agent|aider|opencode|gemini|qwen|amp)$/.test(normalized)) return 'agent';
  return 'other';
}

function executable(input: string): string {
  // Keep unquoted Windows paths intact; only treat backslashes as escapes inside quotes.
  const tokens = input.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g) ?? [];
  const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, '$2').replace(/\\(["'\\ ])/g, '$1');
  const words = tokens.map(unquote);
  let index = 0;
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
  const optionWithValue = new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-c', '--chdir', '-p', '--prompt', '-C', '--close-from']);
  while (index < words.length) {
    const word = words[index].toLowerCase();
    if (assignment.test(words[index])) { index++; continue; }
    if (['sudo', 'command', 'exec', 'time', 'nohup'].includes(word)) {
      index++;
      while (index < words.length && /^-/.test(words[index])) {
        const option = words[index++];
        if (optionWithValue.has(option) && index < words.length) index++;
      }
      continue;
    }
    if (word === 'env') {
      index++;
      while (index < words.length && (assignment.test(words[index]) || /^-[uC]$/.test(words[index]))) {
        const option = words[index++];
        if (/^-[uC]$/.test(option)) index++;
      }
      continue;
    }
    if (['npx', 'bunx'].includes(word)) {
      index++;
      while (index < words.length && /^-/.test(words[index])) {
        const option = words[index++];
        if (optionWithValue.has(option) && index < words.length) index++;
      }
      if (index < words.length && words[index] === '--') index++;
      return words[index] ?? '';
    }
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(word)) {
      index++;
      const subcommand = words[index]?.toLowerCase();
      if (subcommand === 'run' || subcommand === 'run-script') return '';
      if (['exec', 'dlx', 'x'].includes(subcommand ?? '')) index++;
      else if (word === 'npm' || word === 'bun') return '';
      while (index < words.length && /^-/.test(words[index])) {
        const option = words[index++];
        if (optionWithValue.has(option) && index < words.length) index++;
      }
      if (index < words.length && words[index] === '--') index++;
      return words[index] ?? '';
    }
    return words[index] ?? '';
  }
  return '';
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
