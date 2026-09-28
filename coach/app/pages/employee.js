// 사원 화면: 연습 기록(대표 1건 제출) · 받은 평가 · 교육자료
import { must, rpc, sb, signedUrl } from "../api.js";
import { go, page, productName, refresh, S } from "../core.js";
import { busy, delta, empty, esc, fmtDate, ic, lineChart, num1, period, prodPill, productState, statusPill, toast } from "../ui.js";

let pick = null, note = null, curProd = null;

page("history", {
  title: "내 연습 기록",
  roles: ["employee"],
  render: async (prodArg) => {
    const rows = must(await sb.from("evaluations").select("id, product_id, attempt_no, status, ai_total, compliance_rate, created_at, self_note, error")
      .eq("employee_id", S.me.id).eq("kind", "practice").order("attempt_no"));
    if (!rows.length) return `<div class="stack">${empty("아직 연습 기록이 없어요. ‘연습하기’에서 첫 녹음을 올려 보세요.")}<button class="btn block" data-act="goto:practice">연습하러 가기</button></div>`;
    const prods = [...new Set(rows.map((r) => r.product_id))];
    const pid = prods.includes(prodArg) ? prodArg : prods.includes(curProd) ? curProd : prods[prods.length - 1];
    if (pid !== curProd) { curProd = pid; pick = null; note = null; }
    const att = rows.filter((r) => r.product_id === pid);
    const done = att.filter((r) => r.ai_total != null);
    const sub = att.find((r) => ["submitted", "reviewing", "completed"].includes(r.status));
    const locked = sub && sub.status !== "submitted";
    const fromEval = sessionStorage.getItem("coach.pick");
    if (fromEval && att.some((a) => a.id === fromEval)) { pick = fromEval; sessionStorage.removeItem("coach.pick"); }
    if (pick == null) pick = sub?.id ?? null;
    if (note == null) note = sub?.self_note ?? "";
    const best = done.reduce((a, b) => (a == null || b.ai_total > a.ai_total ? b : a), null);
    const canPick = (r) => !locked && ["practice", "submitted"].includes(r.status);
    return `<div class="stack">
      <div class="chips">${prods.map((p) => `<button class="pill ${p === pid ? "p-info" : "p-mute"}" style="border:0;padding:6px 12px;font-size:13px" data-act="prod:${p}">${esc(productName(p))}</button>`).join("")}</div>
      <div class="tiles"><div class="tile"><div class="k">연습 횟수</div><div class="v">${att.length}<small> 회</small></div></div>
        <div class="tile"><div class="k">AI 최고 점수</div><div class="v">${num1(best?.ai_total)}</div>${best ? `<span class="hint">${best.attempt_no}회차 · 준수율 ${best.compliance_rate ?? "—"}%</span>` : ""}</div></div>
      ${done.length ? `<div class="panel"><h3>회차별 추이</h3>${lineChart(done.map((r) => ({ x: r.attempt_no + "회", v: Number(r.ai_total), c: r.compliance_rate, sel: r.id === pick })))}
        <div class="legend"><span><i class="sw"></i>AI 종합 점수</span><span><i class="sw" style="background:var(--good)"></i>교육자료 준수율(점선, 10=100%)</span></div></div>` : ""}
      <div class="sec-title">매니저에게 보여 줄 대화 1건 고르기</div>
      ${locked ? `<div class="banner good">${sub.attempt_no}회차를 보냈고 매니저 평가가 ${sub.status === "completed" ? "끝났어요. ‘받은 평가’에서 확인하세요." : "진행 중이라 바꿀 수 없어요."}</div>`
        : sub ? `<div class="banner warn">${sub.attempt_no}회차를 보냈어요. 매니저가 평가를 시작하기 전까지는 다른 회차로 바꾸거나 취소할 수 있어요.</div>` : ""}
      <div class="list">${att.slice().reverse().map((r) => `<div class="attempt" aria-pressed="${pick === r.id}">
        <button class="radio" style="background:none" data-act="pick:${r.id}" ${canPick(r) ? "" : "disabled"} aria-label="${r.attempt_no}회차 고르기"></button>
        <button style="border:0;background:none;text-align:left;padding:0" data-act="open:${r.id}"><div style="font-weight:600">${r.attempt_no}회차 ${r.id === best?.id ? '<span class="pill p-info">최고점</span>' : ""} ${r.status !== "practice" ? statusPill(r.status) : ""}</div>
          <div class="hint">${fmtDate(r.created_at)}${r.compliance_rate != null ? ` · 준수율 ${r.compliance_rate}%` : ""}</div></button>
        <div class="score">${busy(r.status) ? '<span class="spin"></span>' : num1(r.ai_total)}</div></div>`).join("")}</div>
      ${locked ? "" : `<div class="field"><span>매니저에게 한마디 (선택)</span><textarea id="self-note" data-note="1" placeholder="이 회차를 고른 이유나 더 연습 중인 부분을 적어 주세요.">${esc(note)}</textarea></div>
        <button class="btn block" data-act="submit" ${pick && pick !== sub?.id ? "" : pick && sub?.id === pick ? "" : "disabled"}>${pick ? `${att.find((a) => a.id === pick)?.attempt_no}회차를 매니저에게 ${sub && sub.id !== pick ? "바꿔서 " : sub?.id === pick ? "다시 " : ""}보내기` : "보낼 회차를 골라 주세요"}</button>
        ${sub && !locked ? '<button class="link" data-act="withdraw">보낸 것 취소하기</button>' : ""}`}
      <button class="btn ghost block" data-act="again">이 행사 다시 연습하기</button>
    </div>`;
  },
  actions: {
    goto: (k) => go(k),
    prod: (p) => { go("history", p); },
    pick: (id) => { pick = id; return refresh(); },
    open: (id) => go("eval", id),
    submit: async () => {
      await rpc("submit_attempt", { p_eval: pick, p_note: note });
      toast("매니저에게 보냈어요"); note = null; await refresh();
    },
    withdraw: async () => {
      const r = must(await sb.from("evaluations").select("id").eq("employee_id", S.me.id).eq("product_id", curProd).eq("status", "submitted").maybeSingle());
      if (r) await rpc("withdraw_attempt", { p_eval: r.id });
      pick = null; toast("보낸 것을 취소했어요"); await refresh();
    },
    again: async () => { const { startPractice } = await import("./upload.js"); startPractice(curProd); },
  },
  input: (ev) => { if (ev.target.dataset.note) note = ev.target.value; },
});

page("results", {
  title: "받은 평가",
  roles: ["employee"],
  render: async () => {
    const rows = must(await sb.from("evaluations").select("id, product_id, attempt_no, kind, status, ai_total, compliance_rate, created_at")
      .eq("employee_id", S.me.id).in("status", ["submitted", "reviewing", "completed"]).order("created_at", { ascending: false }));
    const doneIds = rows.filter((r) => r.status === "completed").map((r) => r.id);
    const reviews = doneIds.length ? must(await sb.from("manager_reviews").select("evaluation_id, total, tasks, completed_at").in("evaluation_id", doneIds)) : [];
    const rv = Object.fromEntries(reviews.map((r) => [r.evaluation_id, r]));
    const done = rows.filter((r) => r.status === "completed"), wait = rows.filter((r) => r.status !== "completed");
    const last = done[0], prev = done[1];
    return `<div class="stack">
      ${wait.map((r) => `<div class="banner info">${esc(productName(r.product_id))} ${r.kind === "practice" ? `${r.attempt_no}회차를 보냈어요` : "매니저가 올린 대화가 있어요"}. 매니저 평가를 기다리는 중이에요.</div>`).join("")}
      ${last ? `<div class="tiles"><div class="tile"><div class="k">최근 매니저 평가</div><div class="v">${num1(rv[last.id]?.total)}<small> / 10</small></div>${prev ? delta(rv[last.id]?.total, rv[prev.id]?.total) : ""} <span class="hint">AI ${num1(last.ai_total)}</span></div>
        <div class="tile"><div class="k">교육자료 준수율</div><div class="v">${last.compliance_rate ?? "—"}<small> %</small></div><span class="hint">${esc(productName(last.product_id))}</span></div></div>
        ${rv[last.id]?.tasks?.length ? `<div class="panel"><h3>매니저 코칭 과제</h3><ol class="tasks">${rv[last.id].tasks.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></div>` : ""}` : ""}
      <div class="sec-title">받은 평가</div>
      ${done.length ? `<div class="list">${done.map((r) => `<button class="row" data-act="open:${r.id}"><div class="main"><div class="t">${esc(productName(r.product_id))}</div>
        <div class="s">${fmtDate(rv[r.id]?.completed_at ?? r.created_at)}${r.kind === "practice" ? ` · ${r.attempt_no}회차` : " · 매니저가 올린 대화"}</div></div>
        <div style="text-align:right"><div class="score">${num1(rv[r.id]?.total)}</div><div class="hint" style="font-size:11px">매니저</div></div></button>`).join("")}</div>`
        : empty("아직 받은 평가가 없어요. 연습 기록에서 마음에 드는 회차를 매니저에게 보내 보세요.")}
    </div>`;
  },
  actions: { open: (id) => go("eval", id) },
});

let studyOpen = {};
page("study", {
  title: "교육자료",
  roles: ["employee", "manager", "admin"],
  render: async () => {
    const live = S.products.filter((p) => productState(p) === "live");
    if (!live.length) return empty("진행 중인 행사가 없어요");
    const mats = must(await sb.from("materials").select("id, product_id, title, file_path, mime, text_content").in("product_id", live.map((p) => p.id)).order("created_at"));
    return `<div class="stack">${live.map((p) => `<div class="panel"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><h3 style="margin:0">${esc(p.name)}</h3>${prodPill(p)}</div>
      <div class="hint">${period(p)}</div>
      <div class="chips" style="margin:10px 0">${mats.filter((m) => m.product_id === p.id).map((m) => `<button class="pill p-info" style="border:0;padding:4px 10px" data-act="mat:${m.id}">${ic("file", 14)} ${esc(m.title)}</button>`).join("") || '<span class="hint">올라온 자료가 없어요</span>'}</div>
      ${mats.filter((m) => m.product_id === p.id && studyOpen[m.id] && m.text_content).map((m) => `<div class="note" style="white-space:pre-wrap">${esc(m.text_content)}</div>`).join("")}
      ${["필수 설명", "필수 콜멘트", "금지 표현"].map((t) => { const xs = p.checklist.filter((c) => c.type === t); return xs.length ? `<div style="margin-top:8px"><span class="lab ${t === "금지 표현" ? "m" : "b"}">${t}</span><ul style="margin:2px 0 0;padding-left:18px">${xs.map((c) => `<li>${esc(c.text)}</li>`).join("")}</ul></div>` : ""; }).join("")}
      ${S.me.role === "employee" ? `<button class="btn ghost sm" style="margin-top:10px" data-act="practice:${p.id}">이 행사로 연습하기</button>` : ""}
    </div>`).join("")}</div>`;
    // 자료 목록은 렌더마다 새로 불러옴(관리자가 방금 올린 자료 반영)
  },
  actions: {
    mat: async (id) => {
      const m = must(await sb.from("materials").select("*").eq("id", id).single());
      if (m.file_path) window.open(await signedUrl("materials", m.file_path, 600), "_blank", "noopener");
      else { studyOpen[id] = !studyOpen[id]; await refresh(); }
    },
    practice: async (pid) => { const { startPractice } = await import("./upload.js"); startPractice(pid); },
  },
});
