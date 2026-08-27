import { describe, expect, it } from "vitest";
import {
  ACTIVE_STORAGE_KEY,
  HISTORY_STORAGE_PREFIX,
  SESSION_DURATION_MS,
  appendHistory,
  clearActiveSession,
  createSession,
  elapsedMs,
  finishSession,
  getSessionKey,
  getTodayStats,
  isSessionActive,
  isValidHistoryEntry,
  isValidSession,
  loadActiveSession,
  loadHistory,
  localDayKey,
  reconcileStoredSession,
  remainingMs,
  saveActiveSession,
  type StorageLike,
} from "../src/lib/session";

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const START = new Date(2026, 7, 27, 10, 0, 0).getTime();

describe("the ten-minute status lifecycle", () => {
  it("starts with exactly ten minutes remaining", () => {
    const session = createSession("anonymous-user", START);
    expect(session.expiresAt - session.startedAt).toBe(600_000);
    expect(remainingMs(session, START)).toBe(SESSION_DURATION_MS);
    expect(elapsedMs(session, START)).toBe(0);
  });

  it("is not active at the expiry boundary, independent of TTL", () => {
    const session = createSession("user", START);
    expect(isSessionActive(session, session.expiresAt - 1)).toBe(true);
    expect(isSessionActive(session, session.expiresAt)).toBe(false);
    expect(isSessionActive(session, session.expiresAt + 60_000)).toBe(false);
    expect(isSessionActive(null, START)).toBe(false);
  });

  it("counts all valid sessions without counting expired sessions", () => {
    const sessions = Array.from({ length: 1_250 }, (_, index) => createSession(`user-${index}`, START));
    sessions.push(createSession("expired", START - SESSION_DURATION_MS));
    expect(sessions.filter((session) => isSessionActive(session, START + 1)).length).toBe(1_250);
  });

  it("clamps timers after reloads, expiry, and a backwards clock", () => {
    const session = createSession("user", START);
    expect(elapsedMs(session, START + 42_000)).toBe(42_000);
    expect(remainingMs(session, START + 42_000)).toBe(558_000);
    expect(elapsedMs(session, START + 3_600_000)).toBe(600_000);
    expect(remainingMs(session, START + 3_600_000)).toBe(0);
    expect(elapsedMs(session, START - 1_000)).toBe(0);
    expect(remainingMs(session, START - 1_000)).toBe(600_000);
    expect(remainingMs(null, START)).toBe(0);
  });

  it("records the bounded elapsed duration on manual finish", () => {
    const session = createSession("user", START);
    expect(finishSession(session, "manual", START + 45_678)).toEqual({
      id: `user:${START}`,
      startedAt: START,
      endedAt: START + 45_678,
      durationMs: 45_678,
      reason: "manual",
    });
  });

  it("records exactly ten minutes after a long absence", () => {
    const session = createSession("user", START);
    expect(finishSession(session, "expired", START + 86_400_000).durationMs).toBe(600_000);
    expect(finishSession(session, "manual", session.expiresAt).reason).toBe("expired");
    expect(finishSession(session, "manual", START - 60_000).durationMs).toBe(0);
  });

  it("does not collide when the same UID starts another visit", () => {
    expect(getSessionKey(createSession("same-user", START))).not.toBe(
      getSessionKey(createSession("same-user", START + 60_000)),
    );
  });

  it.each([
    null,
    [],
    {},
    { id: "", startedAt: START, expiresAt: START + 1 },
    { id: "user", startedAt: START, expiresAt: START },
    { id: "user", startedAt: START, expiresAt: START + SESSION_DURATION_MS + 1 },
    { id: "user", startedAt: "not-a-time", expiresAt: START + 10 },
    { id: "user", startedAt: START, expiresAt: Infinity },
  ])("rejects malformed or overlong active state: %j", (candidate) => {
    expect(isValidSession(candidate)).toBe(false);
  });

  it("rejects invalid create arguments", () => {
    expect(() => createSession("", START)).toThrow();
    expect(() => createSession("user", NaN)).toThrow();
  });

  it("rejects forged duration values in history", () => {
    const entry = finishSession(createSession("user", START), "manual", START + 1_000);
    expect(isValidHistoryEntry({ ...entry, durationMs: 30_000 })).toBe(false);
    expect(isValidHistoryEntry({ ...entry, reason: "other" })).toBe(false);
    expect(isValidHistoryEntry(entry)).toBe(true);
  });
});

describe("daily local records", () => {
  it("counts starts today and includes the active duration", () => {
    const earlier = finishSession(createSession("a", START), "manual", START + 60_000);
    const active = createSession("a", START + 120_000);
    expect(getTodayStats([earlier], active, START + 150_000)).toMatchObject({
      date: localDayKey(START), count: 2, totalDurationMs: 90_000,
    });
  });

  it("does not count a session twice when local state and history overlap", () => {
    const active = createSession("user", START);
    const completed = finishSession(active, "manual", START + 10_000);
    expect(getTodayStats([completed, completed], active, START + 20_000)).toMatchObject({
      count: 1, totalDurationMs: 10_000,
    });
  });

  it("uses local calendar days and apportions a midnight-crossing duration", () => {
    const midnight = new Date(2026, 7, 28, 0, 0, 0).getTime();
    const crossing = createSession("user", midnight - 120_000);
    const completed = finishSession(crossing, "manual", midnight + 180_000);
    expect(getTodayStats([completed], null, midnight - 1)).toMatchObject({ count: 1, totalDurationMs: 119_999 });
    expect(getTodayStats([completed], null, midnight + 240_000)).toMatchObject({ count: 0, totalDurationMs: 180_000 });
  });

  it("splits an ongoing visit at midnight without artificially adding a start", () => {
    const midnight = new Date(2026, 7, 28, 0, 0, 0).getTime();
    const active = createSession("user", midnight - 60_000);
    expect(getTodayStats([], active, midnight + 30_000)).toMatchObject({ count: 0, totalDurationMs: 30_000 });
  });

  it("excludes old days and future corrupt records", () => {
    const yesterday = finishSession(createSession("yesterday", START - 86_400_000), "expired");
    const future = finishSession(createSession("tomorrow", START + 86_400_000), "expired");
    expect(getTodayStats([yesterday, future], null, START)).toMatchObject({ count: 0, totalDurationMs: 0 });
  });
});

describe("safe localStorage and multi-tab restoration", () => {
  it("restores the exact active timestamp after a reload", () => {
    const storage = new MemoryStorage();
    const session = createSession("user", START);
    expect(saveActiveSession(session, storage)).toBe(true);
    expect(loadActiveSession(storage)).toEqual(session);
    expect(reconcileStoredSession(START + 60_000, storage)).toEqual({ active: session, completed: null });
  });

  it("restores an expired visit into history exactly once", () => {
    const storage = new MemoryStorage();
    saveActiveSession(createSession("user", START), storage);
    expect(reconcileStoredSession(START + 86_400_000, storage).completed?.durationMs).toBe(600_000);
    expect(reconcileStoredSession(START + 86_400_000, storage)).toEqual({ active: null, completed: null });
    expect(loadHistory(storage)).toHaveLength(1);
    expect(loadActiveSession(storage)).toBeNull();
  });

  it("does not lose distinct visits when two tabs append their history", () => {
    const storage = new MemoryStorage();
    const first = finishSession(createSession("user", START), "manual", START + 30_000);
    const second = finishSession(createSession("user", START + 60_000), "manual", START + 90_000);
    appendHistory(first, storage);
    appendHistory(second, storage);
    appendHistory(first, storage);
    expect(loadHistory(storage)).toEqual([second, first]);
  });

  it("preserves an earlier finish against a stale tab's expiry report", () => {
    const storage = new MemoryStorage();
    const session = createSession("user", START);
    const expired = finishSession(session, "expired");
    const manual = finishSession(session, "manual", START + 10_000);
    appendHistory(expired, storage);
    appendHistory(manual, storage);
    appendHistory(expired, storage);
    expect(loadHistory(storage)).toEqual([manual]);
  });

  it("does not clear a newer visit from an old tab", () => {
    const storage = new MemoryStorage();
    const old = createSession("user", START);
    const current = createSession("user", START + 60_000);
    saveActiveSession(current, storage);
    expect(clearActiveSession(old, storage)).toBe(false);
    expect(loadActiveSession(storage)).toEqual(current);
    expect(clearActiveSession(current, storage)).toBe(true);
    expect(loadActiveSession(storage)).toBeNull();
  });

  it("ignores invalid JSON and unrelated keys without crashing", () => {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_STORAGE_KEY, "{broken");
    storage.setItem(`${HISTORY_STORAGE_PREFIX}broken`, "not JSON");
    storage.setItem(`${HISTORY_STORAGE_PREFIX}wrong`, JSON.stringify({ durationMs: -1 }));
    storage.setItem("another-app:data", "private unrelated data");
    expect(loadActiveSession(storage)).toBeNull();
    expect(loadHistory(storage)).toEqual([]);
    expect(storage.getItem("another-app:data")).toBe("private unrelated data");
  });

  it("tolerates disabled storage and quota errors", () => {
    const blocked: StorageLike = {
      get length(): number { throw new Error("Blocked"); },
      key: () => { throw new Error("Blocked"); },
      getItem: () => { throw new Error("Blocked"); },
      setItem: () => { throw new Error("Quota exceeded"); },
      removeItem: () => { throw new Error("Blocked"); },
    };
    const session = createSession("user", START);
    expect(loadActiveSession(blocked)).toBeNull();
    expect(loadHistory(blocked)).toEqual([]);
    expect(saveActiveSession(session, blocked)).toBe(false);
    expect(clearActiveSession(session, blocked)).toBe(false);
    expect(appendHistory(finishSession(session, "expired"), blocked)).toBe(false);
    expect(saveActiveSession(session, null)).toBe(false);
    expect(loadHistory(null)).toEqual([]);
  });
});
