import type { Metadata, Viewport } from "next";
import { AppEnhancements } from "@/components/app-enhancements";
import "./globals.css";

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://toilet-population.vercel.app";
const description = "ひとりの時間も、なんとなくつながる。このアプリで「トイレ中」にしている人数をリアルタイムに表示。匿名・登録不要、10分で自動解除。世界の実人口を示す統計ではありません。";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: "世界トイレ人口 — 世界は、ちょっと休憩中。",
  description,
  applicationName: "世界トイレ人口",
  alternates: { canonical: "/" },
  icons: { icon: [{ url: "/favicon.ico" }, { url: "/icon.svg", type: "image/svg+xml" }], apple: "/icons/apple-touch-icon.png" },
  appleWebApp: { capable: true, statusBarStyle: "default", title: "世界トイレ人口" },
  formatDetection: { telephone: false },
  openGraph: { title: "世界トイレ人口", description, type: "website", locale: "ja_JP", url: "/", siteName: "世界トイレ人口", images: [{ url: "/og.png", width: 1200, height: 630, alt: "世界トイレ人口 — 世界は、ちょっと休憩中。" }] },
  twitter: { card: "summary_large_image", title: "世界トイレ人口", description, images: ["/og.png"] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f7f8f5" }, { media: "(prefers-color-scheme: dark)", color: "#101a16" }],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: `(function(){try{var t=localStorage.getItem('toilet-population:theme');document.documentElement.dataset.theme=t||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}catch(e){}})();` }} /></head>
      <body>{children}<AppEnhancements /><noscript><p style={{ padding: "1rem", textAlign: "center" }}>世界トイレ人口の人数表示と記録には、JavaScriptを有効にしてください。</p></noscript></body>
    </html>
  );
}
