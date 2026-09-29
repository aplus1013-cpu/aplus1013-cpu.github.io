import { fn, friendly, must, rpc, sb } from "./api.js";
import { FFMPEG_CORE, STAFF_DOMAIN, SUPABASE_KEY, SUPABASE_URL } from "./config.js";
import { go, loadRefs, page, render, S, storeName } from "./core.js";
import { esc, toast } from "./ui.js";
import "./pages/upload.js";
import "./pages/evaluation.js";
import "./pages/employee.js";
import "./pages/manager.js";
import "./pages/admin.js";
import "./pages/best.js";
import "./pages/batch.js";

// ---- 로그인 상태 불러오기 ----
export async function loadMe() {
  const { data: { session } } = await sb.auth.getSession();
  S.session = session;
  S.me = null;
  if (!session) return;
  const { data, error } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (error) throw new Error(friendly(error.message));
  if (!data || !data.active) {
    await sb.auth.signOut();
    throw new Error("등록된 계정 정보가 없어요. 관리자에게 문의해 주세요");
  }
  S.me = data;
  await loadRefs();
  S.me.store_name = storeName(S.me.store_id);
  await refreshWaiting();
}

export async function refreshWaiting() {
  if (S.me?.role !== "manager") { S.waiting = 0; return; }
  const { data } = await sb.from("evaluations").select("id").in("status", ["submitted", "reviewing"]);
  S.waiting = data?.length ?? 0;
}

const toEmail = (id) => id.includes("@") ? id.trim().toLowerCase() : `${id.trim()}@${STAFF_DOMAIN}`;

// ---- 로그인 ----
page("login", {
  title: "로그인",
  render: async () => `<form class="login" id="login-form">
    <div class="brand"><div class="mark">SC</div><b>매장 판매 코칭</b></div>
    <h1>부담 없이 편하게,<br>내 판매 대화를 연습해 보세요</h1>
    <p>녹음을 올리면 AI 코치가 잘한 점과 다듬을 점을 바로 알려 드려요. 연습 기록은 나만 볼 수 있으니 몇 번이든 마음껏 해 보세요. 마음에 드는 대화가 생기면 그때 매니저에게 보여 주면 돼요.</p>
    <div class="field"><span>이메일 또는 사번</span><input id="login-id" name="id" autocomplete="username" required></div>
    <div class="field"><span>비밀번호</span><input id="login-pw" name="pw" type="password" autocomplete="current-password" required></div>
    <div id="login-err" class="banner bad" hidden></div>
    <button class="btn block" id="login-btn" type="submit">로그인</button>
    <div class="hint">사원은 사번으로, 매니저와 관리자는 이메일로 로그인합니다. 비밀번호를 잊은 사원은 담당 매니저에게 초기화를 요청하세요.</div>
    <div class="row-actions" style="justify-content:space-between">
      <button class="link" type="button" data-act="goto:setup">처음 설정(첫 관리자 만들기)</button>
      <button class="link" type="button" data-act="goto:selftest">시스템 점검</button>
    </div>
  </form>`,
  actions: { goto: (k) => go(k) },
  submit: async () => {
    const btn = document.getElementById("login-btn"), err = document.getElementById("login-err");
    const id = document.getElementById("login-id").value, pw = document.getElementById("login-pw").value;
    btn.disabled = true; err.hidden = true;
    try {
      const { error } = await sb.auth.signInWithPassword({ email: toEmail(id), password: pw });
      if (error) throw new Error(friendly(error.message));
      await loadMe();
      go("home");
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
    } finally { btn.disabled = false; }
  },
});

// ---- 첫 관리자 만들기 ----
page("setup", {
  title: "처음 설정",
  render: async () => `<form class="login" id="setup-form">
    <div class="brand"><div class="mark">SC</div><b>처음 설정</b></div>
    <p>앱을 처음 쓸 때 한 번만 합니다. 전달받은 설정 코드로 첫 관리자 계정을 만드세요. 관리자가 생기면 이 화면은 더 이상 쓸 수 없어요.</p>
    <div class="field"><span>설정 코드</span><input id="setup-code" required autocomplete="off"></div>
    <div class="field"><span>이름</span><input id="setup-name" required></div>
    <div class="field"><span>이메일(로그인 아이디)</span><input id="setup-email" type="email" required autocomplete="username"></div>
    <div class="field"><span>비밀번호(8자 이상)</span><input id="setup-pw" type="password" minlength="8" required autocomplete="new-password"></div>
    <div id="setup-err" class="banner bad" hidden></div>
    <button class="btn block" id="setup-btn" type="submit">관리자 만들고 로그인</button>
    <button class="link" type="button" data-act="goto:login">로그인으로 돌아가기</button>
  </form>`,
  actions: { goto: (k) => go(k) },
  submit: async () => {
    const v = (id) => document.getElementById(id).value;
    const btn = document.getElementById("setup-btn"), err = document.getElementById("setup-err");
    btn.disabled = true; err.hidden = true;
    try {
      await fn("staff-admin", { action: "bootstrap", code: v("setup-code"), name: v("setup-name"), email: v("setup-email"), password: v("setup-pw") });
      const { error } = await sb.auth.signInWithPassword({ email: v("setup-email").trim().toLowerCase(), password: v("setup-pw") });
      if (error) throw new Error(friendly(error.message));
      await loadMe();
      toast("관리자 계정을 만들었어요");
      go("home");
    } catch (e) { err.textContent = e.message; err.hidden = false; } finally { btn.disabled = false; }
  },
});

// ---- 비밀번호 바꾸기(첫 로그인 때 필수) ----
page("password", {
  title: "비밀번호 바꾸기",
  render: async () => `<form class="stack" id="pw-form">
    ${S.me?.must_change_pw ? '<div class="banner info">처음 로그인하셨어요. 받은 초기 비밀번호 대신 나만 아는 비밀번호로 바꿔 주세요.</div>' : ""}
    <div class="field"><span>새 비밀번호(8자 이상)</span><input id="pw-new" type="password" minlength="8" required autocomplete="new-password"></div>
    <div class="field"><span>새 비밀번호 확인</span><input id="pw-new2" type="password" minlength="8" required autocomplete="new-password"></div>
    <div id="pw-err" class="banner bad" hidden></div>
    <button class="btn block" id="pw-btn" type="submit">비밀번호 바꾸기</button>
    ${S.me?.must_change_pw ? '<button class="link" type="button" data-act="logout">로그아웃</button>' : ""}
  </form>`,
  actions: { logout: () => logout() },
  submit: async () => {
    const a = document.getElementById("pw-new").value, b = document.getElementById("pw-new2").value;
    const err = document.getElementById("pw-err"), btn = document.getElementById("pw-btn");
    err.hidden = true;
    if (a.length < 8) { err.textContent = "비밀번호는 8자 이상이어야 해요"; err.hidden = false; return; }
    if (a !== b) { err.textContent = "두 비밀번호가 서로 달라요"; err.hidden = false; return; }
    btn.disabled = true;
    try {
      const { error } = await sb.auth.updateUser({ password: a });
      if (error) throw new Error(friendly(error.message));
      await rpc("password_changed");
      S.me.must_change_pw = false;
      toast("비밀번호를 바꿨어요");
      go("home");
    } catch (e) { err.textContent = e.message; err.hidden = false; } finally { btn.disabled = false; }
  },
});

async function logout() {
  await sb.auth.signOut();
  S.me = null; S.session = null;
  go("login");
}

// ---- 메뉴 ----
page("menu", {
  title: "메뉴",
  back: true,
  render: async () => `<div class="stack">
    <div class="list menu-list">
      <button class="row" data-act="goto:password"><div class="main"><div class="t">비밀번호 바꾸기</div></div></button>
      <button class="row" data-act="goto:selftest"><div class="main"><div class="t">시스템 점검</div><div class="s">서버·AI·음성 인식 연결 상태를 확인해요</div></div></button>
      <button class="row" data-act="logout"><div class="main"><div class="t">로그아웃</div></div></button>
    </div>
    <div class="panel"><h3>휴대폰에 앱으로 설치하기</h3>
      <div class="stack" style="gap:6px;font-size:14px">
        <div><b>아이폰(사파리)</b>: 아래 공유 버튼 → ‘홈 화면에 추가’</div>
        <div><b>안드로이드(크롬)</b>: 오른쪽 위 ⋮ → ‘앱 설치’ 또는 ‘홈 화면에 추가’</div>
      </div></div>
  </div>`,
  actions: { goto: (k) => go(k), logout: () => logout() },
});

// ---- 시스템 점검(실제 서버에서 모든 연결을 확인) ----
page("selftest", {
  title: "시스템 점검",
  back: true,
  render: async () => `<div class="stack">
    <div class="note">앱이 제대로 동작하는 데 필요한 연결을 하나씩 확인합니다. 실패한 항목이 있으면 이 화면을 캡처해 담당자에게 보내 주세요.</div>
    <div class="panel" id="st-list"></div>
    <button class="btn block" data-act="run">다시 점검</button>
    ${S.me ? "" : '<button class="link" data-act="goto:login">로그인으로 돌아가기</button>'}
  </div>`,
  mounted: () => runSelfTest(),
  actions: { run: () => runSelfTest(), goto: (k) => go(k) },
});

async function runSelfTest() {
  const box = document.getElementById("st-list");
  if (!box) return;
  const items = [];
  const draw = () => {
    box.innerHTML = items.map((i) => `<div class="st"><span class="${i.s}">${i.s === "ok" ? "✓" : i.s === "no" ? "✗" : "…"}</span><div><b>${esc(i.name)}</b>
      <div class="hint">${esc(i.msg ?? "")}</div></div></div>`).join("");
  };
  const check = async (name, f) => {
    const it = { name, s: "wait", msg: "확인 중" }; items.push(it); draw();
    try { const m = await f(); it.s = "ok"; it.msg = m ?? "정상"; } catch (e) { it.s = "no"; it.msg = e.message; }
    draw();
    return it.s === "ok";
  };
  const online = await check("서버 연결", async () => {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: SUPABASE_KEY } });
    if (!r.ok) throw new Error(`서버 응답 코드 ${r.status}`);
    return "Supabase 서버에 연결됨";
  });
  if (!online) return;
  await check("서버 함수", async () => {
    const h = await fn("staff-admin", { action: "health" });
    S.health = h;
    return "계정·녹음·AI 함수가 응답함";
  });
  await check("앱 설치 기능", async () => {
    if (!("serviceWorker" in navigator)) throw new Error("이 브라우저는 앱 설치를 지원하지 않아요");
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? "설치 준비됨" : "아직 준비 중(새로고침하면 준비됨)";
  });
  await check("음성 변환 엔진(큰 파일·동영상 압축)", async () => {
    const r = await fetch(`${FFMPEG_CORE}/ffmpeg-core.js`, { method: "HEAD" });
    if (!r.ok) throw new Error("변환 엔진을 받지 못했어요. 작은 음성 파일은 변환 없이 올릴 수 있어요");
    return "사용 가능";
  });
  if (!S.me) {
    items.push({ name: "로그인 후 점검", s: "wait", msg: "로그인하면 권한과 AI·음성 인식 키 설정도 확인해요" }); draw();
    return;
  }
  await check("로그인과 권한", async () => `${S.me.name} · ${({ admin: "관리자", manager: "매니저", employee: "사원" })[S.me.role]}`);
  await check("기본 데이터", async () => {
    const c = must(await sb.from("criteria").select("id").eq("active", true));
    if (!c.length) throw new Error("평가 항목이 없어요. 관리자 → 평가 항목에서 추가해 주세요");
    return `평가 항목 ${c.length}개, 행사 품목 ${S.products.length}개`;
  });
  await check("녹음 저장소", async () => {
    const { error } = await sb.storage.from("recordings").list("", { limit: 1 });
    if (error) throw new Error(friendly(error.message));
    return "사용 가능";
  });
  await check("AI 분석 키", async () => {
    if (!S.health?.anthropic) throw new Error("Supabase → Edge Functions → Secrets에 ANTHROPIC_API_KEY를 넣어 주세요");
    return "설정됨";
  });
  await check("음성 인식 키(CLOVA)", async () => {
    if (!S.health?.clova) throw new Error("Supabase → Edge Functions → Secrets에 CLOVA_INVOKE_URL, CLOVA_SECRET_KEY를 넣어 주세요");
    return "설정됨";
  });
}

// ---- 시작 ----
sb.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT" && S.me) { S.me = null; go("login"); }
});

(async () => {
  try { await loadMe(); } catch (e) { toast(e.message, true); }
  render();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
