"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { track } from "@vercel/analytics";
import {
  ArrowRight, ArrowUpRight, CalendarDays, Check, ChevronRight, Clock3,
  Copy, DoorOpen, Globe2, Info, Leaf, Moon, Plus, RotateCcw, Share2,
  ShieldCheck, Sun, UsersRound, WifiOff, X,
} from "lucide-react";
import { useToiletSession } from "@/hooks/use-toilet-session";
import { formatClock, formatDuration, formatTimer } from "@/lib/format";
import { remainingMs, SESSION_DURATION_MS } from "@/lib/session";
import { PaperRoll, PaperWorld } from "./paper-world";

type View = "population" | "records";
type DialogKind = "about" | "share" | "install" | null;

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); previousFocus?.focus(); };
  }, []);
  return (
    <dialog ref={ref} className="app-dialog" aria-labelledby="dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog-surface">
        <div className="dialog-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label="閉じる" onClick={onClose}><X size={20} /></button></div>
        {children}
      </div>
    </dialog>
  );
}

function trackShare(mode: "demo" | "live", method: string) {
  const privacy = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (privacy.doNotTrack === "1" || privacy.globalPrivacyControl) return;
  try { track("toilet_share", { mode, method }); } catch { /* Sharing must work without analytics. */ }
}

export function ToiletApp() {
  const session = useToiletSession();
  const [view, setView] = useState<View>("population");
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [dark, setDark] = useState(false);
  const [notice, setNotice] = useState("");
  const [shareText, setShareText] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const demo = session.mode === "demo";
  const currentCount = session.count;
  const isActive = session.active !== null;
  const remaining = remainingMs(session.active, session.now);
  const liveReady = session.connection === "live";
  const isOffline = session.connection === "offline";

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      let saved: string | null = null;
      try { saved = localStorage.getItem("toilet-population:theme"); } catch { /* System preference still works. */ }
      const nextDark = saved ? saved === "dark" : media.matches;
      document.documentElement.dataset.theme = nextDark ? "dark" : "light";
      setDark(nextDark);
    };
    queueMicrotask(update);
    media.addEventListener("change", update);
    return () => {
      media.removeEventListener("change", update);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  function announce(message: string) {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = setTimeout(() => setNotice(""), 5_000);
  }

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    try { localStorage.setItem("toilet-population:theme", next ? "dark" : "light"); } catch { /* Session-only theme. */ }
  }

  function navigate(next: View) {
    setView(next);
    window.scrollTo({ top: 0, behavior: "instant" });
    requestAnimationFrame(() => document.getElementById("main-content")?.focus({ preventScroll: true }));
  }

  async function share() {
    const url = new URL("/", window.location.origin).href;
    const text = demo
      ? "世界は、ちょっと休憩中。『世界トイレ人口』のデモを試しました。サンプル人数で遊べる、小さなWebアプリ。"
      : "世界は、ちょっと休憩中。『世界トイレ人口』は、このアプリで「トイレ中」にしている人数が見える、小さなWebアプリ。";
    try {
      if (navigator.share) {
        await navigator.share({ title: "世界トイレ人口", text, url });
        trackShare(session.mode, "native");
        announce("シェアしました。小さなつながりを、ありがとう。");
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(`${text}\n${url}`);
        trackShare(session.mode, "clipboard");
        announce("紹介文とリンクをコピーしました。");
      } else {
        setShareText(`${text}\n${url}`);
        setDialog("share");
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setShareText(`${text}\n${url}`);
      setDialog("share");
    }
  }

  const connectionLabel = demo ? "DEMO · サンプル表示" : liveReady ? "LIVE · リアルタイム" : isOffline ? "OFFLINE · 前回の情報" : session.connection === "error" ? "接続できません" : "接続しています";

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">メインコンテンツへ</a>
      <header className="site-header">
        <button className="brand" onClick={() => navigate("population")} aria-label="世界トイレ人口 ホーム">
          <Image src="/icon.svg" alt="" width={39} height={39} priority />
          <span><strong>世界トイレ人口</strong><span>TOILET POPULATION</span></span>
        </button>
        <div className="header-actions">
          <nav className="segmented-nav" aria-label="メインナビゲーション">
            <button aria-pressed={view === "population"} className={view === "population" ? "selected" : ""} onClick={() => navigate("population")}><Globe2 size={15} /><span>いまの人数</span></button>
            <button aria-pressed={view === "records"} className={view === "records" ? "selected" : ""} onClick={() => navigate("records")}><CalendarDays size={15} /><span>本日の記録</span></button>
          </nav>
          <span className="header-divider" />
          <button className="icon-button theme-button" onClick={toggleTheme} aria-label={dark ? "ライトモードに切り替え" : "ダークモードに切り替え"} title={dark ? "ライトモード" : "ダークモード"}>{dark ? <Sun size={19} /> : <Moon size={19} />}</button>
          <button className="icon-button about-button" onClick={() => setDialog("about")} aria-label="このアプリについて"><Info size={19} /></button>
        </div>
      </header>

      <main id="main-content" className="main-content" tabIndex={-1}>
        {view === "population" ? (
          <>
            <section className="intro" aria-labelledby="page-title">
              <p className="eyebrow"><span /> A LITTLE BREAK, A LITTLE CONNECTION</p>
              <h1 id="page-title">世界は、<span>ちょっと休憩中。</span></h1>
              <p className="intro-description">ひとりの時間も、なんとなくつながる。</p>
            </section>

            <section className={`population-card ${isActive ? "population-card-active" : ""}`} aria-labelledby="population-heading">
              <div className="population-main">
                <div className="population-copy">
                  <div className={`status-pill ${demo ? "status-demo" : ""} ${isOffline || session.connection === "error" ? "status-offline" : ""}`}><span className="status-dot" />{connectionLabel}</div>
                  <h2 id="population-heading">いま、このアプリでトイレ中</h2>
                  <div className="population-number" aria-live="polite" aria-atomic="true" aria-label={`${demo ? "デモのサンプル人数" : isOffline ? "前回確認したアプリの人数" : "このアプリでトイレ中の人数"}：${currentCount ?? "確認中"}${currentCount !== null ? "人" : ""}`}>
                    <span data-testid="population-count">{currentCount === null ? "—" : currentCount.toLocaleString("ja-JP")}</span><span className="population-unit" aria-hidden="true">人</span>
                  </div>
                  <p className="population-subtitle">{isActive ? "あなたも、ここにいます。" : currentCount === 0 ? "最初のひと息を、どうぞ。" : "それぞれの個室で、ひと息。"}</p>
                  <p className="population-disclaimer">世界中の実際のトイレ人口ではありません。</p>
                </div>
                <div className="world-container">
                  <PaperWorld count={currentCount ?? 0} active={isActive} />
                  <p className="world-caption">人数が増えると、ペーパーも増えます<span>※ 装飾は最大32個。所在地とは無関係です。</span></p>
                </div>
              </div>
              <div className="population-footnote"><span><UsersRound size={15} />数えるのは、このアプリの「トイレ中」だけ。</span><span><ShieldCheck size={15} />登録不要・GPSの取得なし</span></div>
            </section>

            {demo && <aside className="demo-notice" aria-label="デモモードの説明"><div><span className="demo-tag">DEMO</span><p><strong>ただいまデモモード。</strong><span>サンプル{session.sampleCount}人 ＋ この端末の状態です。実際の利用者数ではありません。</span></p></div><div className="demo-controls"><button onClick={session.addDemoPerson} disabled={session.sampleCount >= 24} title="サンプルを1人増やして表示を試す"><Plus size={14} />デモ人数 +1</button><button className="demo-reset" aria-label="デモ人数を12人に戻す" title="サンプル人数をリセット" onClick={session.resetDemoPeople}><RotateCcw size={14} /></button></div></aside>}

            {session.error && <div className="error-notice" role="alert"><WifiOff size={19} /><div><strong>接続状況を確認してください</strong><p>{session.error}</p></div><button onClick={session.retryConnection}>再接続</button></div>}
            {!session.storageAvailable && session.ready && <p className="storage-warning" role="status">このブラウザでは保存が制限されています。記録と状態は、このページを開いている間だけ保持されます。</p>}

            <section className={`session-card ${isActive ? "session-active" : ""} ${session.completed && !isActive ? "session-completed" : ""}`} aria-label="あなたのトイレ状態">
              {session.completed && !isActive ? (
                <>
                  <div className="session-symbol complete-symbol"><Check size={29} /></div>
                  <div className="session-copy"><p className="small-label">BREAK COMPLETE</p><h2>おかえりなさい。</h2><p>{session.completed.reason === "expired" ? "10分が経ったため、自動で終了しました。" : "ひと息ついたら、また日常へ。"}<span className="completed-duration">今回の休憩 <strong>{formatDuration(session.completed.durationMs)}</strong></span></p></div>
                  <div className="completed-actions"><button className="primary-button" onClick={() => navigate("records")}>本日の記録を見る<ArrowUpRight size={17} /></button><button className="text-button" onClick={session.dismissCompleted}>ホームに戻る<ChevronRight size={15} /></button></div>
                </>
              ) : isActive ? (
                <>
                  <div className="session-timer-ring"><svg viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="31" className="timer-track" /><circle cx="36" cy="36" r="31" className="timer-progress" strokeDasharray={194.78} strokeDashoffset={194.78 * (1 - remaining / SESSION_DURATION_MS)} /></svg><Leaf size={27} /></div>
                  <div className="session-copy"><p className="small-label">YOU’RE ON A BREAK <span className="participating-dot" /></p><h2>ただいま、ひと息中。</h2><p>{demo ? "デモ人数に、あなたの1人を追加しました。" : "あなたの1人をカウントしています。"}</p></div>
                  <div className="remaining-time"><span>自動解除まで</span><time data-testid="remaining-time" aria-label={`自動解除まで ${formatTimer(remaining)}`}>{formatTimer(remaining)}</time></div>
                  <button className="exit-button" onClick={() => void session.end()} disabled={session.busy}><DoorOpen size={18} />{session.busy ? "終了しています…" : "トイレを出ました"}</button>
                </>
              ) : (
                <>
                  <div className="session-symbol"><PaperRoll /></div>
                  <div className="session-copy"><p className="small-label">YOUR LITTLE BREAK</p><h2>あなたも、ひと息つきませんか。</h2><p>ボタンひとつで、ゆるく参加。アカウント登録はいりません。</p></div>
                  <button className="primary-button start-button" onClick={() => void session.start()} disabled={!session.ready || session.busy || (!demo && !liveReady)}><DoorOpen size={19} />{session.busy ? "準備しています…" : "今トイレです"}<ArrowRight size={18} /></button>
                </>
              )}
            </section>
            <p className="session-hint"><Clock3 size={13} />開始から10分で自動解除。再読み込みしても、あなたの状態はそのまま。</p>

            <section className="today-summary" aria-labelledby="today-heading">
              <div className="summary-title"><span className="summary-icon"><CalendarDays size={21} /></span><div><h2 id="today-heading">あなたの今日</h2><p>この端末だけの、小さな記録。</p></div></div>
              <div className="summary-metrics"><div><span>トイレ回数</span><strong>{session.stats.count}<small>回</small></strong></div><span className="metric-divider" /><div><span>合計時間</span><strong className="duration-value">{Math.floor(session.stats.totalDurationMs / 60_000)}<small>分</small><em>{String(Math.floor(session.stats.totalDurationMs / 1_000) % 60).padStart(2, "0")}</em><small>秒</small></strong></div></div>
              <button className="summary-link" onClick={() => navigate("records")}>記録を見る<ArrowUpRight size={17} /></button>
            </section>
            <section className="share-section"><div><p className="small-label">GOOD THINGS, SMALL THINGS.</p><h2>このくだらなさを、だれかに。</h2><p>役に立たなくても、ちょっと笑えたらそれで。</p></div><button className="secondary-button" onClick={() => void share()}><Share2 size={17} />このアプリをシェア<ArrowUpRight size={15} /></button></section>
          </>
        ) : (
          <>
            <section className="intro records-intro"><p className="eyebrow"><span /> YOUR DAY, IN LITTLE BREAKS</p><h1>あなたの、<span>小さな記録。</span></h1><p className="intro-description">見返すほどでもない。でも、残しておきたい。</p></section>
            <div className="records-heading"><h2><CalendarDays size={20} />本日の記録<span>{session.now ? new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short" }).format(session.now) : "—"}</span></h2><span className="local-badge"><ShieldCheck size={14} />この端末だけに保存</span></div>
            {demo && <p className="records-demo"><span className="demo-tag">DEMO</span>デモモードで、あなたが操作した記録です。サンプル人数の記録は含みません。</p>}
            <section className="record-stat-grid" aria-label="今日の合計"><div><span className="record-stat-icon"><DoorOpen size={24} /></span><p>今日のトイレ回数</p><strong>{session.stats.count}<small>回</small></strong><span>休憩したぶんだけ、ちょっとすっきり。</span></div><div><span className="record-stat-icon"><Clock3 size={24} /></span><p>今日の合計時間</p><strong>{Math.floor(session.stats.totalDurationMs / 60_000)}<small>分</small><em>{String(Math.floor(session.stats.totalDurationMs / 1_000) % 60).padStart(2, "0")}</em><small>秒</small></strong><span>進行中の休憩も含めています。</span></div></section>
            <section className="history-card" aria-labelledby="history-heading"><div className="history-heading"><h2 id="history-heading">ひと息の履歴</h2><span>時間はこの端末の現地時間</span></div>
              {isActive && session.active && <div className="history-row history-current"><span className="history-marker"><Leaf size={19} /></span><div><strong>ただいま、休憩中</strong><p>{formatClock(session.active.startedAt)} スタート</p></div><span className="history-current-badge">あと {formatTimer(remaining)}</span><button className="text-button" onClick={() => navigate("population")}>戻る<ChevronRight size={16} /></button></div>}
              {session.stats.entries.length > 0 ? session.stats.entries.map((entry, index) => <div className="history-row" key={entry.id}><span className="history-marker"><Check size={19} /></span><div><strong>ひと息、その{session.stats.entries.length - index}</strong><p>{formatClock(entry.startedAt)} — {formatClock(entry.endedAt)}<span> · {entry.reason === "expired" ? "10分で自動終了" : "自分で終了"}</span></p></div><strong className="history-duration">{formatDuration(entry.durationMs)}</strong></div>) : !isActive && <div className="empty-records"><div><PaperRoll /></div><h3>今日は、まだまっさら。</h3><p>最初の休憩が終わると、ここに記録されます。</p><button className="secondary-button" onClick={() => navigate("population")}>いまの人数に戻る<ArrowRight size={16} /></button></div>}
            </section>
            <aside className="record-privacy"><ShieldCheck size={21} /><div><h3>この記録は、あなたのブラウザの中だけ。</h3><p>回数と時間はlocalStorageに保存し、サーバーへは送りません。別の端末とは同期されず、ブラウザのサイトデータを消すと削除されます。</p><p>回数は開始した日の分、合計時間は日付をまたいだ分をそれぞれの日に記録します。健康状態を判断するための記録ではありません。</p></div></aside>
            <button className="records-back text-button" onClick={() => navigate("population")}><Globe2 size={16} />いまの人数に戻る<ArrowRight size={16} /></button>
          </>
        )}
      </main>

      <footer className="site-footer"><div><span className="footer-brand">TP<span>·</span></span><span>世界を変えない、小さなつながり。</span></div><nav aria-label="補足情報"><button onClick={() => setDialog("about")}>このアプリについて<ArrowUpRight size={12} /></button><button onClick={() => setDialog("install")}>ホーム画面に追加<Plus size={12} /></button><a href="https://github.com/shunsoco-stack/toilet-population" target="_blank" rel="noreferrer">GitHub<ArrowUpRight size={12} /></a></nav><p>© {new Date().getUTCFullYear()} TOILET POPULATION</p></footer>
      <div className={`toast ${notice ? "toast-visible" : ""}`} role="status" aria-live="polite">{notice && <><Check size={18} /><span>{notice}</span></>}</div>

      {dialog === "about" && <Modal title="このアプリについて" onClose={() => setDialog(null)}><p className="dialog-lead">ひとりの時間に、<br />ちいさな「ひとりじゃない」を。</p><p>「世界トイレ人口」は、このアプリで「今トイレです」を押し、まだ終了していない匿名ユーザーの数を表示する、ゆるいつながりのためのアプリです。</p><div className="dialog-callout"><Info size={20} /><p>世界中の実際のトイレ人口を調査・推計する統計ではありません。同じ人でも、別のブラウザからの利用は別の匿名ユーザーとして数えられます。</p></div><h3>大切にしていること</h3><ul><li>位置情報の権限は求めません。所在地も表示しません。</li><li>氏名・メールアドレスの登録や取得はしません。</li><li>サーバーに保存するのは、匿名IDに対応する開始・終了予定時刻だけです。</li><li>10分後に自動解除。今日の記録はこの端末の中だけに保存します。</li></ul>{demo && <p className="dialog-demo">現在はFirebase未設定のデモモードです。人数はサンプル＋この端末の状態で、ほかの利用者とは同期しません。</p>}<h3>アクセス解析について</h3><p>Vercel Analyticsでアクセスと開始・終了・共有の操作を計測します。匿名ID・個別の休憩時間・記録は解析に送信しません。ブラウザのDo Not Track設定を尊重します。配信・解析サービスは接続情報から国などの概略を処理する場合があります。GPS位置情報は取得しません。</p><a className="dialog-external" href="https://vercel.com/docs/analytics/privacy-policy" target="_blank" rel="noreferrer">Vercel Analyticsのプライバシー<ArrowUpRight size={14} /></a><p className="dialog-small">このアプリは娯楽用です。医療・健康管理を目的としたものではありません。</p></Modal>}
      {dialog === "install" && <Modal title="ホーム画面に追加" onClose={() => setDialog(null)}><div className="install-brand"><Image src="/icon.svg" alt="" width={64} height={64} /><h3>休憩は、ワンタップで。</h3></div><p>このアプリはPWAに対応しています。ブラウザのメニューから、ホーム画面やデスクトップに追加できます。</p><ol><li>モバイルのSafariでは、共有メニューから「ホーム画面に追加」。</li><li>ChromeやEdgeでは、アドレスバーのインストールボタン、またはメニューの「アプリをインストール」。</li></ol><p className="dialog-small">対応状況はブラウザによって異なります。オフラインでも開けますが、本番の人数確認・開始・終了の送信には通信が必要です。</p></Modal>}
      {dialog === "share" && <Modal title="リンクをシェア" onClose={() => setDialog(null)}><p>このブラウザでは自動コピーが利用できません。下の紹介文を選択してコピーしてください。</p><textarea className="share-text" aria-label="共有用の紹介文とリンク" readOnly value={shareText} onFocus={(event) => event.currentTarget.select()} /><button className="secondary-button" onClick={() => { const field = document.querySelector<HTMLTextAreaElement>(".share-text"); field?.focus(); field?.select(); announce("紹介文を選択しました。コピーしてお使いください。"); }}><Copy size={16} />紹介文を選択</button></Modal>}
    </div>
  );
}
