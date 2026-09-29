// 앱 상태, 화면 등록, 라우팅, 공통 이벤트 처리
import { must, sb } from "./api.js";
import { esc, ic, loading, toast } from "./ui.js";

export const S = {
  session: null,
  me: null,          // profiles 행 + store_name
  criteria: [],
  products: [],
  stores: [],
};

const pages = {};
// def: { title, tab?, render(params) => html(async), actions: {name(arg, el, ev)}, input?(ev), change?(ev) }
export function page(name, def) { pages[name] = def; }

export const TABS = {
  employee: [["practice", "연습하기", "up"], ["history", "연습 기록", "chart"], ["results", "받은 평가", "inbox"], ["best", "우수 사례", "star"], ["study", "교육자료", "book"]],
  manager: [["dash", "홈", "home"], ["review", "제출됨", "inbox"], ["upload", "대리 업로드", "up"], ["best", "우수 사례", "star"], ["team", "사원", "users"]],
  admin: [["adash", "전체 현황", "home"], ["batch", "일괄 평가", "up"], ["people", "계정", "users"], ["events", "행사·교육자료", "book"], ["criteria", "평가 항목", "list"], ["best", "우수 사례", "star"]],
};

export function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const [name, ...rest] = h.split("/");
  return { name: name || null, arg: rest.join("/") || null };
}
export function go(name, arg) {
  const h = `#/${name}${arg ? "/" + arg : ""}`;
  if (location.hash === h) render(); else location.hash = h;
}

export async function loadRefs() {
  const [c, p, s] = await Promise.all([
    sb.from("criteria").select("*").order("sort_order"),
    sb.from("products").select("*").order("created_at", { ascending: false }),
    sb.from("stores").select("*").order("name"),
  ]);
  S.criteria = must(c); S.products = must(p); S.stores = must(s);
}
export const productName = (id) => S.products.find((p) => p.id === id)?.name ?? "(삭제된 행사)";
export const storeName = (id) => S.stores.find((s) => s.id === id)?.name ?? "";

let renderSeq = 0;
let current = null;
export async function render() {
  const seq = ++renderSeq;
  const app = document.getElementById("app"), tabsEl = document.getElementById("tabs");
  let { name, arg } = route();
  const role = S.me?.role;

  // 로그인 전에는 로그인/처음 설정/시스템 점검만
  if (!S.me) {
    if (!["login", "setup", "selftest"].includes(name)) name = "login";
  } else if (S.me.must_change_pw && name !== "selftest") {
    name = "password";
  } else if (!name || name === "login" || name === "setup" || !pages[name] || (pages[name].roles && !pages[name].roles.includes(role))) {
    name = TABS[role][0][0];
  }
  const def = pages[name];
  current = { name, arg, def };

  const tabs = S.me && !S.me.must_change_pw ? TABS[role] : null;
  document.body.classList.toggle("wide", role === "admin" || role === "manager");
  tabsEl.hidden = !tabs;
  if (tabs) {
    document.getElementById("tabs-in").innerHTML = tabs.map(([k, l, i]) =>
      `<button data-act="nav:${k}" aria-current="${name === k ? "page" : "false"}">${ic(i)}${l}${k === "review" && S.waiting ? `<span class="dot">${S.waiting}</span>` : ""}</button>`).join("");
  }
  const title = typeof def.title === "function" ? def.title(arg) : def.title;
  const top = S.me
    ? `<div class="topbar">${def.back ? `<button class="back" data-act="back" aria-label="뒤로">${ic("back", 20)}</button>` : ""}<h1>${esc(title)}</h1>
       <div class="who"><b>${esc(S.me.name)}</b><br>${esc(S.me.role === "employee" ? `사번 ${S.me.emp_no ?? ""}` : S.me.role === "manager" ? `${S.me.store_name ?? ""} 매니저` : "관리자")}</div>
       <button class="icon-btn" data-act="menu">메뉴</button></div>`
    : "";
  if (!def.keepScroll) app.innerHTML = top + loading();
  try {
    const html = await def.render(arg);
    if (seq !== renderSeq) return; // 그새 다른 화면으로 이동함
    app.innerHTML = top + html;
    def.mounted?.(arg);
  } catch (e) {
    if (seq !== renderSeq) return;
    console.error(e);
    app.innerHTML = top + `<div class="banner bad">화면을 불러오지 못했어요: ${esc(e.message)}</div>
      <div class="btns" style="margin-top:12px"><button class="btn ghost" data-act="reload">다시 시도</button></div>`;
  }
}

// 현재 화면만 다시 그림(스크롤 유지)
export async function refresh() {
  const y = scrollY;
  const keep = current?.def.keepScroll;
  if (current?.def) current.def.keepScroll = true;
  await render();
  if (current?.def) current.def.keepScroll = keep;
  scrollTo(0, y);
}

const global = {
  nav: (k) => { go(k); scrollTo(0, 0); },
  back: () => history.length > 1 ? history.back() : go(TABS[S.me.role][0][0]),
  reload: () => render(),
  menu: () => go("menu"),
};

export function onBusy(btn, label = "처리 중…") {
  if (!btn) return () => {};
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin"></span> ${esc(label)}`;
  return () => { btn.disabled = false; btn.innerHTML = old; };
}

// 버튼 동작 공통 처리: 오류는 알림으로 보여 줌
export async function runAction(fnc, btn, ...args) {
  const done = onBusy(btn);
  try { await fnc(...args); } catch (e) { console.error(e); toast(e.message ?? String(e), true); } finally { if (btn?.isConnected) done(); }
}

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const raw = el.dataset.act; const i = raw.indexOf(":");
  const a = i < 0 ? raw : raw.slice(0, i), arg = i < 0 ? null : raw.slice(i + 1);
  const h = current?.def?.actions?.[a] ?? global[a];
  if (!h) return;
  ev.preventDefault();
  // 비동기 동작은 누르는 동안 버튼을 잠그고, 실패하면 이유를 알림으로 보여 줌
  let r;
  try { r = h(arg, el, ev); } catch (e) { console.error(e); toast(e.message ?? String(e), true); return; }
  if (r?.then) runAction(() => r, el.tagName === "BUTTON" && !el.dataset.nobusy ? el : null);
});
document.addEventListener("input", (ev) => current?.def?.input?.(ev));
document.addEventListener("change", (ev) => current?.def?.change?.(ev));
document.addEventListener("submit", (ev) => { ev.preventDefault(); current?.def?.submit?.(ev); });
window.addEventListener("hashchange", () => render());
