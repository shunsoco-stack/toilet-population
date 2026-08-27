import type { StorageLike } from "./session";

export type StorageMode = "live" | "demo";

export interface ScopedStorage extends StorageLike {
  readonly persistent: boolean;
  readonly prefix: string;
  ownsKey(key: string | null): boolean;
}

const ROOT_PREFIX = "toilet-population:";

/** Keep demo visits out of live records, and keep the app usable if storage is blocked. */
export function createScopedStorage(mode: StorageMode, backing: StorageLike | null): ScopedStorage {
  const prefix = `${ROOT_PREFIX}${mode}:`;
  const memory = new Map<string, string>();
  let persistent = backing !== null;
  const physicalKey = (key: string) => `${prefix}${key.startsWith(ROOT_PREFIX) ? key.slice(ROOT_PREFIX.length) : key}`;
  const logicalKey = (key: string) => `${ROOT_PREFIX}${key.slice(prefix.length)}`;

  const refresh = () => {
    if (!persistent || !backing) return;
    try {
      const next = new Map<string, string>();
      for (let index = 0; index < backing.length; index += 1) {
        const key = backing.key(index);
        if (!key?.startsWith(prefix)) continue;
        const value = backing.getItem(key);
        if (value !== null) next.set(logicalKey(key), value);
      }
      memory.clear();
      for (const [key, value] of next) memory.set(key, value);
    } catch {
      persistent = false;
    }
  };

  refresh();
  if (persistent && backing) {
    try {
      const probe = `${prefix}storage-probe:v1`;
      backing.setItem(probe, "1");
      backing.removeItem(probe);
    } catch {
      persistent = false;
    }
  }

  return {
    get persistent() { return persistent; },
    prefix,
    ownsKey: (key) => key === null || key.startsWith(prefix),
    get length() { refresh(); return memory.size; },
    key(index) { refresh(); return [...memory.keys()][index] ?? null; },
    getItem(key) {
      if (persistent && backing) {
        try {
          const value = backing.getItem(physicalKey(key));
          if (value === null) memory.delete(key);
          else memory.set(key, value);
          return value;
        } catch {
          persistent = false;
        }
      }
      return memory.get(key) ?? null;
    },
    setItem(key, value) {
      memory.set(key, value);
      if (!persistent || !backing) return;
      try { backing.setItem(physicalKey(key), value); }
      catch { persistent = false; }
    },
    removeItem(key) {
      memory.delete(key);
      if (!persistent || !backing) return;
      try { backing.removeItem(physicalKey(key)); }
      catch { persistent = false; }
    },
  };
}
