/** The app records an explicit status, never a person's physical location. */
export const SESSION_DURATION_MS = 10 * 60 * 1_000;
export const ACTIVE_STORAGE_KEY = "toilet-population:active:v1";
export const HISTORY_STORAGE_PREFIX = "toilet-population:history:v1:";
export const STORAGE_CHANGE_EVENT = "toilet-population:storage";

export interface ActiveSession {
  /** Firebase anonymous UID in live mode; a local random ID in demo mode. */
  id: string;
  startedAt: number;
  expiresAt: number;
}

export interface HistoryEntry {
  /** Unique per visit, not merely per anonymous user. */
  id: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  reason: "manual" | "expired";
}

export interface DailyStats {
  date: string;
  /** Visits STARTED on this device's local-calendar day, including an active visit. */
  count: number;
  /** Only the portion of elapsed time that falls on this local-calendar day. */
  totalDurationMs: number;
  entries: HistoryEntry[];
}

export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isValidSession(value: unknown): value is ActiveSession {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 256 &&
    isTime(value.startedAt) &&
    isTime(value.expiresAt) &&
    value.expiresAt > value.startedAt &&
    value.expiresAt - value.startedAt <= SESSION_DURATION_MS
  );
}

export function isValidHistoryEntry(value: unknown): value is HistoryEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 320 &&
    isTime(value.startedAt) &&
    isTime(value.endedAt) &&
    value.endedAt >= value.startedAt &&
    typeof value.durationMs === "number" &&
    Number.isSafeInteger(value.durationMs) &&
    value.durationMs === value.endedAt - value.startedAt &&
    value.durationMs <= SESSION_DURATION_MS &&
    (value.reason === "manual" || value.reason === "expired")
  );
}

export function createSession(id: string, now = Date.now()): ActiveSession {
  const session = { id, startedAt: now, expiresAt: now + SESSION_DURATION_MS };
  if (!isValidSession(session)) throw new Error("Invalid session identifier or time.");
  return session;
}

export function getSessionKey(session: Pick<ActiveSession, "id" | "startedAt">): string {
  return `${session.id}:${session.startedAt}`;
}

export function isSessionActive(session: ActiveSession | null, now = Date.now()): boolean {
  return session !== null && isValidSession(session) && session.expiresAt > now;
}

export function remainingMs(session: ActiveSession | null, now = Date.now()): number {
  return session ? Math.max(0, Math.min(SESSION_DURATION_MS, session.expiresAt - now)) : 0;
}

export function elapsedMs(session: ActiveSession | null, now = Date.now()): number {
  return session ? Math.max(0, Math.min(now, session.expiresAt) - session.startedAt) : 0;
}

export function finishSession(
  session: ActiveSession,
  reason: HistoryEntry["reason"] = "manual",
  now = Date.now(),
): HistoryEntry {
  if (!isValidSession(session)) throw new Error("Cannot finish an invalid session.");
  const endedAt =
    reason === "expired"
      ? session.expiresAt
      : Math.max(session.startedAt, Math.min(now, session.expiresAt));
  return {
    id: getSessionKey(session),
    startedAt: session.startedAt,
    endedAt,
    durationMs: endedAt - session.startedAt,
    reason: endedAt >= session.expiresAt ? "expired" : "manual",
  };
}

export function localDayKey(now = Date.now()): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function uniqueHistory(entries: readonly HistoryEntry[]): HistoryEntry[] {
  const unique = new Map<string, HistoryEntry>();
  for (const entry of entries) {
    if (!isValidHistoryEntry(entry)) continue;
    const previous = unique.get(entry.id);
    // An earlier manual finish wins over a stale tab's later expiry report.
    if (!previous || entry.endedAt < previous.endedAt) unique.set(entry.id, entry);
  }
  return [...unique.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function getTodayStats(
  history: readonly HistoryEntry[],
  active: ActiveSession | null = null,
  now = Date.now(),
): DailyStats {
  const date = new Date(now);
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  const unique = uniqueHistory(history);
  const relevant = unique.filter(
    (entry) => entry.startedAt <= now && entry.endedAt >= dayStart && entry.startedAt < dayEnd,
  );
  const overlappingDuration = (start: number, end: number) =>
    Math.max(0, Math.min(end, now, dayEnd) - Math.max(start, dayStart));
  let count = unique.filter(
    (entry) => entry.startedAt >= dayStart && entry.startedAt < dayEnd && entry.startedAt <= now,
  ).length;
  let totalDurationMs = relevant.reduce(
    (total, entry) => total + overlappingDuration(entry.startedAt, entry.endedAt),
    0,
  );
  if (active && isValidSession(active) && !unique.some((entry) => entry.id === getSessionKey(active))) {
    if (active.startedAt >= dayStart && active.startedAt < dayEnd && active.startedAt <= now) count += 1;
    totalDurationMs += overlappingDuration(active.startedAt, active.expiresAt);
  }
  return { date: localDayKey(now), count, totalDurationMs, entries: relevant };
}

export function getBrowserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function notifyLocalChange(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(STORAGE_CHANGE_EVENT));
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** Expired state is intentionally returned so its exact duration can be recorded on restore. */
export function loadActiveSession(storage: StorageLike | null = getBrowserStorage()): ActiveSession | null {
  try {
    const candidate = parseJson(storage?.getItem(ACTIVE_STORAGE_KEY) ?? null);
    return isValidSession(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function saveActiveSession(
  session: ActiveSession | null,
  storage: StorageLike | null = getBrowserStorage(),
): boolean {
  if (!storage || (session !== null && !isValidSession(session))) return false;
  try {
    if (session === null) storage.removeItem(ACTIVE_STORAGE_KEY);
    else storage.setItem(ACTIVE_STORAGE_KEY, JSON.stringify(session));
    notifyLocalChange();
    return true;
  } catch {
    return false;
  }
}

/** An old tab must not clear a newer visit started by another tab. */
export function clearActiveSession(
  expected?: ActiveSession,
  storage: StorageLike | null = getBrowserStorage(),
): boolean {
  if (!storage) return false;
  try {
    const current = loadActiveSession(storage);
    if (expected && current && getSessionKey(expected) !== getSessionKey(current)) return false;
    storage.removeItem(ACTIVE_STORAGE_KEY);
    notifyLocalChange();
    return true;
  } catch {
    return false;
  }
}

export function loadHistory(storage: StorageLike | null = getBrowserStorage()): HistoryEntry[] {
  if (!storage) return [];
  try {
    const entries: HistoryEntry[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(HISTORY_STORAGE_PREFIX)) continue;
      const candidate = parseJson(storage.getItem(key));
      if (isValidHistoryEntry(candidate)) entries.push(candidate);
    }
    return uniqueHistory(entries);
  } catch {
    return [];
  }
}

/**
 * One key per visit avoids the read/modify/write lost-update race of a shared array.
 * Repeated expiry callbacks, refreshes, and tabs are idempotent by visit ID.
 */
export function appendHistory(
  entry: HistoryEntry,
  storage: StorageLike | null = getBrowserStorage(),
): boolean {
  if (!storage || !isValidHistoryEntry(entry)) return false;
  try {
    const key = `${HISTORY_STORAGE_PREFIX}${entry.id}`;
    const previous = parseJson(storage.getItem(key));
    if (isValidHistoryEntry(previous) && previous.endedAt <= entry.endedAt) return true;
    storage.setItem(key, JSON.stringify(entry));
    notifyLocalChange();
    return true;
  } catch {
    return false;
  }
}

export function reconcileStoredSession(
  now = Date.now(),
  storage: StorageLike | null = getBrowserStorage(),
): { active: ActiveSession | null; completed: HistoryEntry | null } {
  const active = loadActiveSession(storage);
  if (!active || isSessionActive(active, now)) return { active, completed: null };
  const completed = finishSession(active, "expired", now);
  appendHistory(completed, storage);
  clearActiveSession(active, storage);
  return { active: null, completed };
}

/** Serializes same-origin demo starts/stops where Web Locks are supported. */
export async function withSessionLock<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request("toilet-population:session", operation);
  }
  return operation();
}
