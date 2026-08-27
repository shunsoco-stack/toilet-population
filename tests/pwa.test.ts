import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import manifest from "../src/app/manifest";
import nextConfig from "../next.config";

const origin = "https://toilet-population.example";
const currentCache = "toilet-population-shell-v1";
const workerSource = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
type CacheKey = string | { url: string };
type FakeRequest = { url: string; method: string; mode: string };

function cacheKey(input: CacheKey) {
  return new URL(typeof input === "string" ? input : input.url, origin).href;
}

function makeCache() {
  const entries = new Map<string, Response>();
  return {
    entries,
    addAll: vi.fn(async (paths: string[]) => {
      for (const path of paths) entries.set(cacheKey(path), new Response(`precache:${path}`));
    }),
    match: vi.fn(async (input: CacheKey) => entries.get(cacheKey(input))?.clone()),
    put: vi.fn(async (input: CacheKey, response: Response) => {
      // Cache.put consumes its input; returning it without cloning must fail.
      const body = await response.arrayBuffer();
      entries.set(cacheKey(input), new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }));
    }),
  };
}

function makeWorker() {
  type WorkerEvent = {
    request?: FakeRequest;
    data?: unknown;
    waitUntil: (task: Promise<unknown>) => void;
    respondWith: (response: Promise<Response> | Response) => void;
  };
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  const storage = new Map<string, ReturnType<typeof makeCache>>();
  const getCache = (name: string) => {
    if (!storage.has(name)) storage.set(name, makeCache());
    return storage.get(name)!;
  };
  const caches = {
    open: vi.fn(async (name: string) => getCache(name)),
    keys: vi.fn(async () => [...storage.keys()]),
    delete: vi.fn(async (name: string) => storage.delete(name)),
    match: vi.fn(async (input: CacheKey) => {
      for (const cache of storage.values()) {
        const match = await cache.match(input);
        if (match) return match;
      }
      return undefined;
    }),
  };
  const fetch = vi.fn<(input: CacheKey, init?: RequestInit) => Promise<Response>>()
    .mockImplementation(async () => new Response("network response"));
  const self = {
    location: { origin },
    addEventListener: (name: string, handler: (event: WorkerEvent) => void) => handlers.set(name, handler),
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
  };
  runInNewContext(workerSource, { self, caches, fetch, URL, Response }, { filename: "public/sw.js" });

  const emit = (name: string, options: { request?: FakeRequest; data?: unknown } = {}) => {
    const waitUntil = vi.fn<(task: Promise<unknown>) => void>();
    const respondWith = vi.fn<(response: Promise<Response> | Response) => void>();
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Service worker has no ${name} listener`);
    handler({ ...options, waitUntil, respondWith });
    return {
      waitUntil,
      respondWith,
      settle: () => Promise.all(waitUntil.mock.calls.map(([task]) => task)),
      response: async () => {
        const call = respondWith.mock.calls[0];
        if (!call) throw new Error("Service worker did not intercept this request");
        return call[0];
      },
    };
  };
  const request = (path: string, mode = "navigate", method = "GET") => emit("fetch", {
    request: { url: new URL(path, origin).href, mode, method },
  });
  const seed = (name: string, path: string, body: string) => getCache(name).entries.set(cacheKey(path), new Response(body));
  return { caches, fetch, self, emit, request, seed, getCache };
}

describe("PWA cache privacy boundaries", () => {
  it.each([
    ["https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel", "cors", "GET"],
    ["https://identitytoolkit.googleapis.com/v1/accounts:signUp", "cors", "POST"],
    ["https://securetoken.googleapis.com/v1/token", "cors", "POST"],
    ["https://other.example/_next/static/app.js", "cors", "GET"],
    ["https://other.example/", "navigate", "GET"],
    ["/api", "navigate", "GET"],
    ["/api?session=local", "navigate", "GET"],
    ["/api/sessions", "navigate", "GET"],
    ["/api/sessions", "cors", "GET"],
    ["/_vercel", "navigate", "GET"],
    ["/_vercel/insights/event", "cors", "GET"],
    ["/_vercel/insights/event", "navigate", "GET"],
    ["/sw.js", "navigate", "GET"],
    ["/", "navigate", "POST"],
    ["/_next/static/app.js", "cors", "PUT"],
    ["/icons/icon-192.png", "cors", "DELETE"],
    ["/icon.svg", "cors", "HEAD"],
    ["/private.json", "cors", "GET"],
  ])("does not intercept %s (%s %s)", (url, mode, method) => {
    const worker = makeWorker();
    const event = worker.request(url, mode, method);
    expect(event.respondWith).not.toHaveBeenCalled();
    expect(event.waitUntil).not.toHaveBeenCalled();
    expect(worker.fetch).not.toHaveBeenCalled();
    expect(worker.caches.open).not.toHaveBeenCalled();
    expect(worker.caches.match).not.toHaveBeenCalled();
  });

  it("precaches only the offline page and public brand assets on installation", async () => {
    const worker = makeWorker();
    await worker.emit("install").settle();
    expect(worker.caches.open).toHaveBeenCalledExactlyOnceWith(currentCache);
    expect(worker.getCache(currentCache).addAll).toHaveBeenCalledExactlyOnceWith([
      "/offline.html", "/icon.svg", "/icons/icon-192.png",
    ]);
    expect(worker.self.skipWaiting).toHaveBeenCalledOnce();
  });

  it("activation deletes old app caches without deleting other apps' storage", async () => {
    const worker = makeWorker();
    const names = [currentCache, "toilet-population-shell-v0", "other-app-shell-v1", "toilet-population-records"];
    for (const name of names) worker.seed(name, "/", name);
    await worker.emit("activate").settle();
    expect(worker.caches.delete).toHaveBeenCalledExactlyOnceWith("toilet-population-shell-v0");
    expect(await worker.caches.keys()).toEqual([currentCache, "other-app-shell-v1", "toilet-population-records"]);
    expect(worker.self.clients.claim).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, {}, { type: "UNRELATED", assets: [] }, { type: "CACHE_SHELL", assets: "not an array" }])(
    "ignores malformed or unrelated shell messages: %j", async (data) => {
      const worker = makeWorker();
      const event = worker.emit("message", { data });
      await event.settle();
      expect(event.waitUntil).not.toHaveBeenCalled();
      expect(worker.fetch).not.toHaveBeenCalled();
      expect(worker.caches.open).not.toHaveBeenCalled();
    },
  );

  it("shell prewarming accepts only same-origin Next.js static assets", async () => {
    const worker = makeWorker();
    const safe = `${origin}/_next/static/chunks/main.js`;
    await worker.emit("message", { data: { type: "CACHE_SHELL", assets: [
      safe,
      `${origin}/api/sessions`,
      `${origin}/_vercel/insights/event`,
      "https://firestore.googleapis.com/_next/static/app.js",
      `${origin}/_next/static/../../api/secret`,
      "javascript:alert(1)",
      "not a URL",
      12,
      null,
    ] } }).settle();
    expect(worker.fetch.mock.calls.map(([input]) => input)).toEqual(["/", safe]);
    expect([...worker.getCache(currentCache).entries.keys()]).toEqual([`${origin}/`, safe]);
  });

  it("bounds prewarming to at most sixty submitted asset entries", async () => {
    const worker = makeWorker();
    const assets = Array.from({ length: 80 }, (_, index) => `${origin}/_next/static/${index}.js`);
    await worker.emit("message", { data: { type: "CACHE_SHELL", assets } }).settle();
    expect(worker.fetch).toHaveBeenCalledTimes(61);
    expect(worker.fetch.mock.calls.map(([input]) => input)).toEqual(["/", ...assets.slice(0, 60)]);
  });

  it("one failed asset does not prevent remaining public assets from warming", async () => {
    const worker = makeWorker();
    const good = `${origin}/_next/static/good.js`;
    worker.fetch.mockRejectedValueOnce(new Error("temporary offline"));
    await expect(worker.emit("message", { data: { type: "CACHE_SHELL", assets: [good] } }).settle()).resolves.toBeDefined();
    expect(worker.getCache(currentCache).entries.has(good)).toBe(true);
    expect(worker.getCache(currentCache).entries.has(`${origin}/`)).toBe(false);
  });
});

describe("PWA navigation availability", () => {
  it("prefers a fresh root navigation, caches a clone, and returns an unconsumed response", async () => {
    const worker = makeWorker();
    worker.seed(currentCache, "/", "old shell");
    const response = await worker.request("/").response();
    expect(await response.text()).toBe("network response");
    expect(await (await worker.getCache(currentCache).match("/"))?.text()).toBe("network response");
    expect(worker.fetch).toHaveBeenCalledOnce();
  });

  it("uses a previously cached root when navigation loses connectivity", async () => {
    const worker = makeWorker();
    worker.seed(currentCache, "/", "cached shell");
    worker.seed(currentCache, "/offline.html", "offline explanation");
    worker.fetch.mockRejectedValue(new Error("offline"));
    expect(await (await worker.request("/").response()).text()).toBe("cached shell");
    expect(worker.getCache(currentCache).put).not.toHaveBeenCalled();
  });

  it("falls back to the offline explanation when no root was cached", async () => {
    const worker = makeWorker();
    worker.seed(currentCache, "/offline.html", "offline explanation");
    worker.fetch.mockRejectedValue(new Error("offline"));
    expect(await (await worker.request("/").response()).text()).toBe("offline explanation");
  });

  it("does not present the root application as an unrelated offline route", async () => {
    const worker = makeWorker();
    worker.seed(currentCache, "/", "cached shell");
    worker.seed(currentCache, "/offline.html", "offline explanation");
    worker.fetch.mockRejectedValue(new Error("offline"));
    expect(await (await worker.request("/unrelated-route").response()).text()).toBe("offline explanation");
  });

  it("returns a network error when neither cached fallback exists", async () => {
    const worker = makeWorker();
    worker.fetch.mockRejectedValue(new Error("offline"));
    const response = await worker.request("/").response();
    expect(response.type).toBe("error");
    expect(response.status).toBe(0);
  });

  it("does not overwrite a good shell with an unsuccessful network response", async () => {
    const worker = makeWorker();
    worker.seed(currentCache, "/", "good shell");
    worker.fetch.mockResolvedValue(new Response("unavailable", { status: 503 }));
    const response = await worker.request("/").response();
    expect(response.status).toBe(503);
    expect(worker.getCache(currentCache).put).not.toHaveBeenCalled();
    expect(await (await worker.getCache(currentCache).match("/"))?.text()).toBe("good shell");
  });

  it.each(["open", "put"] as const)("does not lose a successful network response when cache %s fails", async (operation) => {
    const worker = makeWorker();
    worker.seed(currentCache, "/", "old shell");
    if (operation === "open") worker.caches.open.mockRejectedValueOnce(new Error("storage unavailable"));
    else worker.getCache(currentCache).put.mockRejectedValueOnce(new Error("quota exceeded"));
    const response = await worker.request("/").response();
    expect(await response.text()).toBe("network response");
    expect(worker.fetch).toHaveBeenCalledOnce();
  });
});

describe("PWA public static asset caching", () => {
  it.each(["/_next/static/chunks/app.js", "/_next/static/style.css", "/icons/icon-192.png", "/icon.svg"])(
    "uses cache-first for %s without re-fetching", async (path) => {
      const worker = makeWorker();
      worker.seed(currentCache, path, "cached public asset");
      expect(await (await worker.request(path, "cors").response()).text()).toBe("cached public asset");
      expect(worker.fetch).not.toHaveBeenCalled();
    },
  );

  it("fetches and caches a missing public asset without consuming the returned response", async () => {
    const worker = makeWorker();
    const path = "/_next/static/chunks/app.js";
    expect(await (await worker.request(path, "cors").response()).text()).toBe("network response");
    expect(await (await worker.getCache(currentCache).match(path))?.text()).toBe("network response");
  });

  it("never caches an unsuccessful static response", async () => {
    const worker = makeWorker();
    worker.fetch.mockResolvedValue(new Response("missing", { status: 404 }));
    expect((await worker.request("/_next/static/missing.js", "cors").response()).status).toBe(404);
    expect(worker.caches.open).not.toHaveBeenCalled();
  });

  it.each(["match", "put"] as const)("can still serve an asset when cache %s fails", async (operation) => {
    const worker = makeWorker();
    if (operation === "match") worker.caches.match.mockRejectedValueOnce(new Error("storage unavailable"));
    else worker.getCache(currentCache).put.mockRejectedValueOnce(new Error("quota exceeded"));
    expect(await (await worker.request("/_next/static/app.js", "cors").response()).text()).toBe("network response");
    expect(worker.fetch).toHaveBeenCalledOnce();
  });
});

describe("PWA installation assets and headers", () => {
  it("declares a Japanese standalone app with origin-local identity and scope", () => {
    expect(manifest()).toMatchObject({
      id: "/", name: "世界トイレ人口", lang: "ja", start_url: "/", scope: "/", display: "standalone",
    });
    expect(manifest().icons).toHaveLength(3);
    expect(manifest().icons?.some((icon) => icon.purpose === "maskable")).toBe(true);
  });

  it.each(manifest().icons ?? [])("ships a real PNG matching $src and $sizes", (icon) => {
    expect(icon.src).toMatch(/^\/icons\/[a-z0-9-]+\.png$/);
    expect(icon.type).toBe("image/png");
    const bytes = readFileSync(fileURLToPath(new URL(`../public${icon.src}`, import.meta.url)));
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const [width, height] = String(icon.sizes).split("x").map(Number);
    expect(bytes.readUInt32BE(16)).toBe(width);
    expect(bytes.readUInt32BE(20)).toBe(height);
  });

  it("ships a self-contained offline explanation that does not pretend to show a live count", () => {
    const html = readFileSync(new URL("../public/offline.html", import.meta.url), "utf8");
    expect(html).toContain('lang="ja"');
    expect(html).toContain("オフライン");
    expect(html).toContain("10分");
    expect(html).toContain('href="/"');
    expect(html).not.toMatch(/<script\b|<iframe\b/i);
  });

  it("prevents stale worker updates and scopes the worker to the app root", async () => {
    const rules = await nextConfig.headers?.();
    const headers = rules?.find((rule) => rule.source === "/sw.js")?.headers;
    expect(headers).toEqual(expect.arrayContaining([
      { key: "Content-Type", value: "application/javascript; charset=utf-8" },
      { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
      { key: "Service-Worker-Allowed", value: "/" },
    ]));
  });

  it("disables geolocation, camera and microphone permissions at the response boundary", async () => {
    const rules = await nextConfig.headers?.();
    const headers = rules?.find((rule) => rule.source === "/(.*)")?.headers;
    expect(headers).toContainEqual({ key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" });
    expect(headers).toContainEqual({ key: "X-Content-Type-Options", value: "nosniff" });
  });
});
