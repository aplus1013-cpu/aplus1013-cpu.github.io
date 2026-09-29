// 화면 조각: 아이콘, 배지, 차트, 형식 변환
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ICON = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  up: '<path d="M12 16V4M6 10l6-6 6 6M4 20h16"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.8 3 2.6 3.5 5.2"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5M9 7h6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
};
export const ic = (n, s) => `<svg class="i" viewBox="0 0 24 24" ${s ? `style="width:${s}px;height:${s}px"` : ""} aria-hidden="true">${ICON[n]}</svg>`;

export const STATUS = {
  uploading: ["p-info", "올리는 중"], transcribing: ["p-info", "텍스트 변환 중"], analyzing: ["p-info", "AI 분석 중"],
  practice: ["p-mute", "연습"], submitted: ["p-warn", "평가 대기"], reviewing: ["p-warn", "평가 중"],
  completed: ["p-good", "평가 완료"], failed: ["p-bad", "실패"],
};
export const statusPill = (s) => `<span class="pill ${STATUS[s]?.[0] ?? "p-mute"}">${STATUS[s]?.[1] ?? esc(s)}</span>`;
export const busy = (s) => ["uploading", "transcribing", "analyzing"].includes(s);
export const compPill = (st) => ({
  met: '<span class="pill p-good">충족</span>', partial: '<span class="pill p-warn">부분</span>',
  missed: '<span class="pill p-bad">누락</span>', violation: '<span class="pill p-bad">위반</span>', clear: '<span class="pill p-good">위반 없음</span>',
}[st] ?? "");

const today = () => new Date().toISOString().slice(0, 10);
export function productState(p) {
  const t = today();
  if (!p.active || (p.ends_on && p.ends_on < t)) return "ended";
  if (p.starts_on && p.starts_on > t) return "soon";
  return "live";
}
export const prodPill = (p) => ({ live: '<span class="pill p-good">진행 중</span>', ended: '<span class="pill p-mute">종료</span>', soon: '<span class="pill p-info">예정</span>' }[productState(p)]);
export const period = (p) => (p.starts_on || p.ends_on) ? `${fmtMD(p.starts_on) || "…"} – ${fmtMD(p.ends_on) || "…"}` : "기간 없음";
const fmtMD = (d) => d ? `${+d.slice(5, 7)}.${d.slice(8, 10)}` : "";

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export function fmtBytes(b) {
  if (b == null) return "";
  const mb = b / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(2) + "GB" : mb >= 10 ? Math.round(mb) + "MB" : mb >= 0.1 ? mb.toFixed(1) + "MB" : Math.max(1, Math.round(b / 1024)) + "KB";
}
export const mmss = (sec) => { const s = Math.max(0, Math.floor(sec || 0)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
export const toSec = (t) => { const m = String(t ?? "").match(/(\d+):(\d{2})/); return m ? +m[1] * 60 + +m[2] : 0; };
export const dur = (sec) => sec ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : "";
export const num1 = (v) => v == null || isNaN(v) ? "—" : Number(v).toFixed(1);

export function delta(a, b) {
  if (a == null || b == null) return "";
  const d = +(a - b).toFixed(1);
  if (!d) return '<span class="delta">±0.0</span>';
  return `<span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)}</span>`;
}

// 가로 막대 차트: rows [{name, v, dot}]
export function hbar(rows, opt = {}) {
  const W = 340, L = 112, R = 16, rowH = 26, top = 6, H = top + rows.length * rowH + 22, sx = (v) => L + (W - L - R) * Math.max(0, Math.min(10, v ?? 0)) / 10;
  let g = "";
  for (let t = 0; t <= 10; t += 2) g += `<line class="grid" x1="${sx(t)}" x2="${sx(t)}" y1="${top}" y2="${H - 18}"/><text x="${sx(t)}" y="${H - 4}" text-anchor="middle">${t}</text>`;
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const name = r.name.length > 9 ? r.name.slice(0, 8) + "…" : r.name;
    g += `<text class="lbl" x="${L - 8}" y="${y + 16}" text-anchor="end">${esc(name)}</text>`;
    if (r.v != null) g += `<rect x="${L}" y="${y + 6}" width="${Math.max(2, sx(r.v) - L)}" height="13" rx="4" fill="${i === opt.lowest ? "var(--warn)" : "var(--accent)"}"/>`;
    if (r.dot != null) g += `<circle cx="${sx(r.dot)}" cy="${y + 12.5}" r="4.5" fill="var(--ink)" stroke="var(--surface)" stroke-width="2"/>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(opt.label ?? "항목별 점수")}">${g}</svg>`;
}

// 회차 추이: pts [{x, v(0-10), c(0-100), sel}]
export function lineChart(pts) {
  if (!pts.length) return "";
  const W = 340, H = 150, L = 28, R = 12, T = 10, B = 26, n = pts.length;
  const sx = (i) => L + (n === 1 ? (W - L - R) / 2 : (W - L - R) * i / (n - 1)), sy = (v) => T + (H - T - B) * (1 - (v ?? 0) / 10);
  let g = "";
  for (let t = 0; t <= 10; t += 5) g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}"/><text x="${L - 6}" y="${sy(t) + 4}" text-anchor="end">${t}</text>`;
  const line = (key, col, dash) => {
    const val = (p) => key === "c" ? (p.c ?? 0) / 10 : p.v;
    return (n > 1 ? `<polyline points="${pts.map((p, i) => `${sx(i)},${sy(val(p))}`).join(" ")}" fill="none" stroke="${col}" stroke-width="2" ${dash ? 'stroke-dasharray="4 4"' : ""}/>` : "") +
      pts.map((p, i) => `<circle cx="${sx(i)}" cy="${sy(val(p))}" r="${p.sel && key === "v" ? 5.5 : 3.5}" fill="${col}" stroke="var(--surface)" stroke-width="2"/>`).join("");
  };
  g += line("c", "var(--good)", true) + line("v", "var(--accent)");
  const step = Math.ceil(n / 8);
  pts.forEach((p, i) => { if (i % step === 0 || i === n - 1) g += `<text x="${sx(i)}" y="${H - 6}" text-anchor="middle">${esc(p.x)}</text>`; });
  return `<svg class="linechart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="회차별 점수 추이">${g}</svg>`;
}

export function spark(vals) {
  vals = (vals ?? []).filter((v) => v != null).map(Number);
  if (!vals.length) return '<span class="hint">—</span>';
  if (vals.length === 1) vals = [vals[0], vals[0]];
  const W = 70, H = 22, mn = Math.min(...vals) - .5, mx = Math.max(...vals) + .5;
  const pts = vals.map((v, i) => [i * (W - 6) / (vals.length - 1) + 3, H - 3 - (v - mn) / (mx - mn) * (H - 6)]);
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="1.6"/><circle cx="${pts.at(-1)[0]}" cy="${pts.at(-1)[1]}" r="2.6" fill="var(--accent)"/></svg>`;
}

export const loading = (t = "불러오는 중…") => `<div class="loading"><span class="spin"></span>${esc(t)}</div>`;
export const empty = (t) => `<div class="empty">${esc(t)}</div>`;

let toastTimer;
export function toast(msg, isErr = false) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.className = "toast" + (isErr ? " err" : ""); el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 5000 : 3000);
}
