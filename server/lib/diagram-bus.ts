/**
 * In-process pub/sub for diagram save events.
 *
 * When any instance saves a diagram, it publishes here.
 * All SSE connections for the same repo path receive the event.
 * Since sideclaw is a single Bun process, an in-memory map is sufficient.
 */

export interface DiagramSaveEvent {
  name: string;
  modifiedAt: number;
}

type Listener = (event: DiagramSaveEvent) => void;

const subscribers = new Map<string, Set<Listener>>();

export function subscribeDiagrams(repoPath: string, cb: Listener): () => void {
  let set = subscribers.get(repoPath);
  if (!set) {
    set = new Set();
    subscribers.set(repoPath, set);
  }
  set.add(cb);
  return () => {
    subscribers.get(repoPath)?.delete(cb);
  };
}

export function publishDiagram(repoPath: string, event: DiagramSaveEvent): void {
  subscribers.get(repoPath)?.forEach((cb) => cb(event));
}
