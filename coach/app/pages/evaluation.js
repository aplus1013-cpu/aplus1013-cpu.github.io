// 평가 상세: AI 결과 · 매니저 평가 입력/결과 · 우수 사례 공유 · 녹취
import { fn, must, rpc, sb, signedUrl } from "../api.js";
import { go, page, productName, refresh, S, storeName } from "../core.js";
import { refreshWaiting } from "../main.js";
import { busy, compPill, delta, dur, esc, fmtDate, hbar, ic, mmss, num1, statusPill, toast } from "../ui.js";

let E = null; // 현재 화면 데이터
let open = {};
let draft = null, share = null, showTx = false, poll = null, curId = null;

async function load(id) {
  const ev = must(await sb.from("evaluations").select("*").eq("id", id).maybeSingle());
  if (!ev) throw new Error("기록을 찾을 수 없거나 볼 권한이 없어요");
  const [emp, review, best, prev, avg] = await Promise.all([
    sb.from("profiles").select("id, name, emp_no").eq("id", ev.employee_id).maybeSingle().then((r) => r.data),
    sb.from("manager_reviews").select("*").eq("evaluation_id", id).maybeSingle().then((r) => r.data),
    S.me.role === "employee" ? null : sb.from("best_practices").select("id").eq("evaluation_id", id).maybeSingle().then((r) => r.data),
    ev.kind === "practice" && ev.attempt_no > 1 && ev.employee_id === S.me.id
      ? sb.from("evaluations").select("ai_total").eq("employee_id", ev.employee_id).eq("product_id", ev.product_id).eq("attempt_no", ev.attempt_no - 1).maybeSingle().then((r) => r.data)
      : null,
    rpc("criteria_averages", { p_store: ev.store_id }).catch(() => []),
  ]);
  let reviewer = null;
  if (review?.manager_id) reviewer = (await sb.from("profiles").select("name").eq("id", review.manager_id).maybeSingle()).data?.name ?? null;
  E = { ev, emp, review, best, prev, avg: Object.fromEntries((avg ?? []).map((a) => [a.criterion_id, Number(a.avg)])), reviewer };
  const canReview = S.me.role !== "employee" && ["submitted", "reviewing"].includes(ev.status);
  if (canReview && (!draft || draft.id !== id)) {
    const items = ev.ai?.items ?? S.criteria.filter((c) => c.active).map((c) => ({ criterion_id: c.id, name: c.name, score: 5 }));
    const saved = Object.fromEntries((review?.scores ?? []).map((s) => [s.criterion_id, s.score]));
    draft = { id, scores: items.map((i) => ({ criterion_id: i.criterion_id, name: i.name, ai: i.score, score: saved[i.criterion_id] ?? i.score })), comment: review?.comment ?? "", tasks: (review?.tasks?.length ? review.tasks : ev.ai?.tasks ?? []).join("\n") };
  }
  if (!share || share.id !== id) share = { id, point: "", scope: "all", emp: false, priv: false, ch: {} };
}

function view() {
  const { ev, emp, review } = E;
  const isStaff = S.me.role !== "employee";
  const ai = ev.ai;
  const title = isStaff ? emp?.name ?? "사원" : ev.kind === "practice" ? `${ev.attempt_no}회차 연습` : "매니저가 올린 평가";
  let out = `<div><div style="font-size:22px;font-weight:700">${esc(title)}</div>
    <div class="meta"><span>${esc(productName(ev.product_id))}</span><span>${fmtDate(ev.created_at)}</span>${ev.audio_seconds ? `<span>대화 ${dur(ev.audio_seconds)}</span>` : ""}</div>
    <div class="chips" style="margin-top:6px">${statusPill(ev.status)}${isStaff ? (ev.kind === "proxy" ? '<span class="pill p-mute">매니저 대리 업로드</span>' : `<span class="pill p-mute">본인 제출 · ${ev.attempt_no}회차</span>`) : ""}</div></div>`;

  if (busy(ev.status)) {
    return out + `<div class="panel"><div class="loading" style="padding:10px 0"><span class="spin"></span>${ev.status === "transcribing" ? "말소리를 텍스트로 바꾸는 중이에요" : ev.status === "analyzing" ? "AI가 대화를 분석하는 중이에요" : "파일을 올리는 중이에요"}</div>
      <div class="hint" style="text-align:center">자동으로 새로고침돼요. 화면을 닫아도 분석은 계속됩니다.</div></div>`;
  }
  if (ev.status === "failed") {
    const mine = ev.employee_id === S.me.id || ev.uploaded_by === S.me.id || isStaff;
    return out + `<div class="banner bad">${esc(ev.error ?? "처리 중 문제가 생겼어요")}</div>
      ${mine ? `<div class="btns"><button class="btn" data-act="retry">다시 시도</button>${ev.employee_id === S.me.id || ev.uploaded_by === S.me.id ? '<button class="btn danger" data-act="del">이 기록 지우기</button>' : ""}</div>` : ""}`;
  }
  if (!ai) return out + '<div class="empty">아직 분석 결과가 없어요</div>';

  if (!isStaff && ev.status === "practice") out += '<div class="banner info">연습 결과는 나만 볼 수 있어요. 마음에 드는 회차는 ‘연습 기록’에서 매니저에게 보여 줄 수 있어요.</div>';
  if (ev.self_note && (isStaff || ev.status !== "practice")) out += `<div class="panel"><span class="lab b">사원 메모</span>${esc(ev.self_note)}</div>`;

  const counts = { met: 0, partial: 0, missed: 0, violation: 0, clear: 0 };
  (ai.compliance ?? []).forEach((c) => counts[c.status]++);
  const showMgr = review && (isStaff || ev.status === "completed") && review.completed_at;
  out += `<div class="tiles">
    ${showMgr ? `<div class="tile"><div class="k">매니저 평가</div><div class="v">${num1(review.total)}<small> / 10</small></div><span class="hint">AI ${num1(ev.ai_total)}</span></div>`
      : `<div class="tile"><div class="k">AI 종합 점수</div><div class="v">${num1(ev.ai_total)}<small> / 10</small></div>${E.prev?.ai_total != null ? delta(ev.ai_total, E.prev.ai_total) + ' <span class="hint">이전 회차 대비</span>' : ""}</div>`}
    <div class="tile"><div class="k">교육자료 준수율</div><div class="v">${ev.compliance_rate ?? "—"}<small> %</small></div><span class="hint">충족 ${counts.met + counts.clear} · 부분 ${counts.partial} · 누락 ${counts.missed}${counts.violation ? ` · 위반 ${counts.violation}` : ""}</span></div></div>`;

  if (showMgr) {
    out += `<div class="panel"><h3>매니저 평가 <span class="hint" style="font-weight:400">· ${esc(E.reviewer ?? "")} · ${fmtDate(review.completed_at)}</span></h3>
      ${review.comment ? `<p style="margin:0 0 10px;white-space:pre-wrap">${esc(review.comment)}</p>` : ""}
      ${review.tasks?.length ? `<span class="lab b">코칭 과제</span><ol class="tasks">${review.tasks.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}</div>
      <div class="panel"><h3>항목별 점수: 매니저 vs AI</h3>
      ${hbar(review.scores.map((s) => ({ name: s.name, v: s.score, dot: ai.items.find((i) => i.criterion_id === s.criterion_id)?.score })), { label: "매니저 점수와 AI 점수" })}
      <div class="legend"><span><i class="sw"></i>매니저 점수</span><span><i class="sw dot"></i>AI 점수</span></div></div>`;
  }
  if (isStaff && ["submitted", "reviewing"].includes(ev.status)) out += reviewForm();
  if (isStaff && ev.status === "completed") out += sharePanel();

  if (ai.compliance?.length) {
    out += `<div class="panel"><h3>교육자료 준수 체크 <span class="hint" style="font-weight:400">· AI</span></h3>
      ${ai.compliance.map((c) => `<div class="check"><div>${compPill(c.status)}</div><div class="req">${esc(c.text)}</div><div class="type">${esc(c.type)}${c.note ? ` · ${esc(c.note)}` : ""}</div>
        ${c.quote || c.time ? `<div class="ev">${c.time ? `<button class="ts link" data-act="seek:${esc(c.time)}" style="text-decoration:none">${esc(c.time)}</button> ` : ""}${esc(c.quote)}</div>` : ""}</div>`).join("")}</div>`;
  }
  if (!showMgr) {
    const low = ai.items.reduce((a, b, i, arr) => (b.score < arr[a].score ? i : a), 0);
    out += `<div class="panel"><h3>항목별 AI 점수</h3>
      ${hbar(ai.items.map((i) => ({ name: i.name, v: i.score, dot: E.avg[i.criterion_id] })), { lowest: low })}
      <div class="legend"><span><i class="sw"></i>이번 점수</span><span><i class="sw dot"></i>매장 평균(최근 60일)</span><span><i class="sw low"></i>가장 낮은 항목</span></div></div>`;
  }
  out += `<div class="panel"><h3>항목별 근거와 개선점 <span class="hint" style="font-weight:400">· AI</span></h3>
    ${ai.items.map((it, i) => `<div class="item"><button class="item-h" data-act="item:${i}" aria-expanded="${!!open[i]}">
      <span class="n">${esc(it.name)}</span>${E.avg[it.criterion_id] != null ? (it.score >= E.avg[it.criterion_id] ? '<span class="pill p-good">평균 이상</span>' : '<span class="pill p-mute">평균 이하</span>') : ""}
      <span class="score" style="font-size:16px">${it.score}</span><span style="transform:rotate(${open[i] ? 180 : 0}deg);display:inline-flex">${ic("chev", 18)}</span></button>
      ${open[i] ? `<div class="item-b"><p><span class="lab b">평가 근거</span>${esc(it.basis)}</p>${it.improvement ? `<p><span class="lab m">이렇게 해 보세요</span>${esc(it.improvement)}</p>` : ""}</div>` : ""}</div>`).join("")}
    <button class="link" data-act="allitems" style="margin-top:8px">${Object.values(open).some(Boolean) ? "모두 접기" : "모두 펼치기"}</button></div>`;
  out += `<div class="panel"><h3>AI 총평과 연습 과제</h3><p style="margin:0 0 10px">${esc(ai.summary)}</p>${ai.tasks?.length ? `<ol class="tasks">${ai.tasks.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}</div>`;

  out += `<div class="panel"><h3>녹음과 녹취</h3>
    ${ev.audio_path && !ev.audio_deleted ? `<audio id="ev-audio" controls preload="none" data-path="${esc(ev.audio_path)}"></audio>` : '<div class="hint">원본 녹음은 저장 공간을 아끼려고 지웠어요(7일 지난 미제출 연습). 녹취는 남아 있어요.</div>'}
    <div class="meta" style="margin-top:6px">${ev.orig_name ? `<span>${esc(ev.orig_name)}</span>` : ""}${ev.orig_size ? `<span>원본 ${fmtB(ev.orig_size)} → 전송 ${fmtB(ev.sent_size)}</span>` : ""}</div>
    <button class="btn ghost" style="margin-top:10px" data-act="tx">${showTx ? "녹취 접기" : "대화 녹취 보기 (화자 구분)"}</button>
    ${showTx ? transcript() : ""}</div>`;

  if (!isStaff && ev.employee_id === S.me.id && ev.kind === "practice") {
    out += `<div class="btns">${ev.status === "practice" ? `<button class="btn" data-act="tohist">연습 기록에서 이 회차 제출하기</button>` : ""}
      <button class="btn ghost" data-act="again">같은 행사 다시 연습</button></div>
      ${ev.status === "practice" ? '<button class="link" data-act="del" style="color:var(--bad)">이 연습 기록 지우기</button>' : ""}`;
  }
  return out;
}
const fmtB = (b) => b == null ? "" : b > 1048576 ? (b / 1048576).toFixed(1) + "MB" : Math.round(b / 1024) + "KB";

function transcript() {
  const seller = E.ev.ai?.seller_speaker;
  return `<div class="transcript" style="margin-top:10px">${(E.ev.transcript ?? []).map((l) =>
    `<div class="ln ${l.spk === seller ? "me" : ""}"><button class="ts link" style="text-decoration:none;font-weight:400" data-act="seek:${mmss(l.s)}">${mmss(l.s)}</button><span class="who">${l.spk === seller ? "사원" : "고객"}</span><span>${esc(l.t)}</span></div>`).join("")}</div>`;
}

function reviewForm() {
  const d = draft;
  const total = (d.scores.reduce((a, s) => a + s.score, 0) / (d.scores.length || 1)).toFixed(1);
  return `<div class="panel" id="review-form"><h3>매니저 평가 입력</h3>
    <div class="hint" style="margin:-6px 0 10px">AI 점수를 참고해 매니저 점수를 매겨 주세요. AI와 2점 이상 차이 나면 표시돼요. AI 점수는 바뀌지 않아요.</div>
    <div class="cmp h"><span>항목</span><span style="text-align:center">AI</span><span style="text-align:right">매니저</span></div>
    ${d.scores.map((s, i) => `<div class="cmp"><span>${esc(s.name)} <span class="gap" id="gap-${i}">${Math.abs(s.score - s.ai) >= 2 ? `차이 ${Math.abs(s.score - s.ai)}` : ""}</span></span><span class="ai">${s.ai ?? "—"}</span>
      <input class="scorebox" type="number" inputmode="numeric" min="0" max="10" step="1" id="ms-${i}" value="${s.score}" data-ms="${i}" aria-label="${esc(s.name)} 매니저 점수"></div>`).join("")}
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:8px"><b>매니저 종합(단순 평균)</b><span class="num" style="font-size:20px" id="ms-total">${total}</span></div>
    <div class="field" style="margin-top:12px"><span>총평 (사원에게 보입니다)</span><textarea id="mg-comment" data-mc="1" placeholder="현장에서 본 모습, AI가 놓친 점, 칭찬할 점을 적어 주세요.">${esc(d.comment)}</textarea></div>
    <div class="field" style="margin-top:10px"><span>코칭 과제 (한 줄에 하나)</span><textarea id="mg-tasks" data-mt="1">${esc(d.tasks)}</textarea></div>
    <div class="btns" style="margin-top:12px"><button class="btn ghost" data-act="save:0">임시 저장</button><button class="btn" data-act="save:1">평가 완료하고 공개</button></div>
    <div class="hint" style="margin-top:6px">임시 저장하면 사원은 제출 회차를 바꿀 수 없게 돼요.</div></div>`;
}

function sharePanel() {
  if (E.best) return `<div class="banner good" style="align-items:center">우수 사례 게시판에 공유된 대화예요. <button class="btn ghost sm" data-act="gobest">게시판 보기</button></div>`;
  if (!E.ev.audio_path || E.ev.audio_deleted) return "";
  const hl = E.ev.ai?.highlights ?? [];
  const sh = share;
  return `<div class="panel"><h3>우수 사례로 공유</h3>
    <div class="hint" style="margin:-6px 0 10px">다른 사원들이 들으며 벤치마킹할 수 있게 이 대화를 게시판에 올립니다.</div>
    <div class="field"><span>추천 포인트 (무엇을 들어 보면 좋은지)</span><textarea id="share-point" data-sp="1" placeholder="예: 세럼을 집어 든 순간 바로 묶음 제안으로 연결하는 부분">${esc(sh.point)}</textarea></div>
    ${hl.length ? `<div class="field" style="margin-top:10px"><span>들어 볼 구간 (AI가 찾은 잘한 장면)</span><div class="stack" style="gap:6px">
      ${hl.map((h, i) => `<label class="choice" style="padding:8px 12px;cursor:pointer"><input type="checkbox" id="ch-${i}" data-ch="${i}" ${sh.ch[i] !== false ? "checked" : ""}><span class="num" style="color:var(--accent);font-size:13px">${esc(h.time)}</span><span class="main" style="font-size:14px"><b>${esc(h.label)}</b><br><span class="hint">${esc(h.quote)}</span></span></label>`).join("")}</div></div>` : ""}
    <div class="field" style="margin-top:10px"><span>공개 범위</span><select id="share-scope" data-scope="1"><option value="all" ${sh.scope === "all" ? "selected" : ""}>전체 매장</option><option value="store" ${sh.scope === "store" ? "selected" : ""}>우리 매장(${esc(storeName(E.ev.store_id))})만</option></select></div>
    <label style="display:flex;gap:8px;margin-top:12px;font-size:14px;cursor:pointer"><input type="checkbox" id="ok-emp" data-ok="emp" ${sh.emp ? "checked" : ""}> ${esc(E.emp?.name ?? "사원")}님에게 공유 동의를 받았어요</label>
    <label style="display:flex;gap:8px;margin-top:6px;font-size:14px;cursor:pointer"><input type="checkbox" id="ok-priv" data-ok="priv" ${sh.priv ? "checked" : ""}> 녹음에 고객의 이름·연락처 등 개인정보가 없는 것을 확인했어요</label>
    <button class="btn block" style="margin-top:12px" id="share-btn" data-act="share" ${sh.emp && sh.priv && sh.point.trim() ? "" : "disabled"}>게시판에 공유</button></div>`;
}

function schedulePoll(id) {
  clearTimeout(poll);
  if (!E || !busy(E.ev.status)) return;
  poll = setTimeout(async () => {
    if (location.hash !== `#/eval/${id}`) return;
    const { data } = await sb.from("evaluations").select("status").eq("id", id).maybeSingle();
    if (data && data.status !== E.ev.status) await refresh(); else schedulePoll(id);
  }, 4000);
}

page("eval", {
  title: () => E?.ev?.status === "practice" && S.me.role === "employee" ? "연습 결과" : "평가 결과",
  back: true,
  render: async (id) => { if (curId !== id) { curId = id; open = {}; showTx = false; } await load(id); schedulePoll(id); return `<div class="stack">${view()}</div>`; },
  mounted: () => {
    const a = document.getElementById("ev-audio");
    if (a) a.addEventListener("play", async () => { if (!a.dataset.ready) { a.dataset.ready = 1; a.src = await signedUrl("recordings", a.dataset.path); a.play(); } }, { once: false });
  },
  actions: {
    item: (i) => { open[i] = !open[i]; return refresh(); },
    allitems: () => { const any = Object.values(open).some(Boolean); open = {}; if (!any) E.ev.ai.items.forEach((_, i) => { open[i] = true; }); return refresh(); },
    tx: () => { showTx = !showTx; return refresh(); },
    seek: async (t) => {
      const a = document.getElementById("ev-audio");
      if (!a) return;
      if (!a.dataset.ready) { a.dataset.ready = 1; a.src = await signedUrl("recordings", a.dataset.path); }
      const [m, s] = t.split(":").map(Number); a.currentTime = m * 60 + s; a.play();
    },
    retry: async () => { await fn("process-recording", { evaluation_id: E.ev.id, retry: true }); toast("다시 시작했어요"); await refresh(); },
    del: async (_, btn) => {
      if (btn.dataset.confirm !== "1") { btn.dataset.confirm = "1"; btn.textContent = "한 번 더 누르면 지워져요"; return; }
      must(await sb.from("evaluations").delete().eq("id", E.ev.id));
      if (E.ev.audio_path) await sb.storage.from("recordings").remove([E.ev.audio_path]);
      toast("기록을 지웠어요"); go(S.me.role === "employee" ? "history" : "review");
    },
    tohist: () => { sessionStorage.setItem("coach.pick", E.ev.id); go("history", E.ev.product_id); },
    again: async () => { const { startPractice } = await import("./upload.js"); startPractice(E.ev.product_id); },
    save: async (complete) => {
      const d = draft;
      if (d.scores.some((s) => !(s.score >= 0 && s.score <= 10))) throw new Error("점수는 0~10 사이로 입력해 주세요");
      await rpc("save_review", { p_eval: E.ev.id, p_scores: d.scores.map(({ criterion_id, name, score }) => ({ criterion_id, name, score })), p_comment: d.comment, p_tasks: d.tasks.split("\n").map((x) => x.trim()).filter(Boolean), p_complete: complete === "1" });
      toast(complete === "1" ? `평가를 완료했어요. ${E.emp?.name ?? "사원"}님에게 공개됐어요` : "임시 저장했어요");
      draft = null; await refreshWaiting(); await refresh(); scrollTo(0, 0);
    },
    share: async () => {
      const hl = E.ev.ai?.highlights ?? [];
      const chapters = hl.filter((_, i) => share.ch[i] !== false);
      await rpc("share_best", { p_eval: E.ev.id, p_point: share.point, p_chapters: chapters, p_scope: share.scope, p_consent_employee: share.emp, p_consent_privacy: share.priv });
      toast("우수 사례 게시판에 공유했어요"); await refresh();
    },
    gobest: () => go("best"),
  },
  input: (ev) => {
    const t = ev.target;
    if (t.dataset.ms != null && draft) {
      const i = +t.dataset.ms; const v = Math.max(0, Math.min(10, Math.round(+t.value || 0)));
      draft.scores[i].score = v;
      const g = Math.abs(v - (draft.scores[i].ai ?? v));
      document.getElementById("gap-" + i).textContent = g >= 2 ? `차이 ${g}` : "";
      document.getElementById("ms-total").textContent = (draft.scores.reduce((a, s) => a + s.score, 0) / draft.scores.length).toFixed(1);
    }
    if (t.dataset.mc && draft) draft.comment = t.value;
    if (t.dataset.mt && draft) draft.tasks = t.value;
    if (t.dataset.sp && share) { share.point = t.value; syncShareBtn(); }
  },
  change: (ev) => {
    const t = ev.target;
    if (t.dataset.ok && share) { share[t.dataset.ok] = t.checked; syncShareBtn(); }
    if (t.dataset.ch != null && share) share.ch[t.dataset.ch] = t.checked;
    if (t.dataset.scope && share) share.scope = t.value;
  },
});
function syncShareBtn() {
  const b = document.getElementById("share-btn");
  if (b) b.disabled = !(share.emp && share.priv && share.point.trim());
}
