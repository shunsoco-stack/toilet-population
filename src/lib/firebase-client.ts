import { FirebaseError, getApps, initializeApp, type FirebaseOptions } from "firebase/app";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  setPersistence,
  signInAnonymously,
  type Auth,
} from "firebase/auth";
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDocFromServer,
  getFirestore,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  type DocumentData,
  type Firestore,
  type Unsubscribe,
} from "firebase/firestore";
import { isSessionActive, isValidSession, SESSION_DURATION_MS, type ActiveSession } from "./session";

export const SESSION_COLLECTION = "activeSessions";
export const POPULATION_REFRESH_MS = 20_000;

// Direct references are required for Next.js to inline public build-time variables.
const firebaseOptions: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export interface FirebaseStatus {
  configured: boolean;
  mode: "live" | "demo";
  missing: string[];
}

export interface PopulationSnapshot {
  count: number;
  sessions: ActiveSession[];
  /** A disconnected cached count must not be labelled as a fresh live count. */
  fromCache: boolean;
  updatedAt: number;
}

type FirebaseClient = { auth: Auth; db: Firestore };
type SessionDocument = { startedAt: Timestamp; expiresAt: Timestamp };
let client: FirebaseClient | null = null;
let signInPromise: Promise<string> | null = null;

export function getFirebaseStatus(): FirebaseStatus {
  const required = [
    ["NEXT_PUBLIC_FIREBASE_API_KEY", firebaseOptions.apiKey],
    ["NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", firebaseOptions.authDomain],
    ["NEXT_PUBLIC_FIREBASE_PROJECT_ID", firebaseOptions.projectId],
    ["NEXT_PUBLIC_FIREBASE_APP_ID", firebaseOptions.appId],
  ];
  const missing = required
    .filter(([, value]) => !value?.trim() || /^(your[-_]|replace|example|<|TODO)/i.test(value))
    .map(([name]) => name as string);
  return { configured: missing.length === 0, mode: missing.length === 0 ? "live" : "demo", missing };
}

function getClient(): FirebaseClient {
  if (typeof window === "undefined") throw new Error("Firebase is only initialized in the browser.");
  if (!getFirebaseStatus().configured) throw new Error("Firebase is not configured; use the explicitly labelled demo.");
  if (client) return client;
  const existingApp = getApps().find((existing) => existing.name === "toilet-population");
  const app = existingApp ?? initializeApp(firebaseOptions, "toilet-population");
  const auth = getAuth(app);
  const db = getFirestore(app);
  if (!existingApp && process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATORS === "true") {
    connectAuthEmulator(auth, "http://127.0.0.1:9199", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8187);
  }
  client = { auth, db };
  return client;
}

function assertOwner(uid: string): FirebaseClient {
  const connection = getClient();
  if (!uid || connection.auth.currentUser?.uid !== uid) throw new Error("Anonymous authentication is required.");
  return connection;
}

/** Wait for restored auth BEFORE creating an anonymous account, including after a reload. */
export async function signInAnonymousUser(): Promise<string> {
  if (signInPromise) return signInPromise;
  const authenticate = async () => {
    const { auth } = getClient();
    await setPersistence(auth, browserLocalPersistence);
    await auth.authStateReady();
    if (auth.currentUser) return auth.currentUser.uid;
    return (await signInAnonymously(auth)).user.uid;
  };
  const authenticateWithLock = async (): Promise<string> => {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return await navigator.locks.request("toilet-population:anonymous-auth", authenticate);
    }
    return authenticate();
  };
  signInPromise = authenticateWithLock().finally(() => { signInPromise = null; });
  return signInPromise;
}

function readDocument(data: DocumentData | undefined): SessionDocument | null {
  if (!data || !(data.startedAt instanceof Timestamp) || !(data.expiresAt instanceof Timestamp)) return null;
  if (Object.keys(data).length !== 2) return null;
  return { startedAt: data.startedAt, expiresAt: data.expiresAt };
}

function isDraft(data: SessionDocument): boolean {
  return data.startedAt.isEqual(data.expiresAt);
}

function toSession(uid: string, data: SessionDocument | null): ActiveSession | null {
  if (!data || isDraft(data)) return null;
  const session = {
    id: uid,
    startedAt: Math.floor(data.startedAt.toMillis()),
    expiresAt: Math.floor(data.expiresAt.toMillis()),
  };
  return isValidSession(session) ? session : null;
}

/** Returns an expired own session too, so the UI can save its exact bounded history. */
export async function getOwnSession(uid: string): Promise<ActiveSession | null> {
  const { db } = assertOwner(uid);
  const snapshot = await getDocFromServer(doc(db, SESSION_COLLECTION, uid));
  return snapshot.exists() ? toSession(uid, readDocument(snapshot.data())) : null;
}

/**
 * Two-phase reserve/arm avoids client-clock-based lifetimes and adds no extra fields.
 * 1. Reserve the UID document with identical server timestamps (inactive draft).
 * 2. Arm it exactly 600 seconds after that server timestamp, retaining nanoseconds.
 * Transactions and rules prevent duplicate tabs from extending an active visit.
 */
export async function startOwnSession(uid: string): Promise<ActiveSession> {
  const { db } = assertOwner(uid);
  const reference = doc(db, SESSION_COLLECTION, uid);
  const recoverConcurrentStart = async (error: unknown): Promise<ActiveSession> => {
    // Rules can reject a stale reservation before Firestore retries its transaction
    // if another tab has already armed it. Reuse that confirmed active visit only.
    if (error instanceof FirebaseError && (error.code === "permission-denied" || error.code === "aborted")) {
      const concurrent = await getOwnSession(uid).catch(() => null);
      if (concurrent && isSessionActive(concurrent)) return concurrent;
    }
    throw error;
  };
  const existing = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    const raw = readDocument(snapshot.data());
    const current = toSession(uid, raw);
    if (current && isSessionActive(current)) return current;
    if (raw && isDraft(raw) && raw.startedAt.toMillis() + SESSION_DURATION_MS > Date.now()) return null;
    transaction.set(reference, { startedAt: serverTimestamp(), expiresAt: serverTimestamp() });
    return null;
  }).catch(recoverConcurrentStart);
  if (existing) return existing;

  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    const raw = readDocument(snapshot.data());
    const current = toSession(uid, raw);
    if (current && isSessionActive(current)) return current;
    if (!raw || !isDraft(raw)) throw new Error("Session start was cancelled. Please try again.");
    const expiresAt = new Timestamp(raw.startedAt.seconds + SESSION_DURATION_MS / 1_000, raw.startedAt.nanoseconds);
    const active = toSession(uid, { startedAt: raw.startedAt, expiresAt });
    if (!active || active.expiresAt <= Date.now()) throw new Error("The session has already expired. Please try again.");
    transaction.update(reference, { expiresAt });
    return active;
  }).catch(recoverConcurrentStart);
}

/** Compare-and-delete prevents a stale tab from deleting a more recent visit. */
export async function endOwnSession(uid: string, expectedStartedAt?: number): Promise<void> {
  const { db } = assertOwner(uid);
  const reference = doc(db, SESSION_COLLECTION, uid);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) return;
    const raw = readDocument(snapshot.data());
    if (expectedStartedAt !== undefined && (!raw || Math.floor(raw.startedAt.toMillis()) !== expectedStartedAt)) return;
    transaction.delete(reference);
  });
}

export function subscribeOwnSession(
  uid: string,
  onChange: (session: ActiveSession | null) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const { db } = assertOwner(uid);
  return onSnapshot(doc(db, SESSION_COLLECTION, uid), { includeMetadataChanges: true }, (snapshot) => {
    // Never turn an in-flight draft or an empty offline cache into a false finish.
    if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;
    if (!snapshot.exists()) { onChange(null); return; }
    const raw = readDocument(snapshot.data());
    if (raw && isDraft(raw)) return;
    onChange(toSession(uid, raw));
  }, onError);
}

/**
 * No arbitrary limit: every matching anonymous UID contributes one, never fake people.
 * Firestore query cutoffs are fixed values, not moving clocks. Renew the query regularly
 * AND schedule local expiry pruning, so a closed tab's session stops counting at 10 min
 * even when TTL cleanup or the next server snapshot has not happened yet.
 */
export function subscribePopulation(
  onChange: (snapshot: PopulationSnapshot) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const { auth, db } = getClient();
  if (!auth.currentUser) throw new Error("Anonymous authentication is required.");
  let unsubscribe: Unsubscribe | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let stopped = false;
  let knownSessions: ActiveSession[] = [];
  let fromCache = true;
  let hasServerSnapshot = false;

  const emit = () => {
    if (stopped) return;
    const now = Date.now();
    knownSessions = knownSessions.filter((session) => isSessionActive(session, now));
    onChange({ count: knownSessions.length, sessions: knownSessions, fromCache, updatedAt: now });
    if (expiryTimer) clearTimeout(expiryTimer);
    const earliest = knownSessions.reduce((minimum, session) => Math.min(minimum, session.expiresAt), Infinity);
    if (Number.isFinite(earliest)) expiryTimer = setTimeout(emit, Math.max(1, earliest - now + 1));
  };

  const listen = () => {
    if (stopped) return;
    unsubscribe?.();
    const currentGeneration = ++generation;
    const activeQuery = query(collection(db, SESSION_COLLECTION), where("expiresAt", ">", Timestamp.fromMillis(Date.now())));
    unsubscribe = onSnapshot(activeQuery, { includeMetadataChanges: true }, (snapshot) => {
      if (stopped || currentGeneration !== generation || snapshot.metadata.hasPendingWrites) return;
      fromCache = snapshot.metadata.fromCache;
      if (!fromCache || !hasServerSnapshot) {
        knownSessions = snapshot.docs.flatMap((document) => {
          const session = toSession(document.id, readDocument(document.data()));
          return session ? [session] : [];
        });
      }
      if (!fromCache) hasServerSnapshot = true;
      emit();
    }, (error) => {
      if (stopped || currentGeneration !== generation) return;
      fromCache = true;
      emit();
      onError(error);
    });
  };

  const refresh = () => { if (typeof document === "undefined" || !document.hidden) listen(); };
  const visibilityChanged = () => { emit(); refresh(); };
  const offline = () => { fromCache = true; emit(); };
  const refreshTimer = setInterval(refresh, POPULATION_REFRESH_MS);
  window.addEventListener("online", listen);
  window.addEventListener("offline", offline);
  document.addEventListener("visibilitychange", visibilityChanged);
  listen();

  return () => {
    stopped = true;
    generation += 1;
    unsubscribe?.();
    clearInterval(refreshTimer);
    if (expiryTimer) clearTimeout(expiryTimer);
    window.removeEventListener("online", listen);
    window.removeEventListener("offline", offline);
    document.removeEventListener("visibilitychange", visibilityChanged);
  };
}
