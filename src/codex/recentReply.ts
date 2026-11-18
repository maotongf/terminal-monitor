interface PublicMessageCandidate {
  type?: unknown;
  phase?: unknown;
  text?: unknown;
  moderation?: { moderated?: unknown } | null;
}

/** Select the newest explicitly final assistant reply from a descending item page. */
export function extractRecentReply(entries: unknown[]): string | undefined {
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const wrapped = 'item' in entry ? (entry as { item?: unknown }).item : entry;
    if (!wrapped || typeof wrapped !== 'object') continue;
    const item = wrapped as PublicMessageCandidate;
    if (item.type !== 'agentMessage' || item.phase !== 'final_answer' || item.moderation?.moderated === true) continue;
    if (typeof item.text !== 'string') continue;

    const text = item.text
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!text) continue;
    return text.length > 420 ? `${text.slice(0, 419).trimEnd()}…` : text;
  }
  return undefined;
}
