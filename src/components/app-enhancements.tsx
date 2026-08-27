"use client";

import { useEffect } from "react";
import { Analytics } from "@vercel/analytics/next";

export function AppEnhancements() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    const register = async () => {
      try {
        await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
        const ready = await navigator.serviceWorker.ready;
        if (cancelled) return;
        const assets = [...document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>("script[src], link[rel='stylesheet']")]
          .map((element) => element instanceof HTMLScriptElement ? element.src : element.href)
          .filter((url) => new URL(url).origin === location.origin && new URL(url).pathname.startsWith("/_next/static/"));
        ready.active?.postMessage({ type: "CACHE_SHELL", assets });
      } catch { /* The app remains usable when PWA installation is unavailable. */ }
    };
    void register();
    return () => { cancelled = true; };
  }, []);

  return <Analytics beforeSend={(event) => {
    const privacy = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (privacy.doNotTrack === "1" || privacy.globalPrivacyControl) return null;
    const url = new URL(event.url);
    url.search = "";
    url.hash = "";
    return { ...event, url: url.toString() };
  }} />;
}
