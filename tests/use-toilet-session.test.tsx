// @vitest-environment jsdom

import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_STORAGE_KEY,
  createSession,
  finishSession,
  getSessionKey,
  HISTORY_STORAGE_PREFIX,
  loadHistory,
  saveActiveSession,
  SESSION_DURATION_MS,
  type ActiveSession,
} from "@/lib/session";
import type { PopulationSnapshot } from "@/lib/firebase-client";
import { createScopedStorage } from "@/lib/scoped-storage";
import { useToiletSession } from "@/hooks/use-toilet-session";

const backend = vi.hoisted(() => ({
  mode: "demo" as "demo" | "live",
  own: null as ActiveSession | null,
  population: null as PopulationSnapshot | null,
  ownListeners: new Set<(session: ActiveSession | null) => void>(),
  populationListeners: new Set<(snapshot: PopulationSnapshot) => void>(),
  ownErrors: new Set<(error: Error) => void>(),
  populationErrors: new Set<(error: Error) => void>(),
  signIn: vi.fn<() => Promise<string>>(),
  getOwn: vi.fn<(uid: string) => Promise<ActiveSession | null>>(),
  start: vi.fn<(uid: string) => Promise<ActiveSession>>(),
  end: vi.fn<(uid: string, startedAt?: number) => Promise<void>>(),
  track: vi.fn(),
}));

vi.mock("@vercel/analytics", () => ({ track: backend.track }));
vi.mock("@/lib/firebase-client", () => ({
  getFirebaseStatus: () => ({ configured: backend.mode === "live", mode: backend.mode, missing: [] }),
  signInAnonymousUser: backend.signIn,
  getOwnSession: backend.getOwn,
  startOwnSession: backend.start,
  endOwnSession: backend.end,
  subscribeOwnSession: (_uid: string, callback: (session: ActiveSession | null) => void, onError: (error: Error) => void) => {
    backend.ownListeners.add(callback);
    backend.ownErrors.add(onError);
    callback(backend.own);
    return () => { backend.ownListeners.delete(callback); backend.ownErrors.delete(onError); };
  },
  subscribePopulation: (callback: (snapshot: PopulationSnapshot) => void, onError: (error: Error) => void) => {
    backend.populationListeners.add(callback);
    backend.populationErrors.add(onError);
    if (backend.population) callback(backend.population);
    return () => { backend.populationListeners.delete(callback); backend.populationErrors.delete(onError); };
  },
}));

function population(sessions: ActiveSession[] = [], fromCache = false): PopulationSnapshot {
  return { sessions, count: sessions.length, fromCache, updatedAt: Date.now() };
}

function emitPopulation(sessions: ActiveSession[], fromCache = false) {
  backend.population = population(sessions, fromCache);
  for (const listener of backend.populationListeners) listener(backend.population);
}

function emitOwn(session: ActiveSession | null) {
  backend.own = session;
  for (const listener of backend.ownListeners) listener(session);
}

async function mountHook() {
  const result = renderHook(() => useToiletSession());
  await act(async () => {});
  return result;
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

function installWebLocks() {
  const held = new Set<string>();
  const queues = new Map<string, Promise<void>>();
  const released = vi.fn();
  const request = vi.fn((name: string, callback: () => Promise<unknown>) => {
    const previous = queues.get(name) ?? Promise.resolve();
    const current = previous.then(async () => {
      held.add(name);
      try { return await callback(); }
      finally { held.delete(name); released(name); }
    });
    queues.set(name, current.then(() => {}, () => {}));
    return current;
  });
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
  return { held, released, request };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 27, 12, 0, 0));
  window.localStorage.clear();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: null });
  Object.defineProperty(navigator, "globalPrivacyControl", { configurable: true, value: false });
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  backend.mode = "demo";
  backend.own = null;
  backend.population = population();
  backend.ownListeners.clear();
  backend.populationListeners.clear();
  backend.ownErrors.clear();
  backend.populationErrors.clear();
  backend.signIn.mockReset().mockResolvedValue("anonymous-user");
  backend.getOwn.mockReset().mockImplementation(async () => backend.own);
  backend.start.mockReset().mockImplementation(async (uid) => {
    const session = backend.own ?? createSession(uid);
    emitOwn(session);
    emitPopulation([session]);
    return session;
  });
  backend.end.mockReset().mockImplementation(async (_uid, expectedStartedAt) => {
    if (!backend.own || expectedStartedAt === undefined || backend.own.startedAt === expectedStartedAt) {
      emitOwn(null);
      emitPopulation([]);
    }
  });
  backend.track.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useToiletSession: explicit demo and local records", () => {
  it("starts with 12 clearly-scoped samples and never contacts Firebase", async () => {
    const { result } = await mountHook();
    expect(result.current).toMatchObject({ ready: true, mode: "demo", connection: "demo", count: 12, sampleCount: 12, active: null, storageAvailable: true });
    expect(result.current.stats).toMatchObject({ count: 0, totalDurationMs: 0 });
    expect(backend.signIn).not.toHaveBeenCalled();
    await advance(5_000);
    expect(result.current.count).toBe(12);
  });

  it("serializes duplicate starts and records one manually completed visit", async () => {
    const { result } = await mountHook();
    await act(async () => { await Promise.all([result.current.start(), result.current.start()]); });
    expect(result.current.count).toBe(13);
    expect(result.current.stats.count).toBe(1);
    expect(result.current.active?.expiresAt).toBe(Date.now() + SESSION_DURATION_MS);
    await advance(65_000);
    expect(result.current.stats.totalDurationMs).toBe(65_000);
    await act(async () => { await Promise.all([result.current.end(), result.current.end()]); });
    expect(result.current.active).toBeNull();
    expect(result.current.count).toBe(12);
    expect(result.current.completed).toMatchObject({ durationMs: 65_000, reason: "manual" });
    expect(result.current.stats).toMatchObject({ count: 1, totalDurationMs: 65_000 });
    const records = loadHistory(createScopedStorage("demo", window.localStorage));
    expect(records).toHaveLength(1);
    expect(backend.track).toHaveBeenNthCalledWith(1, "toilet_start", { mode: "demo" });
    expect(backend.track).toHaveBeenNthCalledWith(2, "toilet_end", { mode: "demo", reason: "manual" });
    expect(backend.track).toHaveBeenCalledTimes(2);
    act(() => { result.current.dismissCompleted(); });
    expect(result.current.completed).toBeNull();
    expect(result.current.stats.count).toBe(1);
  });

  it("changes samples only by explicit controls, caps them at 24, and keeps self separate", async () => {
    const { result } = await mountHook();
    act(() => { for (let index = 0; index < 30; index += 1) result.current.addDemoPerson(); });
    expect(result.current.sampleCount).toBe(24);
    expect(result.current.count).toBe(24);
    await act(async () => { await result.current.start(); });
    expect(result.current.count).toBe(25);
    act(() => { result.current.resetDemoPeople(); });
    expect(result.current.sampleCount).toBe(12);
    expect(result.current.count).toBe(13);
  });

  it("restores the same active session after leaving and reloading", async () => {
    const first = await mountHook();
    await act(async () => { await first.result.current.start(); });
    const original = first.result.current.active;
    await advance(125_000);
    first.unmount();
    await advance(60_000);
    const next = await mountHook();
    expect(next.result.current.active).toEqual(original);
    expect(next.result.current.count).toBe(13);
    expect(next.result.current.stats).toMatchObject({ count: 1, totalDurationMs: 185_000 });
    expect(backend.end).not.toHaveBeenCalled();
  });

  it("expires at exactly ten minutes and writes the bounded duration only once", async () => {
    const { result } = await mountHook();
    await act(async () => { await result.current.start(); });
    await advance(SESSION_DURATION_MS - 1);
    expect(result.current.active).not.toBeNull();
    await advance(1);
    expect(result.current.active).toBeNull();
    expect(result.current.completed).toMatchObject({ durationMs: SESSION_DURATION_MS, reason: "expired" });
    expect(result.current.count).toBe(12);
    await advance(5_000);
    expect(result.current.stats.count).toBe(1);
    expect(result.current.stats.entries).toHaveLength(1);
  });

  it("reconciles an expired closed-tab session with its original exact expiry", async () => {
    const first = await mountHook();
    await act(async () => { await first.result.current.start(); });
    const expiresAt = first.result.current.active?.expiresAt;
    first.unmount();
    await advance(40 * 60 * 1_000);
    const next = await mountHook();
    expect(next.result.current.active).toBeNull();
    expect(next.result.current.completed).toMatchObject({ endedAt: expiresAt, durationMs: SESSION_DURATION_MS, reason: "expired" });
    expect(next.result.current.stats.entries).toHaveLength(1);
    next.unmount();
    const again = await mountHook();
    expect(again.result.current.stats.entries).toHaveLength(1);
  });

  it("synchronizes starts, durations, and finishes between mounted tabs", async () => {
    const first = await mountHook();
    const second = await mountHook();
    await act(async () => { await first.result.current.start(); });
    expect(second.result.current.active).toEqual(first.result.current.active);
    await advance(41_000);
    await act(async () => { await second.result.current.end(); });
    expect(first.result.current.active).toBeNull();
    expect(first.result.current.completed?.durationMs).toBe(41_000);
    expect(first.result.current.stats.entries).toHaveLength(1);
    expect(second.result.current.stats).toEqual(first.result.current.stats);
  });

  it("responds to real storage events without mixing another mode's keys", async () => {
    const { result } = await mountHook();
    const session = createSession("another-tab");
    act(() => {
      localStorage.setItem("toilet-population:live:active:v1", JSON.stringify(session));
      window.dispatchEvent(new StorageEvent("storage", { key: "toilet-population:live:active:v1" }));
    });
    expect(result.current.active).toBeNull();
    act(() => {
      localStorage.setItem("toilet-population:demo:active:v1", JSON.stringify(session));
      window.dispatchEvent(new StorageEvent("storage", { key: "toilet-population:demo:active:v1" }));
    });
    expect(result.current.active).toEqual(session);
    expect(result.current.count).toBe(13);
  });

  it("still operates in memory and warns when localStorage is inaccessible", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    const { result } = await mountHook();
    expect(result.current.storageAvailable).toBe(false);
    await act(async () => { await result.current.start(); });
    await advance(20_000);
    await act(async () => { await result.current.end(); });
    expect(result.current.completed?.durationMs).toBe(20_000);
    expect(result.current.stats).toMatchObject({ count: 1, totalDurationMs: 20_000 });
  });

  it("ignores malformed persisted state", async () => {
    localStorage.setItem("toilet-population:demo:active:v1", "{bad-json");
    localStorage.setItem("toilet-population:demo:history:v1:bad", "null");
    const { result } = await mountHook();
    expect(result.current.active).toBeNull();
    expect(result.current.stats.count).toBe(0);
    await act(async () => { await result.current.start(); });
    expect(result.current.active).not.toBeNull();
  });

  it("splits elapsed time at local midnight without inventing another visit", async () => {
    vi.setSystemTime(new Date(2026, 7, 27, 23, 59, 50));
    const { result } = await mountHook();
    await act(async () => { await result.current.start(); });
    await advance(20_000);
    expect(result.current.stats).toMatchObject({ date: "2026-08-28", count: 0, totalDurationMs: 10_000 });
    await act(async () => { await result.current.end(); });
    expect(result.current.stats.totalDurationMs).toBe(10_000);
    expect(result.current.completed?.durationMs).toBe(20_000);
  });

  it("does not resurrect an active cache entry that already has a manual finish", async () => {
    const session = createSession("old-tab", Date.now() - 120_000);
    const entry = finishSession(session, "manual", session.startedAt + 30_000);
    const storage = createScopedStorage("demo", localStorage);
    storage.setItem(ACTIVE_STORAGE_KEY, JSON.stringify(session));
    storage.setItem(`${HISTORY_STORAGE_PREFIX}${entry.id}`, JSON.stringify(entry));
    const { result } = await mountHook();
    expect(result.current.active).toBeNull();
    expect(result.current.completed?.durationMs).toBe(30_000);
    expect(result.current.stats.totalDurationMs).toBe(30_000);
  });
});

describe("useToiletSession: live connectivity", () => {
  beforeEach(() => { backend.mode = "live"; });

  it("uses authenticated UID sessions and realtime population snapshots", async () => {
    const { result } = await mountHook();
    expect(result.current.connection).toBe("live");
    expect(result.current.count).toBe(0);
    await act(async () => { await result.current.start(); });
    expect(result.current.active?.id).toBe("anonymous-user");
    expect(result.current.count).toBe(1);
    const startedAt = result.current.active?.startedAt;
    await advance(37_000);
    await act(async () => { await result.current.end(); });
    expect(backend.end).toHaveBeenCalledWith("anonymous-user", startedAt);
    expect(result.current.completed?.durationMs).toBe(37_000);
    expect(result.current.count).toBe(0);
    expect(backend.track).toHaveBeenCalledWith("toilet_start", { mode: "live" });
    expect(backend.track).toHaveBeenCalledWith("toilet_end", { mode: "live", reason: "manual" });
  });

  it("restores its server session without importing demo history", async () => {
    const demo = createSession("demo-local", Date.now() - 60_000);
    const demoStorage = createScopedStorage("demo", localStorage);
    saveActiveSession(demo, demoStorage);
    const demoEntry = finishSession(createSession("finished-demo", Date.now() - 120_000), "manual", Date.now() - 70_000);
    demoStorage.setItem(`${HISTORY_STORAGE_PREFIX}${demoEntry.id}`, JSON.stringify(demoEntry));
    backend.own = createSession("anonymous-user", Date.now() - 240_000);
    backend.population = population([backend.own]);
    const { result } = await mountHook();
    expect(result.current.active).toEqual(backend.own);
    expect(result.current.stats).toMatchObject({ count: 1, totalDurationMs: 240_000 });
    expect(result.current.stats.entries).toHaveLength(0);
    expect(backend.start).not.toHaveBeenCalled();
  });

  it("shows auth failures as live errors and can retry without silently entering demo", async () => {
    backend.signIn.mockRejectedValue(new Error("auth/network-request-failed"));
    const { result } = await mountHook();
    expect(result.current).toMatchObject({ ready: true, mode: "live", connection: "error", count: null });
    expect(result.current.error).toContain("接続できませんでした");
    await act(async () => { await result.current.start(); });
    expect(backend.start).not.toHaveBeenCalled();
    backend.signIn.mockResolvedValue("anonymous-user");
    await act(async () => { result.current.retryConnection(); });
    expect(result.current.connection).toBe("live");
    expect(result.current.error).toBeNull();
  });

  it("labels cached population offline and never presents it as live", async () => {
    backend.own = createSession("anonymous-user");
    const others = [createSession("other-one"), createSession("other-two")];
    backend.population = population([backend.own, ...others], true);
    const { result } = await mountHook();
    expect(result.current).toMatchObject({ mode: "live", connection: "offline", count: 3 });
    const active = result.current.active;
    await act(async () => { await result.current.end(); });
    expect(backend.end).not.toHaveBeenCalled();
    expect(result.current.active).toEqual(active);
    expect(result.current.error).toContain("未接続");
  });

  it("keeps an offline live visit active until exact expiry without pretending to delete it", async () => {
    backend.own = createSession("anonymous-user");
    backend.population = population([backend.own]);
    const { result } = await mountHook();
    act(() => {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
      window.dispatchEvent(new Event("offline"));
    });
    await act(async () => { await result.current.end(); });
    expect(result.current.connection).toBe("offline");
    expect(result.current.active).not.toBeNull();
    expect(backend.end).not.toHaveBeenCalled();
    await advance(SESSION_DURATION_MS);
    expect(result.current.active).toBeNull();
    expect(result.current.completed?.reason).toBe("expired");
    expect(result.current.count).toBe(0);
    expect(backend.end).not.toHaveBeenCalled();
  });

  it("retains the active state if a manual server deletion fails", async () => {
    const { result } = await mountHook();
    await act(async () => { await result.current.start(); });
    const original = result.current.active;
    backend.end.mockRejectedValue(new Error("permission-denied"));
    await act(async () => { await result.current.end(); });
    expect(result.current.active).toEqual(original);
    expect(result.current.completed).toBeNull();
    expect(result.current.error).toContain("変更できませんでした");
    expect(result.current.busy).toBe(false);
  });

  it("records the local manual click time even when the server snapshot arrives later", async () => {
    const { result } = await mountHook();
    await act(async () => { await result.current.start(); });
    await advance(60_000);
    backend.end.mockImplementation(() => new Promise<void>((resolve) => {
      setTimeout(() => {
        emitOwn(null);
        emitPopulation([]);
        setTimeout(resolve, 2_000);
      }, 1_500);
    }));
    act(() => { void result.current.end(); });
    expect(result.current.busy).toBe(true);
    await advance(1_500);
    expect(result.current.completed?.durationMs).toBe(60_000);
    await advance(2_000);
    expect(result.current.completed?.durationMs).toBe(60_000);
    expect(result.current.stats.entries).toHaveLength(1);
    expect(result.current.busy).toBe(false);
  });

  it("records another tab's confirmed server deletion at the observed time", async () => {
    const { result } = await mountHook();
    await act(async () => { await result.current.start(); });
    await advance(42_000);
    act(() => { emitOwn(null); emitPopulation([]); });
    expect(result.current.completed).toMatchObject({ reason: "manual", durationMs: 42_000 });
    expect(result.current.active).toBeNull();
  });

  it("does not interpret a cleared local cache as a successful live deletion", async () => {
    const { result } = await mountHook();
    await act(async () => { await result.current.start(); });
    const original = result.current.active;
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(result.current.active).toEqual(original);
    expect(backend.end).not.toHaveBeenCalled();
  });

  it("times out an unavailable connection without swapping in sample people", async () => {
    backend.signIn.mockImplementation(() => new Promise<string>(() => {}));
    const { result } = await mountHook();
    expect(result.current.connection).toBe("connecting");
    await advance(15_000);
    expect(result.current).toMatchObject({ connection: "error", mode: "live", count: null });
  });

  it("cleans up Strict Mode subscriptions and ignores obsolete auth resolutions", async () => {
    let resolveAuth!: (uid: string) => void;
    backend.signIn.mockReturnValue(new Promise((resolve) => { resolveAuth = resolve; }));
    const { result, unmount } = renderHook(() => useToiletSession(), { wrapper: StrictMode });
    await act(async () => { resolveAuth("anonymous-user"); });
    expect(result.current.connection).toBe("live");
    expect(backend.getOwn).toHaveBeenCalledTimes(1);
    expect(backend.ownListeners.size).toBe(1);
    expect(backend.populationListeners.size).toBe(1);
    unmount();
    expect(backend.ownListeners.size).toBe(0);
    expect(backend.populationListeners.size).toBe(0);
    // React's act bookkeeping schedules zero-delay callbacks; app timers are future timers.
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not write stale local state after an in-flight start finishes after unmount", async () => {
    const first = await mountHook();
    let resolveStart!: (session: ActiveSession) => void;
    backend.start.mockReturnValue(new Promise((resolve) => { resolveStart = resolve; }));
    act(() => { void first.result.current.start(); });
    first.unmount();
    const session = createSession("anonymous-user");
    await act(async () => { backend.own = session; resolveStart(session); });
    expect(localStorage.getItem("toilet-population:live:active:v1")).toBeNull();
    expect(backend.end).not.toHaveBeenCalled();
    backend.population = population([session]);
    const restored = await mountHook();
    expect(restored.result.current.active).toEqual(session);
    expect(restored.result.current.stats.count).toBe(1);
  });
});

describe("useToiletSession: bounded writes and late confirmations", () => {
  beforeEach(() => { backend.mode = "live"; });

  it("releases a hung start's UI and actual Web Lock callback after 15 seconds", async () => {
    const locks = installWebLocks();
    backend.start.mockImplementation(() => new Promise<ActiveSession>(() => {}));
    const { result } = await mountHook();
    let action!: Promise<void>;
    await act(async () => { action = result.current.start(); });
    expect(locks.held.has("toilet-population:session")).toBe(true);
    await advance(14_999);
    expect(result.current.busy).toBe(true);
    await advance(1);
    await act(async () => { await action; });
    expect(locks.held.size).toBe(0);
    expect(result.current).toMatchObject({ busy: false, active: null, mode: "live", connection: "error" });
    expect(result.current.error).toContain("結果を確認できませんでした");
    let nextLockEntered = false;
    await act(async () => {
      await locks.request("toilet-population:session", async () => { nextLockEntered = true; });
    });
    expect(nextLockEntered).toBe(true);
    expect(backend.track).not.toHaveBeenCalledWith("toilet_start", { mode: "live" });
  });

  it("recovers from a late start ACK without claiming that the timed-out request was cancelled", async () => {
    let resolveStart!: (session: ActiveSession) => void;
    backend.start.mockReturnValue(new Promise((resolve) => { resolveStart = resolve; }));
    const { result } = await mountHook();
    const startedAt = Date.now();
    act(() => { void result.current.start(); });
    await advance(15_000);
    expect(result.current.error).toContain("処理が完了している場合もあります");
    const confirmed = createSession("anonymous-user", startedAt);
    await act(async () => { backend.own = confirmed; resolveStart(confirmed); emitPopulation([confirmed]); });
    expect(result.current).toMatchObject({ busy: false, active: confirmed, connection: "live", error: null });
    expect(result.current.stats.count).toBe(1);
    expect(backend.track).toHaveBeenCalledTimes(1);
  });

  it("recovers from an authoritative own snapshot even when the original start promise never settles", async () => {
    backend.start.mockImplementation(() => new Promise<ActiveSession>(() => {}));
    const { result } = await mountHook();
    act(() => { void result.current.start(); });
    await advance(15_000);
    const confirmed = createSession("anonymous-user");
    act(() => { emitOwn(confirmed); emitPopulation([confirmed]); });
    expect(result.current.active).toEqual(confirmed);
    expect(result.current.connection).toBe("live");
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(backend.track).toHaveBeenCalledWith("toilet_start", { mode: "live" });
  });

  it("releases a hung end's lock, keeps status pending, and preserves its first click on a late snapshot", async () => {
    const locks = installWebLocks();
    const { result } = await mountHook();
    await act(async () => { await result.current.start(); });
    const original = result.current.active;
    await advance(60_000);
    let resolveEnd!: () => void;
    backend.end.mockReturnValue(new Promise<void>((resolve) => { resolveEnd = resolve; }));
    await act(async () => { void result.current.end(); });
    expect(locks.held.size).toBe(1);
    await advance(15_000);
    expect(locks.held.size).toBe(0);
    expect(result.current.busy).toBe(false);
    expect(result.current.active).toEqual(original);
    expect(result.current.completed).toBeNull();
    expect(result.current.stats.entries).toHaveLength(0);
    expect(result.current.error).toContain("結果を確認できませんでした");
    act(() => { emitOwn(null); emitPopulation([]); });
    expect(result.current.completed?.durationMs).toBe(60_000);
    expect(result.current.error).toBeNull();
    await act(async () => { resolveEnd(); });
    expect(result.current.completed?.durationMs).toBe(60_000);
    expect(result.current.stats.entries).toHaveLength(1);
  });

  it("uses the original manual time when the timed-out end later resolves without a snapshot", async () => {
    const { result } = await mountHook();
    await act(async () => { await result.current.start(); });
    await advance(40_000);
    let resolveEnd!: () => void;
    backend.end.mockReturnValue(new Promise<void>((resolve) => { resolveEnd = resolve; }));
    act(() => { void result.current.end(); });
    await advance(30_000);
    await act(async () => { backend.own = null; resolveEnd(); });
    expect(result.current.active).toBeNull();
    expect(result.current.completed).toMatchObject({ durationMs: 40_000, reason: "manual" });
    expect(result.current.error).toBeNull();
  });

  it("keeps the first manual intent across reconnect and retry, ignoring the older action generation", async () => {
    const { result } = await mountHook();
    await act(async () => { await result.current.start(); });
    await advance(60_000);
    let resolveFirstEnd!: () => void;
    backend.end.mockReturnValueOnce(new Promise<void>((resolve) => { resolveFirstEnd = resolve; }));
    act(() => { void result.current.end(); });
    await advance(15_000);
    await act(async () => { result.current.retryConnection(); });
    expect(result.current.connection).toBe("live");
    await advance(1_000);
    await act(async () => { await result.current.end(); });
    expect(result.current.completed?.durationMs).toBe(60_000);
    await act(async () => { resolveFirstEnd(); });
    expect(result.current.completed?.durationMs).toBe(60_000);
    expect(result.current.stats.entries).toHaveLength(1);
    expect(result.current.busy).toBe(false);
  });
});

describe("useToiletSession: obsolete write guards", () => {
  beforeEach(() => { backend.mode = "live"; });

  it("does not let a late start from an older action replace a successfully retried visit", async () => {
    let resolveFirst!: (session: ActiveSession) => void;
    backend.start.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
    const { result } = await mountHook();
    const stale = createSession("anonymous-user");
    act(() => { void result.current.start(); });
    await advance(15_000);
    await act(async () => { result.current.retryConnection(); });
    await act(async () => { await result.current.start(); });
    const current = result.current.active;
    expect(current?.startedAt).toBeGreaterThan(stale.startedAt);
    await act(async () => { resolveFirst(stale); });
    expect(result.current.active).toEqual(current);
    expect(result.current.stats.entries).toHaveLength(0);
    expect(result.current.stats.count).toBe(1);
  });

  it("ignores an old start ACK when another tab has already established a newer visit", async () => {
    let resolveStart!: (session: ActiveSession) => void;
    backend.start.mockReturnValue(new Promise((resolve) => { resolveStart = resolve; }));
    const { result } = await mountHook();
    const stale = createSession("anonymous-user");
    act(() => { void result.current.start(); });
    await advance(15_000);
    const current = createSession("anonymous-user");
    act(() => { emitOwn(current); emitPopulation([current]); });
    await act(async () => { resolveStart(stale); });
    expect(result.current.active).toEqual(current);
    expect(result.current.completed).toBeNull();
    expect(result.current.stats.count).toBe(1);
  });

  it("keeps a newer visit active when an older timed-out end eventually acknowledges", async () => {
    const { result } = await mountHook();
    await act(async () => { await result.current.start(); });
    await advance(30_000);
    let resolveEnd!: () => void;
    backend.end.mockReturnValue(new Promise<void>((resolve) => { resolveEnd = resolve; }));
    act(() => { void result.current.end(); });
    await advance(15_000);
    const current = createSession("anonymous-user");
    act(() => { emitOwn(current); emitPopulation([current]); });
    expect(result.current.stats.entries[0]?.durationMs).toBe(30_000);
    await act(async () => { resolveEnd(); });
    expect(result.current.active).toEqual(current);
    expect(result.current.completed).toBeNull();
    expect(result.current.stats.count).toBe(2);
    expect(result.current.stats.entries).toHaveLength(1);
  });

  it("handles a rejection after timeout and retains the manual time until server reconciliation", async () => {
    const { result } = await mountHook();
    await act(async () => { await result.current.start(); });
    await advance(20_000);
    let rejectEnd!: (reason: Error) => void;
    backend.end.mockReturnValue(new Promise<void>((_resolve, reject) => { rejectEnd = reject; }));
    act(() => { void result.current.end(); });
    await advance(15_000);
    await act(async () => { rejectEnd(new Error("SDK lost its response")); });
    expect(result.current.active).not.toBeNull();
    expect(result.current.error).toContain("結果を確認できませんでした");
    await act(async () => { result.current.retryConnection(); });
    act(() => { emitOwn(null); emitPopulation([]); });
    expect(result.current.completed?.durationMs).toBe(20_000);
    expect(result.current.error).toBeNull();
  });

  it("releases an in-flight Web Lock on unmount without cancelling the server write", async () => {
    const locks = installWebLocks();
    backend.start.mockImplementation(() => new Promise<ActiveSession>(() => {}));
    const { result, unmount } = await mountHook();
    await act(async () => { void result.current.start(); });
    expect(locks.held.size).toBe(1);
    unmount();
    await act(async () => {});
    expect(locks.held.size).toBe(0);
    expect(backend.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not claim an unknown status once the server has already confirmed a hung start", async () => {
    backend.start.mockImplementation((uid) => {
      const session = createSession(uid);
      emitOwn(session);
      emitPopulation([session]);
      return new Promise<ActiveSession>(() => {});
    });
    const { result } = await mountHook();
    act(() => { void result.current.start(); });
    expect(result.current.active).not.toBeNull();
    await advance(15_000);
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.connection).toBe("live");
    expect(backend.track).toHaveBeenCalledTimes(1);
  });
});

describe("useToiletSession: privacy and SSR", () => {
  it("respects Do Not Track and Global Privacy Control", async () => {
    Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: "1" });
    const { result } = await mountHook();
    await act(async () => { await result.current.start(); await result.current.end(); });
    Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: null });
    Object.defineProperty(navigator, "globalPrivacyControl", { configurable: true, value: true });
    await advance(1_000);
    await act(async () => { await result.current.start(); await result.current.end(); });
    expect(backend.track).not.toHaveBeenCalled();
    expect(result.current.stats.count).toBe(2);
  });

  it("does not fail the core actions if tracking is blocked", async () => {
    backend.track.mockImplementation(() => { throw new Error("Tracking blocked"); });
    const { result } = await mountHook();
    await act(async () => { await result.current.start(); });
    await advance(1_000);
    await act(async () => { await result.current.end(); });
    expect(result.current.stats.count).toBe(1);
    expect(result.current.error).toBeNull();
    expect(result.current.completed?.durationMs).toBe(1_000);
  });

  it("server-renders a deterministic initial snapshot without reading browser storage", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("Server must not read browser storage"); });
    function Probe() {
      const state = useToiletSession();
      return <output>{JSON.stringify({ ready: state.ready, count: state.count, now: state.now, date: state.stats.date })}</output>;
    }
    const first = renderToString(<Probe />);
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1_000);
    expect(renderToString(<Probe />)).toBe(first);
    expect(first).toContain("&quot;ready&quot;:false");
    expect(first).toContain("&quot;count&quot;:12");
  });

  it("never sends visit identifiers or recorded times as analytics properties", async () => {
    const { result } = await mountHook();
    await act(async () => { await result.current.start(); });
    const key = getSessionKey(result.current.active!);
    await advance(10_000);
    await act(async () => { await result.current.end(); });
    expect(JSON.stringify(backend.track.mock.calls)).not.toContain(key);
    for (const [, properties] of backend.track.mock.calls) {
      expect(Object.keys(properties).every((name) => name === "mode" || name === "reason")).toBe(true);
    }
  });
});
