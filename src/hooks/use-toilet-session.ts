"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { track } from "@vercel/analytics";
import {
  endOwnSession,
  getFirebaseStatus,
  getOwnSession,
  signInAnonymousUser,
  startOwnSession,
  subscribeOwnSession,
  subscribePopulation,
  type PopulationSnapshot,
} from "@/lib/firebase-client";
import {
  appendHistory,
  clearActiveSession,
  createSession,
  finishSession,
  getBrowserStorage,
  getSessionKey,
  getTodayStats,
  isSessionActive,
  loadActiveSession,
  loadHistory,
  saveActiveSession,
  STORAGE_CHANGE_EVENT,
  withSessionLock,
  type ActiveSession,
  type DailyStats,
  type HistoryEntry,
} from "@/lib/session";
import { createScopedStorage, type ScopedStorage, type StorageMode } from "@/lib/scoped-storage";

export const DEMO_BASELINE = 12;
export const DEMO_SAMPLE_LIMIT = 24;
export const DEMO_SAMPLE_STORAGE_KEY = "toilet-population:sample-count:v1";
const CONNECTION_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 15_000;
const UNKNOWN_WRITE_MESSAGE = "変更の結果を確認できませんでした。処理が完了している場合もあります。再接続して状態を確認してください。";

type WriteWaitResult<T> = { kind: "confirmed"; value: T } | { kind: "timeout" | "abandoned" };
type PendingStart = { uid: string; isCurrent: () => boolean; confirmed: boolean; uncertain: boolean };
type PendingEnd = { key: string; session: ActiveSession; at: number; confirmed: boolean; uncertain: boolean };

export type SessionConnection = "connecting" | "live" | "offline" | "error" | "demo";

export interface ToiletSessionSnapshot {
  ready: boolean;
  mode: StorageMode;
  active: ActiveSession | null;
  completed: HistoryEntry | null;
  stats: DailyStats;
  now: number;
  count: number | null;
  connection: SessionConnection;
  busy: boolean;
  error: string | null;
  storageAvailable: boolean;
  sampleCount: number;
}

export interface ToiletSessionState extends ToiletSessionSnapshot {
  start(): Promise<void>;
  end(): Promise<void>;
  dismissCompleted(): void;
  addDemoPerson(): void;
  resetDemoPeople(): void;
  retryConnection(): void;
}

function trackAction(name: "toilet_start" | "toilet_end", mode: StorageMode, reason?: HistoryEntry["reason"]) {
  if (typeof navigator === "undefined") return;
  if (navigator.doNotTrack === "1" || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) return;
  try {
    // Analytics never carries a UID, timestamp, duration, or history and cannot block an action.
    void Promise.resolve(track(name, reason ? { mode, reason } : { mode })).catch(() => {});
  } catch {
    // The core interaction must also work with tracking blocked by the browser.
  }
}

function sameSession(a: ActiveSession | null, b: ActiveSession | null): boolean {
  return a !== null && b !== null && getSessionKey(a) === getSessionKey(b);
}

/**
 * An imperative adapter for the browser's storage, clock and Firestore subscriptions.
 * React receives immutable cached snapshots, including a deterministic SSR snapshot.
 */
function createSessionController(mode: StorageMode) {
  const initial: ToiletSessionSnapshot = {
    ready: false,
    mode,
    active: null,
    completed: null,
    stats: { date: "", count: 0, totalDurationMs: 0, entries: [] },
    now: 0,
    count: mode === "demo" ? DEMO_BASELINE : null,
    connection: mode === "demo" ? "demo" : "connecting",
    busy: false,
    error: null,
    storageAvailable: true,
    sampleCount: DEMO_BASELINE,
  };
  let state = initial;
  let storage: ScopedStorage | null = null;
  let history: HistoryEntry[] = [];
  const listeners = new Set<() => void>();
  let mounted = false;
  let lifecycle = 0;
  let connectionGeneration = 0;
  let operationGeneration = 0;
  let operation: Promise<void> | null = null;
  let uid: string | null = null;
  let online = true;
  let connecting = false;
  let ownReady = false;
  let connectionError: string | null = null;
  let ownError: string | null = null;
  let populationError: string | null = null;
  let actionError: string | null = null;
  let unknownWrite: number | null = null;
  let population: PopulationSnapshot | null = null;
  let unsubscribeOwn: (() => void) | undefined;
  let unsubscribePopulation: (() => void) | undefined;
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let scheduledExpiry = 0;
  let storageMutation = false;
  let syncingStorage = false;
  let pendingStart: PendingStart | null = null;
  let pendingEnd: PendingEnd | null = null;
  const connectionTimers = new Set<ReturnType<typeof setTimeout>>();
  const abandonWriteWaiters = new Set<() => void>();

  const connectionState = (): SessionConnection => {
    if (mode === "demo") return "demo";
    if (!online) return "offline";
    if (connectionError || ownError || populationError || unknownWrite !== null) return "error";
    if (connecting || !uid || !ownReady) return "connecting";
    if (population?.fromCache) return "offline";
    return population ? "live" : "connecting";
  };

  const publish = (patch: Partial<ToiletSessionSnapshot> = {}) => {
    if (!mounted) return;
    const next = { ...state, ...patch };
    next.stats = getTodayStats(history, next.active, next.now);
    next.count = mode === "demo"
      ? next.sampleCount + Number(isSessionActive(next.active, next.now))
      : population ? population.sessions.filter((session) => isSessionActive(session, next.now)).length : null;
    next.connection = connectionState();
    next.error = actionError ?? connectionError ?? ownError ?? populationError;
    next.storageAvailable = storage?.persistent ?? false;
    state = next;
    const expiresAt = next.active?.expiresAt ?? 0;
    if (expiresAt !== scheduledExpiry) {
      if (expiryTimer) clearTimeout(expiryTimer);
      scheduledExpiry = expiresAt;
      expiryTimer = expiresAt ? setTimeout(tick, Math.max(0, expiresAt - Date.now())) : undefined;
    }
    for (const listener of listeners) listener();
  };

  const mutateStorage = (mutation: () => void) => {
    storageMutation = true;
    try { mutation(); }
    finally { storageMutation = false; }
  };

  const sampleCount = () => {
    const value = Number(storage?.getItem(DEMO_SAMPLE_STORAGE_KEY));
    return Number.isInteger(value) && value >= DEMO_BASELINE && value <= DEMO_SAMPLE_LIMIT ? value : DEMO_BASELINE;
  };

  const recordCompletion = (session: ActiveSession, reason: HistoryEntry["reason"], at: number): HistoryEntry => {
    const candidate = finishSession(session, reason, at);
    const previous = loadHistory(storage).find((entry) => entry.id === candidate.id);
    mutateStorage(() => {
      appendHistory(candidate, storage);
      clearActiveSession(session, storage);
    });
    history = loadHistory(storage);
    const entry = history.find((item) => item.id === candidate.id) ?? candidate;
    if (!previous) trackAction("toilet_end", mode, entry.reason);
    return entry;
  };

  const removeExpiredRemote = (session: ActiveSession) => {
    if (mode !== "live" || uid !== session.id || !online) return;
    // TTL/query filtering handles expiry even if this best-effort owner cleanup fails.
    void endOwnSession(uid, session.startedAt).catch(() => {});
  };

  const complete = (session: ActiveSession, reason: HistoryEntry["reason"], at: number) => {
    const entry = recordCompletion(session, reason, at);
    const saved = loadActiveSession(storage);
    const next = saved && !sameSession(saved, session) ? saved : null;
    publish({ active: next, completed: entry, now: Date.now() });
    if (entry.reason === "expired") removeExpiredRemote(session);
  };

  const syncStorage = () => {
    if (!mounted || !storage || syncingStorage || storageMutation) return;
    syncingStorage = true;
    try {
      const now = Date.now();
      const previous = state.active;
      history = loadHistory(storage);
      let saved = loadActiveSession(storage);
      let completed: HistoryEntry | null = null;
      if (saved && mode === "live" && uid && saved.id !== uid) {
        const stale = saved;
        mutateStorage(() => { clearActiveSession(stale, storage); });
        saved = null;
      }
      if (saved) {
        const savedKey = getSessionKey(saved);
        const alreadyFinished = history.find((entry) => entry.id === savedKey);
        if (alreadyFinished) {
          const finished = saved;
          mutateStorage(() => { clearActiveSession(finished, storage); });
          completed = alreadyFinished;
          saved = null;
        } else if (!isSessionActive(saved, now)) {
          const expired = saved;
          completed = recordCompletion(expired, "expired", now);
          saved = loadActiveSession(storage);
          removeExpiredRemote(expired);
        }
      }
      const previousEntry = previous ? history.find((entry) => entry.id === getSessionKey(previous)) : undefined;
      if (!saved && previousEntry) completed = previousEntry;
      // Clearing local cache cannot falsely claim that a live server session ended.
      if (!saved && !previousEntry && previous && mode === "live" && (!uid || uid === previous.id)) {
        if (isSessionActive(previous, now)) saved = previous;
        else completed = recordCompletion(previous, "expired", now);
      }
      const lastCompleted = state.completed ? history.find((entry) => entry.id === state.completed?.id) ?? state.completed : null;
      publish({
        active: saved,
        completed: saved ? null : completed ?? lastCompleted,
        sampleCount: sampleCount(),
        now,
      });
    } finally {
      syncingStorage = false;
    }
  };

  function tick() {
    if (!mounted) return;
    const now = Date.now();
    if (state.active && !isSessionActive(state.active, now)) complete(state.active, "expired", now);
    else publish({ now });
  }

  const clearUnknownWrite = (token?: number) => {
    if (token !== undefined && unknownWrite !== token) return;
    unknownWrite = null;
    if (actionError === UNKNOWN_WRITE_MESSAGE) actionError = null;
  };

  const markUnknownWrite = (token: number) => {
    unknownWrite = token;
    actionError = UNKNOWN_WRITE_MESSAGE;
    publish();
  };

  const receiveOwnSession = (session: ActiveSession | null) => {
    if (!mounted) return;
    // This callback only receives authoritative server snapshots, never an empty cache.
    clearUnknownWrite();
    ownReady = true;
    ownError = null;
    history = loadHistory(storage);
    const now = Date.now();
    if (!session) {
      const current = state.active;
      if (current) {
        const request = pendingEnd?.key === getSessionKey(current) ? pendingEnd : null;
        const at = request?.at ?? now;
        complete(current, isSessionActive(current, now) ? "manual" : "expired", at);
        if (request) {
          request.confirmed = true;
          if (pendingEnd === request) pendingEnd = null;
        }
      } else publish({ now });
      return;
    }
    if (history.some((entry) => entry.id === getSessionKey(session))) {
      // A delayed snapshot must not resurrect a visit already completed by another tab.
      publish({ now });
      return;
    }
    if (state.active && !sameSession(state.active, session)) {
      const request = pendingEnd?.key === getSessionKey(state.active) ? pendingEnd : null;
      recordCompletion(state.active, isSessionActive(state.active, now) ? "manual" : "expired", request?.at ?? Math.min(now, session.startedAt));
      if (request) {
        request.confirmed = true;
        if (pendingEnd === request) pendingEnd = null;
      }
    }
    if (!isSessionActive(session, now)) {
      complete(session, "expired", now);
      return;
    }
    mutateStorage(() => { saveActiveSession(session, storage); });
    publish({ active: session, completed: null, now });
    if (pendingStart?.uid === session.id && pendingStart.isCurrent() && !pendingStart.confirmed) {
      pendingStart.confirmed = true;
      trackAction("toilet_start", mode);
    }
  };

  const stopSubscriptions = () => {
    unsubscribeOwn?.();
    unsubscribePopulation?.();
    unsubscribeOwn = undefined;
    unsubscribePopulation = undefined;
    for (const timer of connectionTimers) clearTimeout(timer);
    connectionTimers.clear();
  };

  const withinConnectionDeadline = <T,>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      connectionTimers.delete(timeout);
      reject(new Error("Connection timed out."));
    }, CONNECTION_TIMEOUT_MS);
    connectionTimers.add(timeout);
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timeout);
      connectionTimers.delete(timeout);
    });
  });

  /**
   * This deadline is awaited inside the Web Lock callback, releasing both the UI
   * and the cross-tab lock. It cancels waiting, not the underlying Firebase write.
   */
  const withinWriteDeadline = <T,>(
    promise: Promise<T>,
    onLateConfirmation: (value: T) => void,
  ): Promise<WriteWaitResult<T>> => new Promise((resolve, reject) => {
    let phase: "waiting" | "timeout" | "abandoned" | "settled" = "waiting";
    const finishWaiting = () => {
      clearTimeout(timer);
      abandonWriteWaiters.delete(abandon);
    };
    const abandon = () => {
      if (phase !== "waiting") return;
      phase = "abandoned";
      finishWaiting();
      resolve({ kind: "abandoned" });
    };
    const timer = setTimeout(() => {
      if (phase !== "waiting") return;
      phase = "timeout";
      finishWaiting();
      resolve({ kind: "timeout" });
    }, WRITE_TIMEOUT_MS);
    abandonWriteWaiters.add(abandon);
    void promise.then((value) => {
      const previous = phase;
      phase = "settled";
      finishWaiting();
      if (previous === "waiting") resolve({ kind: "confirmed", value });
      else if (previous === "timeout") onLateConfirmation(value);
    }, (error: unknown) => {
      const previous = phase;
      phase = "settled";
      finishWaiting();
      if (previous === "waiting") reject(error);
      // After a timeout the outcome stays unknown until an authoritative read.
      // Keep the original manual-end intent even if the SDK rejects later.
    }).catch(() => {
      // Late callbacks must not leak unhandled rejections after unmount/timeout.
    });
  });

  const connect = async () => {
    if (!mounted || mode !== "live") return;
    const token = ++connectionGeneration;
    const life = lifecycle;
    stopSubscriptions();
    connecting = true;
    ownReady = false;
    connectionError = null;
    ownError = null;
    populationError = null;
    actionError = null;
    unknownWrite = null;
    publish();
    const stillCurrent = () => mounted && lifecycle === life && connectionGeneration === token;
    try {
      const authenticatedUid = await withinConnectionDeadline(signInAnonymousUser());
      if (!stillCurrent()) return;
      uid = authenticatedUid;
      syncStorage();
      const own = await withinConnectionDeadline(getOwnSession(authenticatedUid));
      if (!stillCurrent()) return;
      receiveOwnSession(own);
      connecting = false;
      unsubscribeOwn = subscribeOwnSession(authenticatedUid, (session) => {
        if (stillCurrent()) receiveOwnSession(session);
      }, () => {
        if (!stillCurrent()) return;
        ownError = "自分の状態を同期できませんでした。再接続してください。";
        publish();
      });
      unsubscribePopulation = subscribePopulation((update) => {
        if (!stillCurrent()) return;
        population = update;
        populationError = null;
        publish({ now: Date.now() });
      }, () => {
        if (!stillCurrent()) return;
        populationError = "人数を更新できませんでした。通信環境と Firebase の設定を確認してください。";
        publish();
      });
      publish();
    } catch {
      if (!stillCurrent()) return;
      connecting = false;
      connectionError = "接続できませんでした。通信環境と Firebase の設定を確認して、再接続してください。";
      publish();
    }
  };

  const perform = (action: (isCurrent: () => boolean, token: number) => Promise<void>): Promise<void> => {
    if (!mounted || !state.ready) return Promise.resolve();
    if (operation) return operation;
    const life = lifecycle;
    const token = ++operationGeneration;
    const isCurrent = () => mounted && lifecycle === life && operationGeneration === token;
    actionError = null;
    publish({ busy: true });
    operation = (async () => {
      try {
        await withSessionLock(async () => {
          if (isCurrent()) await action(isCurrent, token);
        });
      } catch {
        if (isCurrent()) {
          actionError = "状態を変更できませんでした。接続を確認して、もう一度お試しください。";
          publish();
        }
      } finally {
        if (token === operationGeneration) {
          operation = null;
          if (isCurrent()) publish({ busy: false });
        }
      }
    })();
    return operation;
  };

  const canWriteLive = () => {
    if (uid && online && navigator.onLine !== false && connectionState() === "live") return true;
    actionError = "未接続のため変更できません。再接続してお試しください。開始済みの状態は10分で自動解除されます。";
    publish();
    return false;
  };

  const start = () => perform(async (isCurrent, token) => {
    syncStorage();
    if (isSessionActive(state.active)) return;
    if (mode === "live") {
      if (!canWriteLive() || !uid) return;
      const request: PendingStart = { uid, isCurrent, confirmed: false, uncertain: false };
      pendingStart = request;
      const confirm = (session: ActiveSession) => {
        if (!isCurrent() || session.id !== uid) return;
        history = loadHistory(storage);
        const newerVisit = (state.active && state.active.startedAt > session.startedAt)
          || history.some((entry) => entry.startedAt > session.startedAt);
        if (newerVisit) {
          clearUnknownWrite(token);
          publish();
          return;
        }
        receiveOwnSession(session);
      };
      try {
        const result = await withinWriteDeadline(startOwnSession(uid), confirm);
        if (!isCurrent() || result.kind === "abandoned") return;
        if (result.kind === "confirmed") confirm(result.value);
        else {
          request.uncertain = true;
          if (!request.confirmed) markUnknownWrite(token);
        }
      } finally {
        if (!request.uncertain && pendingStart === request) pendingStart = null;
      }
      return;
    }
    const session = createSession(`demo-${crypto.randomUUID()}`);
    mutateStorage(() => { saveActiveSession(session, storage); });
    publish({ active: session, completed: null, now: Date.now() });
    trackAction("toilet_start", mode);
  });

  const end = () => perform(async (isCurrent, token) => {
    syncStorage();
    const session = state.active;
    if (!session) return;
    const at = Date.now();
    if (!isSessionActive(session, at)) { complete(session, "expired", at); return; }
    if (mode === "demo") { complete(session, "manual", at); return; }
    if (!canWriteLive() || !uid || session.id !== uid) return;
    const key = getSessionKey(session);
    const request: PendingEnd = pendingEnd?.key === key ? pendingEnd : { key, session, at, confirmed: false, uncertain: false };
    pendingEnd = request;
    const confirm = () => {
      if (!isCurrent() || request.session.id !== uid) return;
      clearUnknownWrite(token);
      const existing = loadHistory(storage).find((entry) => entry.id === request.key);
      if (sameSession(state.active, request.session) || (!state.active && !existing)) {
        complete(request.session, "manual", request.at);
      } else {
        // A late ACK may correct an old duration, but cannot clear a newer visit
        // or reopen a completion panel the user already dismissed.
        const entry = recordCompletion(request.session, "manual", request.at);
        publish({ completed: state.completed?.id === entry.id ? entry : state.completed, now: Date.now() });
      }
      request.confirmed = true;
      if (pendingEnd === request) pendingEnd = null;
    };
    try {
      const result = await withinWriteDeadline(endOwnSession(uid, session.startedAt), confirm);
      if (!isCurrent() || result.kind === "abandoned") return;
      if (result.kind === "confirmed") confirm();
      else {
        request.uncertain = true;
        if (!request.confirmed) markUnknownWrite(token);
      }
    } finally {
      if (!request.uncertain && pendingEnd === request) pendingEnd = null;
    }
  });

  const updateSample = (reset: boolean) => {
    if (!mounted || !state.ready || mode !== "demo" || !storage) return;
    const next = reset ? DEMO_BASELINE : Math.min(DEMO_SAMPLE_LIMIT, sampleCount() + 1);
    mutateStorage(() => {
      storage?.setItem(DEMO_SAMPLE_STORAGE_KEY, String(next));
      window.dispatchEvent(new Event(STORAGE_CHANGE_EVENT));
    });
    publish({ sampleCount: next });
  };

  const onStorage = (event: Event) => {
    if (event instanceof StorageEvent && storage && !storage.ownsKey(event.key)) return;
    syncStorage();
  };
  const onOffline = () => { online = false; publish({ now: Date.now() }); };
  const onOnline = () => { online = true; syncStorage(); void connect(); };
  const onVisibility = () => {
    syncStorage();
    tick();
    if (!document.hidden && online && (connectionState() === "offline" || connectionState() === "error")) void connect();
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    mount() {
      mounted = true;
      lifecycle += 1;
      storage ??= createScopedStorage(mode, getBrowserStorage());
      online = navigator.onLine !== false;
      syncStorage();
      publish({ ready: true, busy: false, now: Date.now() });
      window.addEventListener("storage", onStorage);
      window.addEventListener(STORAGE_CHANGE_EVENT, onStorage);
      window.addEventListener("offline", onOffline);
      window.addEventListener("online", onOnline);
      document.addEventListener("visibilitychange", onVisibility);
      clockTimer = setInterval(tick, 1_000);
      if (mode === "live") void connect();
      return () => {
        mounted = false;
        lifecycle += 1;
        connectionGeneration += 1;
        operationGeneration += 1;
        operation = null;
        pendingStart = null;
        pendingEnd = null;
        for (const abandon of [...abandonWriteWaiters]) abandon();
        stopSubscriptions();
        if (clockTimer) clearInterval(clockTimer);
        if (expiryTimer) clearTimeout(expiryTimer);
        scheduledExpiry = 0;
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(STORAGE_CHANGE_EVENT, onStorage);
        window.removeEventListener("offline", onOffline);
        window.removeEventListener("online", onOnline);
        document.removeEventListener("visibilitychange", onVisibility);
        // Never delete the session on unload: another tab or a later reload restores it.
      };
    },
    actions: {
      start,
      end,
      dismissCompleted: () => { publish({ completed: null }); },
      addDemoPerson: () => { updateSample(false); },
      resetDemoPeople: () => { updateSample(true); },
      retryConnection: () => { void connect(); },
    },
  };
}

export function useToiletSession(): ToiletSessionState {
  const [controller] = useState(() => createSessionController(getFirebaseStatus().mode));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  useEffect(() => controller.mount(), [controller]);
  return { ...snapshot, ...controller.actions };
}
