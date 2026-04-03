// Tracks which browser tab last wrote to a notes file so the SSE event watcher
// can include the source tab ID. The originating tab ignores its own event,
// while other tabs still see the "externally changed" notification.

interface WriteRecord {
  tabId: string;
  ts: number;
}

const TTL_MS = 3_000;
const records = new Map<string, WriteRecord>();

export function recordNotesWrite(notesPath: string, tabId: string): void {
  records.set(notesPath, { tabId, ts: Date.now() });
  setTimeout(() => {
    const r = records.get(notesPath);
    if (r?.tabId === tabId) records.delete(notesPath);
  }, TTL_MS);
}

export function getNotesWriteSource(notesPath: string): string | null {
  const r = records.get(notesPath);
  if (!r || Date.now() - r.ts > TTL_MS) return null;
  return r.tabId;
}
