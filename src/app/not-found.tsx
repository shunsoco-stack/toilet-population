import Link from "next/link";

export default function NotFound() {
  return <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-5 px-6 text-center"><p className="eyebrow">404 · A SMALL DETOUR</p><h1 className="text-3xl font-semibold">ここは、空き部屋でした。</h1><p className="text-sm text-[var(--secondary)]">お探しのページは見つかりませんでした。</p><Link href="/" className="primary-button">世界トイレ人口に戻る</Link></main>;
}
