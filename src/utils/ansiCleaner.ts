// Remove terminal control sequences before showing untrusted output in the Webview.
export function cleanTerminalOutput(input: string): string {
  return input
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r/g, '\n');
}

export function splitOutputLines(input: string): string[] {
  return cleanTerminalOutput(input)
    .split(/\n/)
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .map(line => line.length > 2000 ? line.slice(-2000) : line);
}
