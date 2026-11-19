/** Maintains ANSI parser state and an unfinished line across shell output chunks. */
export class TerminalOutputStream {
  private escapeState: 'text' | 'escape' | 'csi' | 'osc' | 'oscEscape' = 'text';
  private currentLine = '';
  private readonly lines: string[] = [];

  push(chunk: string, limit: number): string[] {
    for (const character of chunk) this.consume(character);
    return this.snapshot(limit);
  }

  flush(limit: number): string[] {
    this.escapeState = 'text';
    this.commitLine();
    return this.snapshot(limit);
  }

  resetPartialLine(): void {
    this.escapeState = 'text';
    this.currentLine = '';
  }

  snapshot(limit: number): string[] {
    const count = Math.max(1, limit);
    const completed = this.lines.slice(-count);
    return this.currentLine.trim().length
      ? [...completed.slice(Math.max(0, completed.length - (count - 1))), this.currentLine.trimEnd()]
      : completed;
  }

  private consume(character: string): void {
    const code = character.charCodeAt(0);
    switch (this.escapeState) {
      case 'escape':
        this.escapeState = character === '[' ? 'csi' : character === ']' ? 'osc' : 'text';
        return;
      case 'csi':
        if (code >= 0x40 && code <= 0x7e) this.escapeState = 'text';
        return;
      case 'osc':
        if (code === 0x07) this.escapeState = 'text';
        else if (code === 0x1b) this.escapeState = 'oscEscape';
        return;
      case 'oscEscape':
        if (character === '\\') this.escapeState = 'text';
        else if (code !== 0x1b) this.escapeState = 'osc';
        return;
      case 'text':
        if (code === 0x1b) { this.escapeState = 'escape'; return; }
        if (character === '\n' || character === '\r') { this.commitLine(); return; }
        if (code < 0x20 || code === 0x7f) return;
        this.currentLine = (this.currentLine + character).slice(-2000);
    }
  }

  private commitLine(): void {
    const line = this.currentLine.trimEnd();
    if (line.trim()) {
      this.lines.push(line);
      if (this.lines.length > 100) this.lines.splice(0, this.lines.length - 100);
    }
    this.currentLine = '';
  }
}
