const LOCK_TTL_MS = 45_000; // 45 seconds — heartbeat every 15s gives 3x headroom

interface LockEntry {
  token: string;
  acquiredAt: number;
  heartbeat: number; // last successful heartbeat (or acquiredAt on first)
}

// key: `${repoPath}:${diagramName}`
const locks = new Map<string, LockEntry>();

function lockKey(repoPath: string, name: string): string {
  return `${repoPath}:${name}`;
}

function isExpired(entry: LockEntry): boolean {
  return Date.now() - entry.heartbeat >= LOCK_TTL_MS;
}

/**
 * Attempt to acquire a lock. Returns a UUID token on success, null if locked
 * by another holder whose heartbeat is still within TTL.
 */
export function acquireLock(repoPath: string, name: string): string | null {
  const key = lockKey(repoPath, name);
  const existing = locks.get(key);
  if (existing && !isExpired(existing)) return null;
  // Either no lock or expired lock — grant it
  const token = crypto.randomUUID();
  locks.set(key, { token, acquiredAt: Date.now(), heartbeat: Date.now() });
  return token;
}

/**
 * Extend TTL for an existing lock. Returns true on success, false if the token
 * is invalid or the lock has already expired.
 */
export function heartbeatLock(repoPath: string, name: string, token: string): boolean {
  const key = lockKey(repoPath, name);
  const entry = locks.get(key);
  if (!entry || entry.token !== token) return false;
  if (isExpired(entry)) {
    locks.delete(key);
    return false;
  }
  entry.heartbeat = Date.now();
  return true;
}

/**
 * Release a lock held by the given token. Always safe to call (idempotent).
 * Returns true if the lock was actually held by this token and released.
 */
export function releaseLock(repoPath: string, name: string, token: string): boolean {
  const key = lockKey(repoPath, name);
  const entry = locks.get(key);
  if (!entry || entry.token !== token) return false;
  locks.delete(key);
  return true;
}

/**
 * Check whether the given token is the valid current lock holder (not expired).
 */
export function validateLock(repoPath: string, name: string, token: string): boolean {
  const key = lockKey(repoPath, name);
  const entry = locks.get(key);
  if (!entry || entry.token !== token || isExpired(entry)) return false;
  return true;
}

/**
 * Returns how many ms ago the active lock was acquired, or null if no lock is
 * held (or if it has expired). Cleans up expired entries as a side effect.
 */
export function getLockAge(repoPath: string, name: string): number | null {
  const key = lockKey(repoPath, name);
  const entry = locks.get(key);
  if (!entry) return null;
  if (isExpired(entry)) {
    locks.delete(key);
    return null;
  }
  return Date.now() - entry.acquiredAt;
}
