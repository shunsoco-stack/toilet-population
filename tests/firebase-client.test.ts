// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PopulationSnapshot } from "../src/lib/firebase-client";
import type { ActiveSession } from "../src/lib/session";

type Reference = { kind: "document" | "collection" | "query"; collection?: string; id?: string; constraints?: unknown[] };
type Listener = {
  reference: Reference;
  next: (snapshot: unknown) => void;
  error: (error: Error) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => {
  class MockTimestamp {
    constructor(readonly seconds: number, readonly nanoseconds: number) {}
    static fromMillis(value: number) {
      const seconds = Math.floor(value / 1_000);
      return new MockTimestamp(seconds, Math.round((value - seconds * 1_000) * 1_000_000));
    }
    toMillis() { return this.seconds * 1_000 + this.nanoseconds / 1_000_000; }
    isEqual(other: MockTimestamp) { return this.seconds === other.seconds && this.nanoseconds === other.nanoseconds; }
  }
  class MockFirebaseError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  }
  const auth = {
    currentUser: { uid: "owner" } as { uid: string } | null,
    authStateReady: vi.fn<() => Promise<void>>(),
  };
  return {
    Timestamp: MockTimestamp,
    FirebaseError: MockFirebaseError,
    auth,
    app: { name: "toilet-population" },
    db: {},
    listeners: [] as Listener[],
    getApps: vi.fn(),
    initializeApp: vi.fn(),
    getAuth: vi.fn(),
    getFirestore: vi.fn(),
    setPersistence: vi.fn(),
    signInAnonymously: vi.fn(),
    connectAuthEmulator: vi.fn(),
    connectFirestoreEmulator: vi.fn(),
    onSnapshot: vi.fn(),
    getDocFromServer: vi.fn(),
    runTransaction: vi.fn(),
    serverTimestamp: vi.fn(),
    where: vi.fn(),
  };
});

vi.mock("firebase/app", () => ({
  FirebaseError: mocks.FirebaseError,
  getApps: mocks.getApps,
  initializeApp: mocks.initializeApp,
}));
vi.mock("firebase/auth", () => ({
  browserLocalPersistence: "local",
  getAuth: mocks.getAuth,
  setPersistence: mocks.setPersistence,
  signInAnonymously: mocks.signInAnonymously,
  connectAuthEmulator: mocks.connectAuthEmulator,
}));
vi.mock("firebase/firestore", () => ({
  Timestamp: mocks.Timestamp,
  getFirestore: mocks.getFirestore,
  connectFirestoreEmulator: mocks.connectFirestoreEmulator,
  onSnapshot: mocks.onSnapshot,
  getDocFromServer: mocks.getDocFromServer,
  runTransaction: mocks.runTransaction,
  serverTimestamp: mocks.serverTimestamp,
  where: mocks.where,
  collection: (_db: unknown, collection: string): Reference => ({ kind: "collection", collection }),
  doc: (_db: unknown, collection: string, id: string): Reference => ({ kind: "document", collection, id }),
  query: (reference: Reference, ...constraints: unknown[]): Reference => ({ ...reference, kind: "query", constraints }),
}));

const NOW = new Date("2026-08-27T03:00:00.000Z").getTime();
const stops: (() => void)[] = [];
const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

function documentData(startedAt: number, expiresAt = startedAt + 600_000) {
  return { startedAt: mocks.Timestamp.fromMillis(startedAt), expiresAt: mocks.Timestamp.fromMillis(expiresAt) };
}

function documentSnapshot(
  id: string,
  data: ReturnType<typeof documentData> | Record<string, unknown> | null,
  fromCache = false,
  hasPendingWrites = false,
) {
  return {
    id,
    exists: () => data !== null,
    data: () => data ?? undefined,
    metadata: { fromCache, hasPendingWrites },
  };
}

function querySnapshot(
  docs: ReturnType<typeof documentSnapshot>[],
  fromCache = false,
  hasPendingWrites = false,
) {
  return { docs, metadata: { fromCache, hasPendingWrites } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetModules();
  vi.resetAllMocks();
  mocks.listeners.length = 0;
  mocks.auth.currentUser = { uid: "owner" };
  mocks.auth.authStateReady.mockResolvedValue();
  mocks.getApps.mockReturnValue([]);
  mocks.initializeApp.mockReturnValue(mocks.app);
  mocks.getAuth.mockReturnValue(mocks.auth);
  mocks.getFirestore.mockReturnValue(mocks.db);
  mocks.setPersistence.mockResolvedValue(undefined);
  mocks.signInAnonymously.mockImplementation(async () => {
    mocks.auth.currentUser = { uid: "new-anonymous-user" };
    return { user: mocks.auth.currentUser };
  });
  mocks.where.mockImplementation((field, operator, value) => ({ field, operator, value }));
  mocks.getDocFromServer.mockResolvedValue(documentSnapshot("owner", null));
  mocks.serverTimestamp.mockReturnValue({ sentinel: "server-timestamp" });
  mocks.onSnapshot.mockImplementation((reference: Reference, _options: unknown, next: Listener["next"], error: Listener["error"]) => {
    const listener = { reference, next, error, unsubscribe: vi.fn() };
    mocks.listeners.push(listener);
    return listener.unsubscribe;
  });
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "demo-public-client-key");
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "demo-toilet-population.firebaseapp.com");
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "demo-toilet-population");
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_APP_ID", "demo-public-app-id");
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_USE_EMULATORS", "false");
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
  else Reflect.deleteProperty(navigator, "locks");
});

describe("Firebase configuration and anonymous identity restoration", () => {
  it("uses explicit demo mode when configuration is missing and never creates a fake Firebase identity", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "");
    const client = await import("../src/lib/firebase-client");
    expect(client.getFirebaseStatus()).toMatchObject({ configured: false, mode: "demo", missing: ["NEXT_PUBLIC_FIREBASE_API_KEY"] });
    await expect(client.signInAnonymousUser()).rejects.toThrow("not configured");
    expect(mocks.initializeApp).not.toHaveBeenCalled();
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
  });

  it("waits for persisted auth restoration before deciding to create an anonymous user", async () => {
    mocks.auth.currentUser = null;
    const restored = deferred<void>();
    mocks.auth.authStateReady.mockReturnValue(restored.promise);
    const client = await import("../src/lib/firebase-client");
    const signingIn = client.signInAnonymousUser();
    await Promise.resolve();
    expect(mocks.auth.authStateReady).toHaveBeenCalledOnce();
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
    mocks.auth.currentUser = { uid: "restored-owner" };
    restored.resolve();
    await expect(signingIn).resolves.toBe("restored-owner");
    expect(mocks.setPersistence).toHaveBeenCalledWith(mocks.auth, "local");
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
  });

  it("deduplicates simultaneous sign-in calls into one anonymous account", async () => {
    mocks.auth.currentUser = null;
    const client = await import("../src/lib/firebase-client");
    const identities = await Promise.all([client.signInAnonymousUser(), client.signInAnonymousUser(), client.signInAnonymousUser()]);
    expect(identities).toEqual(["new-anonymous-user", "new-anonymous-user", "new-anonymous-user"]);
    expect(mocks.signInAnonymously).toHaveBeenCalledOnce();
    expect(mocks.setPersistence).toHaveBeenCalledOnce();
  });

  it("also uses a browser-wide auth lock when available", async () => {
    const request = vi.fn(async (_name: string, action: () => Promise<string>) => action());
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    const client = await import("../src/lib/firebase-client");
    await expect(client.signInAnonymousUser()).resolves.toBe("owner");
    expect(request).toHaveBeenCalledWith("toilet-population:anonymous-auth", expect.any(Function));
  });

  it("surfaces a persistence failure without silently falling back to demo and allows a retry", async () => {
    mocks.setPersistence.mockRejectedValueOnce(new Error("Storage blocked"));
    const client = await import("../src/lib/firebase-client");
    await expect(client.signInAnonymousUser()).rejects.toThrow("Storage blocked");
    expect(client.getFirebaseStatus().mode).toBe("live");
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
    await expect(client.signInAnonymousUser()).resolves.toBe("owner");
  });

  it("connects configured local emulators only once for the app instance", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_USE_EMULATORS", "true");
    const client = await import("../src/lib/firebase-client");
    await client.signInAnonymousUser();
    await client.getOwnSession("owner");
    expect(mocks.connectAuthEmulator).toHaveBeenCalledOnce();
    expect(mocks.connectFirestoreEmulator).toHaveBeenCalledWith(mocks.db, "127.0.0.1", 8187);
  });
});

describe("real-time population adapter", () => {
  it("queries a present-time expiry cutoff and counts valid sessions, never drafts or expired data", async () => {
    const client = await import("../src/lib/firebase-client");
    const onChange = vi.fn<(snapshot: PopulationSnapshot) => void>();
    stops.push(client.subscribePopulation(onChange, vi.fn()));
    expect(mocks.where).toHaveBeenCalledWith("expiresAt", ">", mocks.Timestamp.fromMillis(NOW));
    mocks.listeners[0].next(querySnapshot([
      documentSnapshot("active", documentData(NOW - 1_000)),
      documentSnapshot("expired", documentData(NOW - 600_000)),
      documentSnapshot("draft", documentData(NOW, NOW)),
      documentSnapshot("invalid", { startedAt: "bad", expiresAt: NOW + 600_000 }),
    ]));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ count: 1, fromCache: false }));
    expect(onChange.mock.lastCall![0].sessions[0].id).toBe("active");
  });

  it("prunes a foreign session at its deadline without a server snapshot or TTL deletion", async () => {
    const client = await import("../src/lib/firebase-client");
    const onChange = vi.fn<(snapshot: PopulationSnapshot) => void>();
    stops.push(client.subscribePopulation(onChange, vi.fn()));
    mocks.listeners[0].next(querySnapshot([
      documentSnapshot("expires-soon", documentData(NOW - 598_500)),
      documentSnapshot("still-active", documentData(NOW)),
    ]));
    expect(onChange.mock.lastCall![0].count).toBe(2);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(onChange.mock.lastCall![0].count).toBe(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(onChange.mock.lastCall![0].count).toBe(1);
    expect(onChange.mock.lastCall![0].sessions[0].id).toBe("still-active");
    expect(mocks.onSnapshot).toHaveBeenCalledOnce();
  });

  it("renews the query cutoff and ignores callbacks from the replaced listener", async () => {
    const client = await import("../src/lib/firebase-client");
    const onChange = vi.fn<(snapshot: PopulationSnapshot) => void>();
    stops.push(client.subscribePopulation(onChange, vi.fn()));
    const first = mocks.listeners[0];
    first.next(querySnapshot([documentSnapshot("person", documentData(NOW))]));
    await vi.advanceTimersByTimeAsync(client.POPULATION_REFRESH_MS);
    expect(first.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.where).toHaveBeenLastCalledWith("expiresAt", ">", mocks.Timestamp.fromMillis(NOW + 20_000));
    const priorCalls = onChange.mock.calls.length;
    first.next(querySnapshot([]));
    expect(onChange.mock.calls.length).toBe(priorCalls);
    mocks.listeners[1].next(querySnapshot([]));
    expect(onChange.mock.lastCall![0].count).toBe(0);
  });

  it("preserves last confirmed records through an empty query-renewal cache and labels them stale", async () => {
    const client = await import("../src/lib/firebase-client");
    const onChange = vi.fn<(snapshot: PopulationSnapshot) => void>();
    stops.push(client.subscribePopulation(onChange, vi.fn()));
    mocks.listeners[0].next(querySnapshot([documentSnapshot("person", documentData(NOW))]));
    await vi.advanceTimersByTimeAsync(client.POPULATION_REFRESH_MS);
    mocks.listeners[1].next(querySnapshot([], true));
    expect(onChange.mock.lastCall![0]).toMatchObject({ count: 1, fromCache: true });
    mocks.listeners[1].next(querySnapshot([]));
    expect(onChange.mock.lastCall![0]).toMatchObject({ count: 0, fromCache: false });
  });

  it("does not count optimistic pending writes before server confirmation", async () => {
    const client = await import("../src/lib/firebase-client");
    const onChange = vi.fn();
    stops.push(client.subscribePopulation(onChange, vi.fn()));
    mocks.listeners[0].next(querySnapshot([documentSnapshot("pending", documentData(NOW))], false, true));
    expect(onChange).not.toHaveBeenCalled();
    mocks.listeners[0].next(querySnapshot([documentSnapshot("confirmed", documentData(NOW))]));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ count: 1 }));
  });

  it("continues expiry pruning offline without presenting the count as live", async () => {
    const client = await import("../src/lib/firebase-client");
    const onChange = vi.fn<(snapshot: PopulationSnapshot) => void>();
    stops.push(client.subscribePopulation(onChange, vi.fn()));
    mocks.listeners[0].next(querySnapshot([documentSnapshot("person", documentData(NOW - 599_000))]));
    window.dispatchEvent(new Event("offline"));
    expect(onChange.mock.lastCall![0]).toMatchObject({ count: 1, fromCache: true });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(onChange.mock.lastCall![0]).toMatchObject({ count: 0, fromCache: true });
  });

  it("reports subscription errors, releases subscriptions/timers, and ignores late callbacks", async () => {
    const client = await import("../src/lib/firebase-client");
    const onChange = vi.fn();
    const onError = vi.fn();
    const stop = client.subscribePopulation(onChange, onError);
    const listener = mocks.listeners[0];
    listener.next(querySnapshot([documentSnapshot("person", documentData(NOW))]));
    const denied = new Error("Permission denied");
    listener.error(denied);
    expect(onError).toHaveBeenCalledWith(denied);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ fromCache: true }));
    stop();
    const before = onChange.mock.calls.length;
    listener.next(querySnapshot([]));
    listener.error(new Error("late"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(600_001);
    expect(listener.unsubscribe).toHaveBeenCalledOnce();
    expect(onChange.mock.calls.length).toBe(before);
    expect(onError).toHaveBeenCalledOnce();
    expect(mocks.onSnapshot).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses periodic query renewal when hidden and catches up on visibility", async () => {
    const client = await import("../src/lib/firebase-client");
    stops.push(client.subscribePopulation(vi.fn(), vi.fn()));
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(client.POPULATION_REFRESH_MS * 2);
    expect(mocks.onSnapshot).toHaveBeenCalledOnce();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(mocks.onSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.where).toHaveBeenLastCalledWith("expiresAt", ">", mocks.Timestamp.fromMillis(NOW + 40_000));
  });

  it("does not silently truncate a population larger than common query limits", async () => {
    const client = await import("../src/lib/firebase-client");
    const onChange = vi.fn<(snapshot: PopulationSnapshot) => void>();
    stops.push(client.subscribePopulation(onChange, vi.fn()));
    mocks.listeners[0].next(querySnapshot(Array.from({ length: 1_501 }, (_, index) =>
      documentSnapshot(`person-${index}`, documentData(NOW)),
    )));
    expect(onChange.mock.lastCall![0].count).toBe(1_501);
  });
});

describe("own-session adapter and write guards", () => {
  it("ignores drafts, pending writes, and empty offline cache snapshots rather than falsely finishing", async () => {
    const client = await import("../src/lib/firebase-client");
    const onChange = vi.fn<(session: ActiveSession | null) => void>();
    stops.push(client.subscribeOwnSession("owner", onChange, vi.fn()));
    const listener = mocks.listeners[0];
    listener.next(documentSnapshot("owner", null, true));
    listener.next(documentSnapshot("owner", documentData(NOW), false, true));
    listener.next(documentSnapshot("owner", documentData(NOW, NOW)));
    expect(onChange).not.toHaveBeenCalled();
    listener.next(documentSnapshot("owner", documentData(NOW)));
    expect(onChange).toHaveBeenLastCalledWith({ id: "owner", startedAt: NOW, expiresAt: NOW + 600_000 });
    listener.next(documentSnapshot("owner", null));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("returns expired own state so a reload can reconstruct its bounded history", async () => {
    mocks.getDocFromServer.mockResolvedValue(documentSnapshot("owner", documentData(NOW - 700_000)));
    const client = await import("../src/lib/firebase-client");
    await expect(client.getOwnSession("owner")).resolves.toEqual({
      id: "owner", startedAt: NOW - 700_000, expiresAt: NOW - 100_000,
    });
  });

  it("rejects another UID before performing a read or write", async () => {
    const client = await import("../src/lib/firebase-client");
    await expect(client.getOwnSession("another-owner")).rejects.toThrow("authentication");
    await expect(client.startOwnSession("another-owner")).rejects.toThrow("authentication");
    await expect(client.endOwnSession("another-owner")).rejects.toThrow("authentication");
    expect(mocks.getDocFromServer).not.toHaveBeenCalled();
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("arms a server reservation without losing nanoseconds or extending the 600-second duration", async () => {
    const startedAt = new mocks.Timestamp(Math.floor(NOW / 1_000), 123_456_789);
    let stored: ReturnType<typeof documentData> | null = null;
    const transaction = {
      get: vi.fn(async () => documentSnapshot("owner", stored)),
      set: vi.fn(() => { stored = { startedAt, expiresAt: startedAt }; }),
      update: vi.fn((_reference: Reference, patch: { expiresAt: InstanceType<typeof mocks.Timestamp> }) => {
        stored = { startedAt, expiresAt: patch.expiresAt };
      }),
    };
    mocks.runTransaction.mockImplementation(async (_db: unknown, body: (transaction: unknown) => Promise<unknown>) => body(transaction));
    const client = await import("../src/lib/firebase-client");
    const result = await client.startOwnSession("owner");
    expect(result.expiresAt - result.startedAt).toBe(600_000);
    expect(mocks.runTransaction).toHaveBeenCalledTimes(2);
    expect(transaction.set).toHaveBeenCalledWith(expect.objectContaining({ id: "owner" }), {
      startedAt: { sentinel: "server-timestamp" }, expiresAt: { sentinel: "server-timestamp" },
    });
    expect(transaction.update.mock.lastCall![1].expiresAt.nanoseconds).toBe(123_456_789);
  });

  it("reuses an existing active visit without any timestamp write", async () => {
    const transaction = { get: vi.fn(async () => documentSnapshot("owner", documentData(NOW - 10_000))), set: vi.fn(), update: vi.fn() };
    mocks.runTransaction.mockImplementation(async (_db: unknown, body: (transaction: unknown) => Promise<unknown>) => body(transaction));
    const client = await import("../src/lib/firebase-client");
    await expect(client.startOwnSession("owner")).resolves.toEqual({ id: "owner", startedAt: NOW - 10_000, expiresAt: NOW + 590_000 });
    expect(mocks.runTransaction).toHaveBeenCalledOnce();
    expect(transaction.set).not.toHaveBeenCalled();
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it("recovers a confirmed concurrent start but never converts a genuine permission error into demo success", async () => {
    const denied = new mocks.FirebaseError("permission-denied", "Denied");
    mocks.runTransaction.mockRejectedValue(denied);
    mocks.getDocFromServer.mockResolvedValueOnce(documentSnapshot("owner", documentData(NOW)));
    const client = await import("../src/lib/firebase-client");
    await expect(client.startOwnSession("owner")).resolves.toEqual({ id: "owner", startedAt: NOW, expiresAt: NOW + 600_000 });
    await expect(client.startOwnSession("owner")).rejects.toBe(denied);
    expect(client.getFirebaseStatus().mode).toBe("live");
  });

  it("compare-and-deletes only the expected visit, protecting a newer tab's session", async () => {
    const transaction = { get: vi.fn(async () => documentSnapshot("owner", documentData(NOW))), delete: vi.fn() };
    mocks.runTransaction.mockImplementation(async (_db: unknown, body: (transaction: unknown) => Promise<unknown>) => body(transaction));
    const client = await import("../src/lib/firebase-client");
    await client.endOwnSession("owner", NOW - 10_000);
    expect(transaction.delete).not.toHaveBeenCalled();
    await client.endOwnSession("owner", NOW);
    expect(transaction.delete).toHaveBeenCalledOnce();
  });
});
