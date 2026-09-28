// 매니저 화면: 팀 현황 · 제출된 대화 · 사원 관리
import { fn, must, rpc, sb } from "../api.js";
import { go, page, productName, refresh, S, storeName } from "../core.js";
import { empty, esc, fmtDate, hbar, num1, spark, statusPill, toast } from "../ui.js";
import { bulkPanel, bulkActions, bulkChange, resultTable } from "./people-bulk.js";

page("dash", {
  title: "팀 현황",
  roles: ["manager"],
  render: async () => {
    const [stats, avg, missed, evs] = await Promise.all([
      rpc("team_practice_stats"), rpc("criteria_averages", { p_store: S.me.store_id }), rpc("missed_items", { p_store: S.me.store_id }),
      sb.from("evaluations").select("id, status, created_at, ai_total, compliance_rate").in("status", ["submitted", "reviewing", "completed"]).order("created_at", { ascending: false }).limit(100).then(must),
    ]);
    const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
    const attempts = stats.reduce((a, s) => a + s.attempts, 0);
    const waiting = evs.filter((e) => e.status !== "completed").length;
    const reviews = evs.filter((e) => e.status === "completed").map((e) => e.id);
    const rv = reviews.length ? must(await sb.from("manager_reviews").select("total").in("evaluation_id", reviews)) : [];
    const avgMgr = rv.length ? rv.reduce((a, r) => a + Number(r.total), 0) / rv.length : null;
    const comp = evs.filter((e) => e.compliance_rate != null);
    const avgComp = comp.length ? Math.round(comp.reduce((a, e) => a + e.compliance_rate, 0) / comp.length) : null;
    const byC = Object.fromEntries(avg.map((a) => [a.criterion_id, Number(a.avg)]));
    const rows = S.criteria.filter((c) => c.active).map((c) => ({ name: c.name, v: byC[c.id] }));
    const vals = rows.map((r) => r.v ?? 99); const lowest = rows.some((r) => r.v != null) ? vals.indexOf(Math.min(...vals)) : -1;
    const byProd = {}; missed.forEach((m) => (byProd[m.product_name] ??= []).push(m));
    return `<div class="stack">
      <div class="tiles">
        <div class="tile"><div class="k">평가 대기</div><div class="v">${waiting}<small> 건</small></div>${waiting ? '<button class="btn ghost sm" style="margin-top:4px" data-act="goto:review">평가하기</button>' : ""}</div>
        <div class="tile"><div class="k">팀 연습(최근 60일)</div><div class="v">${attempts}<small> 회</small></div></div>
        <div class="tile"><div class="k">매니저 평가 평균</div><div class="v">${num1(avgMgr)}<small> / 10</small></div></div>
        <div class="tile"><div class="k">교육자료 준수율</div><div class="v">${avgComp ?? "—"}<small> %</small></div></div>
      </div>
      <div class="panel"><h3>사원별 연습 현황</h3>
        ${stats.length ? `<div class="tbl"><table><thead><tr><th>사원</th><th class="r">연습</th><th class="r">최근 AI</th><th>추이</th><th>상태</th></tr></thead><tbody>
        ${stats.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td class="r num">${s.attempts}회</td><td class="r num">${num1(s.recent?.[0])}</td><td>${spark((s.recent ?? []).slice().reverse())}</td>
          <td>${s.submitted ? '<span class="pill p-warn">평가 대기</span>' : s.completed ? '<span class="pill p-good">완료</span>' : s.attempts ? '<span class="pill p-mute">연습 중</span>' : '<span class="hint">아직 없음</span>'}</td></tr>`).join("")}
        </tbody></table></div><div class="hint" style="margin-top:6px">연습 횟수와 AI 점수 추이만 보여요. 사원이 보내지 않은 연습 내용은 매니저에게 공개되지 않아요.</div>` : empty("등록된 사원이 없어요")}</div>
      <div class="panel"><h3>항목별 팀 평균 <span class="hint" style="font-weight:400">· AI 점수, 최근 60일</span></h3>
        ${rows.some((r) => r.v != null) ? `${hbar(rows, { lowest, label: "항목별 팀 평균" })}<div class="legend"><span><i class="sw"></i>팀 평균</span>${lowest >= 0 ? `<span><i class="sw low"></i>코칭 우선 항목: ${esc(rows[lowest].name)}</span>` : ""}</div>` : empty("아직 분석된 대화가 없어요")}</div>
      ${Object.keys(byProd).length ? `<div class="panel"><h3>자주 놓치는 교육 내용</h3><div class="stack" style="gap:12px">${Object.entries(byProd).map(([p, ms]) => `<div><div class="hint" style="margin-bottom:4px">${esc(p)}</div>
        ${ms.slice(0, 4).map((m) => `<div style="margin-top:6px"><div style="display:flex;justify-content:space-between;gap:8px;font-size:14px"><span>${esc(m.item)}</span><span class="num">누락 ${m.missed_pct}%</span></div><div class="bar" style="margin-top:4px"><i style="width:${m.missed_pct}%;background:var(--bad)"></i></div></div>`).join("")}</div>`).join("")}</div></div>` : ""}
    </div>`;
  },
  actions: { goto: (k) => go(k) },
});

let reviewTab = "wait";
page("review", {
  title: "제출된 대화",
  roles: ["manager", "admin"],
  render: async () => {
    const evs = must(await sb.from("evaluations").select("id, employee_id, product_id, kind, attempt_no, status, ai_total, created_at, submitted_at, store_id")
      .in("status", ["submitted", "reviewing", "completed", "transcribing", "analyzing", "failed"]).order("created_at", { ascending: false }).limit(200));
    const vis = evs.filter((e) => e.kind === "proxy" || !["transcribing", "analyzing", "failed"].includes(e.status));
    const names = await empNames(vis.map((e) => e.employee_id));
    const wait = vis.filter((e) => e.status !== "completed"), done = vis.filter((e) => e.status === "completed");
    const list = reviewTab === "wait" ? wait : done;
    return `<div class="stack">
      <div class="note">사원이 연습 중 가장 잘했다고 고른 대화와 매니저가 대신 올린 대화예요. AI 결과를 참고해 매니저 점수와 코멘트를 남기면 사원에게 공개됩니다.</div>
      <div class="chips"><button class="pill ${reviewTab === "wait" ? "p-info" : "p-mute"}" style="border:0;padding:6px 12px;font-size:13px" data-act="tab:wait">평가 대기 ${wait.length}</button>
        <button class="pill ${reviewTab === "done" ? "p-info" : "p-mute"}" style="border:0;padding:6px 12px;font-size:13px" data-act="tab:done">평가 완료 ${done.length}</button></div>
      ${list.length ? `<div class="list">${list.map((e) => `<button class="row" data-act="open:${e.id}"><div class="avatar">${esc((names[e.employee_id] ?? "?")[0])}</div>
        <div class="main"><div class="t">${esc(names[e.employee_id] ?? "사원")} · ${esc(productName(e.product_id))}</div>
        <div class="s">${fmtDate(e.submitted_at ?? e.created_at)}${S.me.role === "admin" ? ` · ${esc(storeName(e.store_id))}` : ""}</div>
        <div class="chips" style="margin-top:4px">${statusPill(e.status)}<span class="pill p-mute">${e.kind === "proxy" ? "대리 업로드" : `본인 제출 · ${e.attempt_no}회차`}</span></div></div>
        <div class="score">${num1(e.ai_total)}</div></button>`).join("")}</div>`
        : empty(reviewTab === "wait" ? "평가할 대화가 없어요" : "아직 평가를 마친 대화가 없어요")}
    </div>`;
  },
  actions: { tab: (t) => { reviewTab = t; return refresh(); }, open: (id) => go("eval", id) },
});

export async function empNames(ids) {
  ids = [...new Set(ids)];
  if (!ids.length) return {};
  const rows = must(await sb.from("profiles").select("id, name").in("id", ids));
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

let lastPw = null;
page("team", {
  title: "사원 관리",
  roles: ["manager"],
  render: async () => {
    const emps = must(await sb.from("profiles").select("id, name, emp_no, active, must_change_pw").eq("role", "employee").eq("store_id", S.me.store_id).order("name"));
    return `<div class="stack">
      ${lastPw ? `<div class="banner good"><div><b>${esc(lastPw.name)}</b>님의 새 초기 비밀번호: <b class="num">${esc(lastPw.pw)}</b><br>사원에게 직접 알려 주세요. 첫 로그인 때 새 비밀번호로 바꾸게 돼요.</div></div>` : ""}
      <div class="panel"><h3>한 명 등록</h3><form class="stack" style="gap:10px" id="one-form">
        <div class="field"><span>이름</span><input id="new-name" required></div>
        <div class="field"><span>사번(숫자 6~10자리)</span><input id="new-no" inputmode="numeric" pattern="\\d{6,10}" required></div>
        <button class="btn block" id="one-btn" type="submit">등록하고 초기 비밀번호 받기</button></form></div>
      ${bulkPanel("employee")}
      <div class="sec-title">우리 매장 사원 ${emps.length}명</div>
      ${emps.length ? `<div class="list">${emps.map((m) => `<div class="row"><div class="avatar">${esc(m.name[0])}</div><div class="main"><div class="t">${esc(m.name)} ${m.active ? "" : '<span class="pill p-mute">사용 중지</span>'}</div>
        <div class="s">사번 ${esc(m.emp_no)}${m.must_change_pw ? " · 첫 로그인 전" : ""}</div></div>
        <div class="row-actions"><button class="btn ghost sm" data-act="reset:${m.id}">비밀번호 초기화</button>
        <button class="btn ghost sm" data-act="active:${m.id}:${m.active ? 0 : 1}">${m.active ? "사용 중지" : "다시 사용"}</button></div></div>`).join("")}</div>` : empty("아직 등록된 사원이 없어요")}
    </div>`;
  },
  actions: {
    ...bulkActions,
    reset: async (id, btn) => {
      if (btn.dataset.confirm !== "1") { btn.dataset.confirm = "1"; btn.textContent = "한 번 더 누르면 초기화"; return; }
      const r = await fn("staff-admin", { action: "reset_password", user_id: id });
      const name = btn.closest(".row").querySelector(".t").textContent.trim();
      lastPw = { name, pw: r.password }; await refresh(); scrollTo(0, 0);
    },
    active: async (arg) => {
      const [id, on] = arg.split(":");
      await fn("staff-admin", { action: "set_active", user_id: id, active: on === "1" });
      toast(on === "1" ? "다시 사용할 수 있게 했어요" : "사용을 중지했어요"); await refresh();
    },
  },
  change: bulkChange,
  submit: async (ev) => {
    if (ev.target.id !== "one-form") return;
    const btn = document.getElementById("one-btn"); btn.disabled = true;
    try {
      const name = document.getElementById("new-name").value.trim(), emp_no = document.getElementById("new-no").value.trim();
      const { results } = await fn("staff-admin", { action: "create_users", role: "employee", rows: [{ row: 1, name, emp_no }] });
      const r = results[0];
      if (!r.ok) throw new Error(r.error);
      lastPw = { name, pw: r.password }; await refresh(); scrollTo(0, 0);
    } catch (e) { toast(e.message, true); } finally { if (btn.isConnected) btn.disabled = false; }
  },
});
export { resultTable };
