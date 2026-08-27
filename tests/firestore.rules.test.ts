import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  type Firestore,
} from "firebase/firestore";

let environment: RulesTestEnvironment;
const COLLECTION = "activeSessions";
const OWNER = "anonymous-owner";
const OTHER = "anonymous-other";
const durationSeconds = 600;

function database(uid = OWNER): Firestore {
  return environment.authenticatedContext(uid).firestore() as unknown as Firestore;
}

function anonymousDatabase(): Firestore {
  return environment.unauthenticatedContext().firestore() as unknown as Firestore;
}

function reserve(db: Firestore, uid = OWNER) {
  return setDoc(doc(db, COLLECTION, uid), { startedAt: serverTimestamp(), expiresAt: serverTimestamp() });
}

async function arm(db: Firestore, uid = OWNER) {
  const reference = doc(db, COLLECTION, uid);
  const snapshot = await getDoc(reference);
  const startedAt = snapshot.data()!.startedAt as Timestamp;
  const expiresAt = new Timestamp(startedAt.seconds + durationSeconds, startedAt.nanoseconds);
  await updateDoc(reference, { expiresAt });
  return { startedAt, expiresAt };
}

async function active(db: Firestore, uid = OWNER) {
  await reserve(db, uid);
  return arm(db, uid);
}

async function seed(uid: string, startedMs: number, expiresMs = startedMs + 600_000) {
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore() as unknown as Firestore;
    await setDoc(doc(db, COLLECTION, uid), {
      startedAt: Timestamp.fromMillis(startedMs), expiresAt: Timestamp.fromMillis(expiresMs),
    });
  });
}

beforeAll(async () => {
  const address = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8187";
  const [host, port] = address.split(":");
  environment = await initializeTestEnvironment({
    projectId: "demo-toilet-population",
    firestore: {
      host,
      port: Number(port),
      rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"),
    },
  });
});
beforeEach(async () => { await environment.clearFirestore(); });
afterAll(async () => { await environment?.cleanup(); });

describe("session reservation and exact server-time lifetime", () => {
  it("permits the owner to reserve and arm exactly ten minutes", async () => {
    const db = database();
    await assertSucceeds(reserve(db));
    const { startedAt, expiresAt } = await assertSucceeds(arm(db));
    expect(expiresAt.seconds - startedAt.seconds).toBe(600);
    expect(expiresAt.nanoseconds).toBe(startedAt.nanoseconds);
    const stored = (await getDoc(doc(db, COLLECTION, OWNER))).data()!;
    expect(Object.keys(stored).sort()).toEqual(["expiresAt", "startedAt"]);
  });

  it("rejects a direct client-clock active create", async () => {
    const now = Date.now();
    await assertFails(setDoc(doc(database(), COLLECTION, OWNER), {
      startedAt: Timestamp.fromMillis(now), expiresAt: Timestamp.fromMillis(now + 600_000),
    }));
  });

  it("rejects a client-supplied reservation timestamp", async () => {
    const clientTime = Timestamp.fromMillis(Date.now() - 1_000);
    await assertFails(setDoc(doc(database(), COLLECTION, OWNER), { startedAt: clientTime, expiresAt: clientTime }));
  });

  it.each([1, 599, 601, 3_600])("rejects arming a reservation for %i seconds", async (seconds) => {
    const db = database();
    await reserve(db);
    const reference = doc(db, COLLECTION, OWNER);
    const startedAt = (await getDoc(reference)).data()!.startedAt as Timestamp;
    await assertFails(updateDoc(reference, {
      expiresAt: new Timestamp(startedAt.seconds + seconds, startedAt.nanoseconds),
    }));
  });

  it("rejects arming a reservation after its ten-minute deadline", async () => {
    const old = Date.now() - 601_000;
    await seed(OWNER, old, old);
    await assertFails(arm(database()));
  });

  it("permits restarting an expired UID document", async () => {
    await seed(OWNER, Date.now() - 660_000);
    const db = database();
    await assertSucceeds(reserve(db));
    await assertSucceeds(arm(db));
  });

  it("cannot extend, replace, or backdate an active session", async () => {
    const db = database();
    const { startedAt, expiresAt } = await active(db);
    const reference = doc(db, COLLECTION, OWNER);
    await assertFails(updateDoc(reference, { expiresAt: new Timestamp(expiresAt.seconds + 1, expiresAt.nanoseconds) }));
    await assertFails(updateDoc(reference, { startedAt: new Timestamp(startedAt.seconds - 1, startedAt.nanoseconds) }));
    await assertFails(reserve(db));
    await assertFails(updateDoc(reference, { startedAt: serverTimestamp(), expiresAt: serverTimestamp() }));
  });

  it("allows an identical transaction retry but no timestamp changes", async () => {
    const db = database();
    const { startedAt, expiresAt } = await active(db);
    await assertSucceeds(setDoc(doc(db, COLLECTION, OWNER), { startedAt, expiresAt }));
    expect((await getDoc(doc(db, COLLECTION, OWNER))).data()!.startedAt.isEqual(startedAt)).toBe(true);
  });

  it("concurrent tabs arm one UID once without extending its deadline", async () => {
    const first = database();
    const second = database();
    await reserve(first);
    const attempt = (db: Firestore) => runTransaction(db, async (transaction) => {
      const reference = doc(db, COLLECTION, OWNER);
      const current = (await transaction.get(reference)).data()!;
      const startedAt = current.startedAt as Timestamp;
      const expiresAt = current.expiresAt as Timestamp;
      if (!startedAt.isEqual(expiresAt)) return expiresAt.toMillis();
      const armed = new Timestamp(startedAt.seconds + 600, startedAt.nanoseconds);
      transaction.update(reference, { expiresAt: armed });
      return armed.toMillis();
    });
    const results = await Promise.all([attempt(first), attempt(second)]);
    expect(results[0]).toBe(results[1]);
    expect((await getDocs(collection(first, COLLECTION))).size).toBe(1);
  });
});

describe("ownership and minimal data", () => {
  it("denies unauthenticated creates, reads, lists, and deletes", async () => {
    const unauthenticated = anonymousDatabase();
    await active(database());
    await assertFails(reserve(unauthenticated, "unauthenticated"));
    await assertFails(getDoc(doc(unauthenticated, COLLECTION, OWNER)));
    await assertFails(getDocs(collection(unauthenticated, COLLECTION)));
    await assertFails(deleteDoc(doc(unauthenticated, COLLECTION, OWNER)));
  });

  it("denies another user's create, update, and delete", async () => {
    const other = database(OTHER);
    await assertFails(reserve(other, OWNER));
    await active(database());
    await assertFails(updateDoc(doc(other, COLLECTION, OWNER), { expiresAt: serverTimestamp() }));
    await assertFails(deleteDoc(doc(other, COLLECTION, OWNER)));
  });

  it("allows an owner to delete their own active session", async () => {
    const db = database();
    await active(db);
    await assertSucceeds(deleteDoc(doc(db, COLLECTION, OWNER)));
    expect((await getDoc(doc(db, COLLECTION, OWNER))).exists()).toBe(false);
  });

  it.each(["name", "email", "location", "uid", "durationMs"])("rejects extra personal/arbitrary field %s", async (field) => {
    await assertFails(setDoc(doc(database(), COLLECTION, OWNER), {
      startedAt: serverTimestamp(), expiresAt: serverTimestamp(), [field]: "must-not-be-stored",
    }));
  });

  it("rejects extra fields added when arming", async () => {
    const db = database();
    await reserve(db);
    const reference = doc(db, COLLECTION, OWNER);
    const startedAt = (await getDoc(reference)).data()!.startedAt as Timestamp;
    await assertFails(updateDoc(reference, {
      expiresAt: new Timestamp(startedAt.seconds + 600, startedAt.nanoseconds),
      email: "not-collected@example.invalid",
    }));
  });

  it("rejects missing and incorrectly typed timestamps", async () => {
    const reference = doc(database(), COLLECTION, OWNER);
    await assertFails(setDoc(reference, { startedAt: serverTimestamp() }));
    await assertFails(setDoc(reference, { startedAt: 123, expiresAt: 456 }));
    await assertFails(setDoc(reference, { startedAt: "now", expiresAt: null }));
  });

  it("denies all access to undeclared collections", async () => {
    const reference = doc(database(), "privateRecords", OWNER);
    await assertFails(setDoc(reference, { startedAt: serverTimestamp() }));
    await assertFails(getDoc(reference));
  });
});

describe("read policy and expiry-aware queries", () => {
  it("allows another anonymous user to read an active session", async () => {
    await active(database());
    await assertSucceeds(getDoc(doc(database(OTHER), COLLECTION, OWNER)));
  });

  it("allows owner expiry recovery but denies a nonowner direct expired read", async () => {
    await seed(OWNER, Date.now() - 660_000);
    await assertSucceeds(getDoc(doc(database(), COLLECTION, OWNER)));
    await assertFails(getDoc(doc(database(OTHER), COLLECTION, OWNER)));
  });

  it("excludes expired documents and inactive drafts with the application's query", async () => {
    const now = Date.now();
    await seed("active-a", now - 60_000);
    await seed("active-b", now - 120_000);
    await seed("expired", now - 660_000);
    await seed("draft", now - 1_000, now - 1_000);
    const result = await assertSucceeds(getDocs(query(
      collection(database(), COLLECTION), where("expiresAt", ">", Timestamp.fromMillis(Date.now())),
    )));
    expect(result.docs.map((document) => document.id).sort()).toEqual(["active-a", "active-b"]);
  });

  it("explicitly permits authenticated timestamp-only list reads; rules are not expiry filters", async () => {
    await seed("expired", Date.now() - 660_000);
    expect((await assertSucceeds(getDocs(collection(database(), COLLECTION)))).size).toBe(1);
  });
});
