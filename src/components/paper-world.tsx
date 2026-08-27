import { useId } from "react";

export function PaperRoll({ className = "" }: { className?: string }) {
  const id = useId().replaceAll(":", "");
  return (
    <svg className={className} viewBox="0 0 100 116" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-paper`} x1="23" y1="40" x2="91" y2="49" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" /><stop offset=".52" stopColor="#f7faf5" /><stop offset="1" stopColor="#dbe8dc" />
        </linearGradient>
        <linearGradient id={`${id}-sheet`} x1="20" y1="47" x2="48" y2="100" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fff" /><stop offset="1" stopColor="#edf3e9" />
        </linearGradient>
      </defs>
      <ellipse cx="54" cy="105" rx="33" ry="5" fill="#254b36" opacity=".09" />
      <path d="M23 24v52c0 13 16 22 34 22s33-9 33-22V24H23Z" fill={`url(#${id}-paper)`} stroke="#d1ddd0" strokeWidth="1.2" />
      <ellipse cx="56.5" cy="24" rx="33.5" ry="19" fill="#fffef9" stroke="#d1ddd0" strokeWidth="1.2" />
      <ellipse cx="57" cy="24" rx="12" ry="7" fill="#a4bda8" />
      <ellipse cx="57" cy="26" rx="8.5" ry="4" fill="#79977f" />
      <path d="M24 28c0 14 10 19 23 23v49c-13-4-29-2-34 5V60c0-13 4-23 11-32Z" fill={`url(#${id}-sheet)`} stroke="#d1ddd0" strokeWidth="1.2" />
      <path d="M15 78c10-4 22-2 31 1" stroke="#c7d7c5" strokeWidth="1.2" strokeDasharray="3 4" />
      <path d="M25 42c0 3 6 7 12 9" stroke="white" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const paperPositions = [
  [10, 31, 52, -17], [69, 16, 43, 17], [73, 60, 62, 14], [30, 7, 37, -13],
  [7, 68, 43, -25], [48, 79, 43, 13], [83, 34, 33, 27], [39, 24, 29, -6],
  [21, 82, 32, -9], [9, 11, 27, 11], [60, 4, 30, -20], [90, 73, 27, 21],
  [2, 49, 30, 11], [56, 28, 26, 9], [80, 83, 31, -17], [43, 1, 25, 18],
  [20, 48, 26, -18], [72, 42, 28, 7], [37, 87, 24, 13], [62, 70, 25, -13],
  [87, 6, 23, 14], [0, 87, 25, 12], [31, 57, 24, -8], [53, 48, 23, 21],
  [87, 53, 24, -15], [4, 0, 24, -15], [96, 20, 22, 8], [18, 0, 22, 8],
  [96, 88, 22, 8], [67, 91, 22, 8], [18, 23, 22, 8], [42, 70, 22, 8],
];

export function PaperWorld({ count, active }: { count: number; active: boolean }) {
  const id = useId().replaceAll(":", "");
  return (
    <div className={`paper-world ${active ? "paper-world-active" : ""}`} aria-hidden="true">
      <div className="orbit orbit-one" /><div className="orbit orbit-two" />
      <svg className="world-globe" viewBox="0 0 400 400" fill="none">
        <defs>
          <radialGradient id={`${id}-sphere`} cx=".35" cy=".3" r=".8"><stop stopColor="#e3eee0" /><stop offset="1" stopColor="#c9dfc9" /></radialGradient>
          <pattern id={`${id}-dots`} x="0" y="0" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.6" fill="#789d7b" /></pattern>
          <clipPath id={`${id}-clip`}><circle cx="200" cy="200" r="150" /></clipPath>
        </defs>
        <circle cx="200" cy="200" r="150" fill={`url(#${id}-sphere)`} />
        <g clipPath={`url(#${id}-clip)`}>
          <g stroke="#82a784" strokeWidth=".7" opacity=".28">
            <ellipse cx="200" cy="200" rx="85" ry="150" /><ellipse cx="200" cy="200" rx="140" ry="150" />
            <ellipse cx="200" cy="200" rx="150" ry="60" /><ellipse cx="200" cy="200" rx="150" ry="112" />
            <path d="M50 200h300M200 50v300" />
          </g>
          <g fill={`url(#${id}-dots)`} opacity=".7">
            <path d="m71 122 29-31 49-11 22 14 31-3 7 24-19 22-26 10-6 25-31 12-12-11-23 2-14-26Zm72 64 21 5 17 27 26 14 5 33-15 24-8 36-15-5-7-29-19-18-8-35-18-22Zm95-91 24-15 39 11 14 20 34 3 36 28-4 27-37 9-21 25-29-11-16-21-22 3-13-23-27-2-10-27Zm-2 77 36-2 26 22 6 41-20 15-8 39-20 7-15-23-13-28-12-12 1-35Zm81 95 30-10 28 18 10 29-20 13-30-7-20-18ZM198 58l17 4 11 16-10 20-24-4-5-18Z" />
          </g>
          <ellipse cx="144" cy="123" rx="83" ry="70" fill="white" opacity=".12" />
        </g>
      </svg>
      {paperPositions.slice(0, Math.min(Math.max(0, count), 32)).map(([left, top, size, angle], index) => (
        <span className="paper-population-item" key={index} style={{ left: `${left}%`, top: `${top}%`, width: size, transform: `rotate(${angle}deg)` }}>
          <PaperRoll />
        </span>
      ))}
      <div className="world-main-roll"><PaperRoll /></div>
      <span className="world-spark world-spark-one">✦</span>
      <span className="world-spark world-spark-two">✧</span>
      <div className="world-label"><span /> SOMEWHERE, ON A BREAK.</div>
    </div>
  );
}
