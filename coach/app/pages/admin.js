// 관리자 화면: 전체 현황 · 계정 · 행사 품목과 교육자료 · 평가 항목
import { fn, must, rpc, sb, signedUrl } from "../api.js";
import { go, loadRefs, page, refresh, S, storeName } from "../core.js";
import { empty, esc, ic, num1, period, prodPill, toast } from "../ui.js";
import { bulkActions, bulkChange, bulkPanel } from "./people-bulk.js";

page("adash", {
  title: "전체 현황",
  roles: ["admin"],
  render: async () => {
    const [rows, missed] = await Promise.all([rpc("store_overview"), rpc("missed_items", { p_store: null })]);
    const tot = rows.reduce((a, r) => ({ att: a.att + r.attempts, wait: a.wait + r.waiting, emp: a.emp + r.employees }), { att: 0, wait: 0, emp: 0 });
    return `<div class="stack">
      <div class="tiles"><div class="tile"><div class="k">최근 30일 연습</div><div class="v">${tot.att}<small> 회</small></div></div>
        <div class="tile"><div class="k">평가 대기</div><div class="v">${tot.wait}<small> 건</small></div></div>
        <div class="tile"><div class="k">매장</div><div class="v">${rows.length}<small> 곳</small></div></div>
        <div class="tile"><div class="k">사원</div><div class="v">${tot.emp}<small> 명</small></div></div></div>
      <div class="panel"><h3>매장별 현황</h3>${rows.length ? `<div class="tbl"><table><thead><tr><th>매장</th><th>매니저</th><th class="r">사원</th><th class="r">연습(30일)</th><th class="r">평가 평균</th><th class="r">준수율</th><th class="r">평가 대기</th></tr></thead><tbody>
        ${rows.map((s) => `<tr><td><b>${esc(s.store_name)}</b></td><td>${esc(s.managers ?? "—")}</td><td class="r num">${s.employees}</td><td class="r num">${s.attempts}</td><td class="r num">${num1(s.avg_score)}</td><td class="r num">${s.avg_compliance ?? "—"}${s.avg_compliance != null ? "%" : ""}</td>
          <td class="r">${s.waiting ? `<span class="pill p-warn">${s.waiting}</span>` : '<span class="hint">0</span>'}</td></tr>`).join("")}</tbody></table></div>`
        : empty("매장이 없어요. ‘계정’에서 매니저를 등록하면 매장이 함께 만들어져요.")}</div>
      ${missed.length ? `<div class="panel"><h3>전체에서 자주 놓치는 교육 내용</h3>${missed.slice(0, 8).map((m) => `<div style="margin-top:8px"><div style="display:flex;justify-content:space-between;gap:8px;font-size:14px"><span><span class="hint">${esc(m.product_name)} · </span>${esc(m.item)}</span><span class="num">누락 ${m.missed_pct}%</span></div><div class="bar" style="margin-top:4px"><i style="width:${m.missed_pct}%;background:var(--bad)"></i></div></div>`).join("")}</div>` : ""}
      <div class="btns"><button class="btn ghost" data-act="goto:review">전체 제출 대화 보기</button><button class="btn ghost" data-act="goto:study">교육자료 보기</button></div>
    </div>`;
  },
  actions: { goto: (k) => go(k) },
});

let lastPw = null;
page("people", {
  title: "계정 관리",
  roles: ["admin"],
  render: async () => {
    const people = must(await sb.from("profiles").select("id, role, name, emp_no, email, store_id, active, must_change_pw").order("role").order("name"));
    const staff = people.filter((p) => p.role !== "employee"), emps = people.filter((p) => p.role === "employee");
    const role = { admin: "관리자", manager: "매니저" };
    return `<div class="stack">
      ${lastPw ? `<div class="banner good"><div><b>${esc(lastPw.name)}</b>님의 새 초기 비밀번호: <b class="num">${esc(lastPw.pw)}</b><br>직접 전달해 주세요. 첫 로그인 때 새 비밀번호로 바꾸게 돼요.</div></div>` : ""}
      <div class="panel"><h3>매니저·관리자 한 명 등록</h3><form class="stack" style="gap:10px" id="staff-form">
        <div class="field"><span>역할</span><select id="st-role"><option value="manager">매니저</option><option value="admin">관리자</option></select></div>
        <div class="field"><span>이름</span><input id="st-name" required></div>
        <div class="field"><span>이메일(로그인 아이디)</span><input id="st-email" type="email" required></div>
        <div class="field"><span>매장(매니저만, 없으면 새로 만듦)</span><input id="st-store" list="store-list"><datalist id="store-list">${S.stores.map((s) => `<option value="${esc(s.name)}">`).join("")}</datalist></div>
        <button class="btn block" id="st-btn" type="submit">등록하고 초기 비밀번호 받기</button></form></div>
      ${bulkPanel("manager")}
      ${bulkPanel("employee")}
      <div class="sec-title">매니저·관리자 ${staff.length}명</div>
      <div class="list">${staff.map((p) => row(p, `${role[p.role]}${p.store_id ? ` · ${storeName(p.store_id)}` : ""} · ${p.email ?? ""}`)).join("")}</div>
      <div class="sec-title">사원 ${emps.length}명</div>
      ${emps.length ? `<div class="list">${emps.map((p) => row(p, `${p.emp_no ? `사번 ${p.emp_no}` : "이름만 등록"}${p.store_id ? ` · ${storeName(p.store_id)}` : ""}`)).join("")}</div>` : empty("아직 사원이 없어요")}
    </div>`;
  },
  actions: {
    ...bulkActions,
    reset: async (id, btn) => {
      if (btn.dataset.confirm !== "1") { btn.dataset.confirm = "1"; btn.textContent = "한 번 더 누르면 초기화"; return; }
      const r = await fn("staff-admin", { action: "reset_password", user_id: id });
      lastPw = { name: btn.closest(".row").querySelector(".t").firstChild.textContent.trim(), pw: r.password }; await refresh(); scrollTo(0, 0);
    },
    active: async (arg) => {
      const [id, on] = arg.split(":");
      await fn("staff-admin", { action: "set_active", user_id: id, active: on === "1" });
      toast(on === "1" ? "다시 사용할 수 있게 했어요" : "사용을 중지했어요"); await refresh();
    },
  },
  change: bulkChange,
  submit: async (ev) => {
    if (ev.target.id !== "staff-form") return;
    const btn = document.getElementById("st-btn"); btn.disabled = true;
    try {
      const v = (id) => document.getElementById(id).value.trim();
      const role = v("st-role");
      const { results } = await fn("staff-admin", { action: "create_users", role, rows: [{ row: 1, name: v("st-name"), email: v("st-email"), store: role === "manager" ? v("st-store") : "" }] });
      if (!results[0].ok) throw new Error(results[0].error);
      lastPw = { name: v("st-name"), pw: results[0].password };
      await loadRefs(); await refresh(); scrollTo(0, 0);
    } catch (e) { toast(e.message, true); } finally { if (btn.isConnected) btn.disabled = false; }
  },
});
function row(p, sub) {
  const self = p.id === S.me.id;
  return `<div class="row"><div class="avatar">${esc(p.name[0])}</div><div class="main"><div class="t">${esc(p.name)} ${p.active ? "" : '<span class="pill p-mute">사용 중지</span>'}</div>
    <div class="s">${esc(sub)}${p.must_change_pw && (p.role !== "employee" || p.emp_no) ? " · 첫 로그인 전" : ""}</div></div>
    ${self ? '<span class="hint">나</span>' : `<div class="row-actions">${p.role === "employee" && !p.emp_no ? "" : `<button class="btn ghost sm" data-act="reset:${p.id}">비밀번호 초기화</button>`}
    <button class="btn ghost sm" data-act="active:${p.id}:${p.active ? 0 : 1}">${p.active ? "사용 중지" : "다시 사용"}</button></div>`}</div>`;
}

// ---- 행사 품목 · 교육자료 · 체크리스트 ----
let openProd = null, editing = null, newOpen = false, extracting = null;
const localCL = {}; // 저장 전 체크리스트 편집본(행사별)
const clOf = (p) => localCL[p.id] ?? p.checklist;
const CTYPES = ["필수 설명", "필수 콜멘트", "금지 표현"];
page("events", {
  title: "행사 품목 · 교육자료",
  roles: ["admin"],
  render: async () => {
    await loadRefs();
    const mats = must(await sb.from("materials").select("id, product_id, title, file_path, mime, created_at").order("created_at"));
    return `<div class="stack">
      <button class="btn block" data-act="newp">${newOpen ? "닫기" : "+ 행사 품목 등록"}</button>
      ${newOpen ? prodForm() : ""}
      ${S.products.length ? S.products.map((p) => {
        const open = openProd === p.id, ms = mats.filter((m) => m.product_id === p.id);
        return `<div class="panel">
          <button class="item-h" style="padding:0" data-act="toggle:${p.id}" aria-expanded="${open}"><span class="n">${esc(p.name)}</span>${prodPill(p)}<span style="transform:rotate(${open ? 180 : 0}deg);display:inline-flex">${ic("chev", 18)}</span></button>
          <div class="hint">${period(p)} · 교육자료 ${ms.length}개 · 체크 항목 ${p.checklist.length}개${localCL[p.id] ? " · 저장 안 한 변경 있음" : ""}</div>
          ${open ? `<div class="stack" style="gap:12px;margin-top:12px">
            ${editing === p.id ? prodForm(p) : `<button class="btn ghost sm" data-act="editp:${p.id}">기간·이름 수정</button>`}
            <div><b>교육자료</b>
              <div class="list" style="margin-top:6px">${ms.map((m) => `<div class="row"><div class="main"><div class="t">${ic("file", 14)} ${esc(m.title)}</div><div class="s">${esc(m.mime ?? "텍스트")}</div></div>
                <div class="row-actions">${m.file_path ? `<button class="btn ghost sm" data-act="viewm:${m.id}">열기</button>` : ""}<button class="btn danger sm" data-act="delm:${m.id}">삭제</button></div></div>`).join("") || '<div class="empty">아직 자료가 없어요</div>'}</div>
              <div class="drop" style="padding:14px;margin-top:8px"><div class="hint">PDF · 이미지 · 텍스트(.txt) · 제품 설명서, 콜멘트 대본 · 최대 50MB</div>
                <label class="btn ghost" for="mat-in-${p.id}">자료 파일 올리기</label><input id="mat-in-${p.id}" data-mat="${p.id}" type="file" accept=".pdf,.txt,.md,image/*" multiple hidden>
                <button class="link" data-act="textm:${p.id}">또는 콜멘트를 직접 붙여 넣기</button></div>
              ${textFor === p.id ? `<form class="stack" style="gap:8px;margin-top:8px" id="text-form" data-pid="${p.id}"><div class="field"><span>자료 이름</span><input id="tm-title" required placeholder="예: 10월 행사 콜멘트"></div>
                <div class="field"><span>내용</span><textarea id="tm-body" required style="min-height:140px"></textarea></div><button class="btn" type="submit">자료로 저장</button></form>` : ""}
            </div>
            <div><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>필수 체크리스트</b>
              <button class="btn sm" data-act="extract:${p.id}" ${ms.length && extracting !== p.id ? "" : "disabled"}>${extracting === p.id ? '<span class="spin"></span> AI가 읽는 중' : "AI로 체크리스트 뽑기"}</button></div>
              <div class="hint">AI가 교육자료를 읽고 필수 설명·필수 콜멘트·금지 표현을 뽑아요. 뽑은 뒤 직접 고칠 수 있어요. 다시 뽑으면 지금 목록을 바꿉니다.</div>
              <div id="cl-${p.id}">${clOf(p).map((c, i) => `<div class="check-edit"><select data-cl="${p.id}:${i}:type">${CTYPES.map((t) => `<option ${t === c.type ? "selected" : ""}>${t}</option>`).join("")}</select>
                <input data-cl="${p.id}:${i}:text" value="${esc(c.text)}" aria-label="체크 항목 내용"><button class="btn danger sm" data-act="delc:${p.id}:${i}" aria-label="삭제">삭제</button></div>`).join("")}</div>
              <div class="btns" style="margin-top:8px"><button class="btn ghost" data-act="addc:${p.id}">+ 항목 추가</button><button class="btn" data-act="savec:${p.id}">체크리스트 저장</button></div></div>
          </div>` : ""}</div>`;
      }).join("") : empty("등록된 행사 품목이 없어요")}
    </div>`;
  },
  actions: {
    newp: () => { newOpen = !newOpen; editing = null; return refresh(); },
    toggle: (id) => { openProd = openProd === id ? null : id; editing = null; textFor = null; return refresh(); },
    editp: (id) => { editing = id; return refresh(); },
    cancelp: () => { editing = null; newOpen = false; return refresh(); },
    textm: (id) => { textFor = textFor === id ? null : id; return refresh(); },
    viewm: async (id) => { const m = must(await sb.from("materials").select("file_path").eq("id", id).single()); window.open(await signedUrl("materials", m.file_path, 600), "_blank", "noopener"); },
    delm: async (id, btn) => {
      if (btn.dataset.confirm !== "1") { btn.dataset.confirm = "1"; btn.textContent = "한 번 더"; return; }
      const m = must(await sb.from("materials").select("file_path").eq("id", id).single());
      must(await sb.from("materials").delete().eq("id", id));
      if (m.file_path) await sb.storage.from("materials").remove([m.file_path]);
      toast("자료를 지웠어요"); await refresh();
    },
    extract: async (id) => {
      extracting = id; await refresh();
      try {
        const r = await fn("extract-checklist", { product_id: id });
        delete localCL[id];
        toast(`체크리스트 ${r.checklist.length}개를 뽑았어요. 확인하고 필요하면 고쳐 주세요`);
      } finally { extracting = null; await refresh(); }
    },
    addc: (id) => { const p = S.products.find((x) => x.id === id); syncChecklist(p); localCL[id].push({ id: Math.random().toString(36).slice(2, 10), type: "필수 설명", text: "" }); return refresh(); },
    delc: (arg) => { const [id, i] = arg.split(":"); const p = S.products.find((x) => x.id === id); syncChecklist(p); localCL[id].splice(+i, 1); return refresh(); },
    savec: (id) => { const p = S.products.find((x) => x.id === id); syncChecklist(p); return saveChecklist(p, "체크리스트를 저장했어요"); },
  },
  change: async (ev) => {
    const pid = ev.target.dataset.mat;
    if (!pid) return;
    const files = [...ev.target.files];
    ev.target.value = "";
    for (const f of files) {
      try {
        if (f.size > 50 * 1048576) throw new Error(`${f.name}: 50MB가 넘어요`);
        const text = /\.(txt|md)$/i.test(f.name) || f.type.startsWith("text/") ? await f.text() : null;
        let path = null;
        if (!text) {
          path = `${pid}/${Date.now()}-${f.name.replace(/[^\w.\-가-힣]/g, "_")}`;
          const up = await sb.storage.from("materials").upload(path, f, { contentType: f.type || "application/octet-stream" });
          if (up.error) throw new Error(`${f.name}: 올리지 못했어요 (${up.error.message})`);
        }
        must(await sb.from("materials").insert({ product_id: pid, title: f.name.replace(/\.[^.]+$/, ""), file_path: path, mime: text ? "text/plain" : f.type || null, text_content: text }));
        toast(`${f.name}을 올렸어요`);
      } catch (e) { toast(e.message, true); }
    }
    await refresh();
  },
  submit: async (ev) => {
    const f = ev.target;
    if (f.id === "text-form") {
      must(await sb.from("materials").insert({ product_id: f.dataset.pid, title: document.getElementById("tm-title").value.trim(), text_content: document.getElementById("tm-body").value, mime: "text/plain" }));
      textFor = null; toast("자료를 저장했어요"); return refresh();
    }
    if (f.id === "prod-form") {
      const v = (id) => document.getElementById(id).value;
      const row = { name: v("pf-name").trim(), starts_on: v("pf-start") || null, ends_on: v("pf-end") || null, active: document.getElementById("pf-active").checked };
      if (!row.name) return toast("품목명을 입력해 주세요", true);
      if (row.starts_on && row.ends_on && row.starts_on > row.ends_on) return toast("끝나는 날이 시작일보다 빨라요", true);
      try {
        if (f.dataset.id) must(await sb.from("products").update(row).eq("id", f.dataset.id));
        else { const p = must(await sb.from("products").insert(row).select("id").single()); openProd = p.id; }
        editing = null; newOpen = false; toast("저장했어요"); await refresh();
      } catch (e) { toast(e.message, true); }
    }
  },
});
let textFor = null;
function prodForm(p) {
  return `<form class="panel stack" style="gap:10px" id="prod-form" ${p ? `data-id="${p.id}"` : ""}>
    <div class="field"><span>품목명</span><input id="pf-name" required value="${esc(p?.name ?? "")}" placeholder="예: 하이드라 수분크림 1+1"></div>
    <div class="btns"><div class="field" style="flex:1"><span>시작일</span><input id="pf-start" type="date" value="${p?.starts_on ?? ""}"></div><div class="field" style="flex:1"><span>종료일</span><input id="pf-end" type="date" value="${p?.ends_on ?? ""}"></div></div>
    <label style="display:flex;gap:8px;font-size:14px"><input type="checkbox" id="pf-active" ${p?.active === false ? "" : "checked"}> 사용 중(끄면 연습 목록에서 빠져요)</label>
    <div class="btns"><button class="btn ghost" type="button" data-act="cancelp">취소</button><button class="btn" type="submit">저장</button></div></form>`;
}
// 화면의 입력값을 편집본에 옮김
function syncChecklist(p) {
  const cl = localCL[p.id] ??= p.checklist.map((c) => ({ ...c }));
  document.querySelectorAll(`[data-cl^="${p.id}:"]`).forEach((el) => {
    const [, i, k] = el.dataset.cl.split(":");
    if (cl[i]) cl[i][k] = el.value;
  });
}
async function saveChecklist(p, msg) {
  const cl = (localCL[p.id] ?? p.checklist).filter((c) => c.text.trim()).map((c) => ({ id: c.id, type: c.type, text: c.text.trim() }));
  must(await sb.from("products").update({ checklist: cl }).eq("id", p.id));
  delete localCL[p.id]; p.checklist = cl;
  toast(msg); await refresh();
}

// ---- 평가 항목 ----
page("criteria", {
  title: "평가 항목",
  roles: ["admin"],
  render: async () => {
    await loadRefs();
    return `<div class="stack"><div class="note">모든 평가에 공통으로 쓰는 항목이에요. AI와 매니저가 같은 항목으로 점수를 매겨요. ‘보는 행동’은 AI가 채점할 때 기준으로 읽어요. 가중치는 AI 종합 점수에 반영돼요.</div>
      ${S.criteria.map((c) => `<form class="panel stack crit-form" style="gap:8px" data-id="${c.id}">
        <div class="btns"><div class="field" style="flex:2"><span>항목 이름</span><input name="name" value="${esc(c.name)}" required></div>
          <div class="field" style="flex:1"><span>가중치</span><input name="weight" type="number" step="0.1" min="0.1" max="5" value="${c.weight}"></div>
          <div class="field" style="flex:1"><span>순서</span><input name="sort_order" type="number" value="${c.sort_order}"></div></div>
        <div class="field"><span>보는 행동</span><input name="description" value="${esc(c.description)}"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><label style="display:flex;gap:8px;font-size:14px"><input type="checkbox" name="active" ${c.active ? "checked" : ""}> 사용</label><button class="btn sm" type="submit">저장</button></div>
      </form>`).join("")}
      <button class="btn ghost block" data-act="addcrit">+ 평가 항목 추가</button></div>`;
  },
  actions: {
    addcrit: async () => {
      must(await sb.from("criteria").insert({ name: "새 항목", description: "", sort_order: (S.criteria.at(-1)?.sort_order ?? 0) + 1 }));
      toast("항목을 추가했어요. 이름과 보는 행동을 적어 주세요"); await refresh();
    },
  },
  submit: async (ev) => {
    const f = ev.target;
    if (!f.classList.contains("crit-form")) return;
    const d = new FormData(f);
    try {
      must(await sb.from("criteria").update({ name: d.get("name").trim(), description: d.get("description").trim(), weight: Number(d.get("weight")) || 1, sort_order: Number(d.get("sort_order")) || 0, active: d.get("active") === "on" }).eq("id", f.dataset.id));
      toast("저장했어요"); await refresh();
    } catch (e) { toast(e.message, true); }
  },
});
