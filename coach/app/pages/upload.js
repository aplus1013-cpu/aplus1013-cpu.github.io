// 녹음 올리기: 사원 연습(본인) · 매니저 대리 업로드(사원 선택) 공용 흐름
import { fn, must, sb } from "../api.js";
import { MAX_UPLOAD } from "../config.js";
import { go, page, refresh, S, storeName } from "../core.js";
import { kindOf, passThrough, prepareAudio, WARN_SIZE } from "../media.js";
import { busy, esc, fmtBytes, ic, period, prodPill, productState, STATUS, toast } from "../ui.js";

let F = null; // 진행 중인 올리기 상태
let employees = [];

function reset(mode) {
  if (F?.audioUrl) URL.revokeObjectURL(F.audioUrl);
  clearTimeout(F?.poll);
  F = { mode, step: mode === "practice" ? 2 : 1, emp: mode === "practice" ? S.me.id : null, prod: null, file: null, prep: null, phase: "pick", pct: 0, stage: "", evalId: null, status: null, error: null };
}

const liveProducts = () => S.products.filter((p) => productState(p) === "live");

async function view(mode) {
  if (!F || F.mode !== mode) reset(mode);
  if (mode === "proxy" && !employees.length) {
    employees = must(await sb.from("profiles").select("id, name, emp_no, store_id").eq("role", "employee").eq("active", true).order("name"));
  }
  const isEmp = mode === "practice";
  const step = (n, l) => `<div class="step ${F.step === n ? "on" : F.step > n ? "done" : ""}">${isEmp ? n - 1 : n}. ${l}</div>`;
  const steps = isEmp ? `<div class="stepper" style="grid-template-columns:repeat(2,1fr)">${step(2, "행사 품목")}${step(3, "파일 올리기")}</div>`
    : `<div class="stepper">${step(1, "사원")}${step(2, "행사 품목")}${step(3, "파일 올리기")}</div>`;
  let body = "";
  if (F.phase === "pick" && F.step === 1) {
    body = `<div class="note">매니저가 올린 대화는 연습 단계 없이 바로 매니저 평가로 들어갑니다.</div>
      <div class="sec-title">누구의 판매 대화인가요?</div>
      ${employees.length ? `<div class="grid2">${employees.map((m) => `<button class="choice" aria-pressed="${F.emp === m.id}" data-act="emp:${m.id}"><div class="avatar">${esc(m.name[0])}</div><div class="main"><div class="t">${esc(m.name)}</div><div class="hint">사번 ${esc(m.emp_no)}${S.me.role === "admin" ? ` · ${esc(storeName(m.store_id))}` : ""}</div></div></button>`).join("")}</div>`
        : '<div class="empty">등록된 사원이 없어요. ‘사원’ 탭에서 먼저 등록해 주세요.</div>'}
      <button class="btn block" data-act="next" ${F.emp ? "" : "disabled"}>다음</button>`;
  } else if (F.phase === "pick" && F.step === 2) {
    const cnt = isEmp ? await myCounts() : {};
    const list = liveProducts();
    body = `${isEmp ? '<div class="note">횟수 제한 없이 연습할 수 있어요. 결과는 바로 나에게만 보입니다.</div>'
      : `<div class="note">사원: <b>${esc(employees.find((e) => e.id === F.emp)?.name)}</b> <button class="btn ghost sm" data-act="step:1">변경</button></div>`}
      <div class="sec-title">어떤 행사 품목을 판매했나요?</div>
      ${list.length ? `<div class="stack" style="gap:8px">${list.map((p) => `<button class="choice" aria-pressed="${F.prod === p.id}" data-act="prod:${p.id}"><div class="main"><div class="t">${esc(p.name)}</div><div class="hint">${period(p)} · 체크 항목 ${p.checklist.length}개${isEmp ? ` · 내 연습 ${cnt[p.id] ?? 0}회` : ""}</div></div>${prodPill(p)}</button>`).join("")}</div>`
        : '<div class="empty">진행 중인 행사 품목이 없어요. 관리자에게 등록을 요청해 주세요.</div>'}
      <button class="btn block" data-act="next" ${F.prod ? "" : "disabled"}>다음</button>`;
  } else if (F.phase === "pick") {
    const p = S.products.find((x) => x.id === F.prod);
    body = `<div class="note">${isEmp ? "" : `사원: <b>${esc(employees.find((e) => e.id === F.emp)?.name)}</b> · `}행사: <b>${esc(p.name)}</b> <button class="btn ghost sm" data-act="step:2">변경</button></div>
      <div class="drop">${ic("up", 28)}<div><b>녹음 또는 동영상 파일을 올려 주세요</b><div class="hint">m4a · mp3 · wav · mp4 · mov 등 · 원본 2GB까지</div></div>
        <label class="btn" for="file-in">파일 선택</label><input id="file-in" type="file" accept="audio/*,video/*,.m4a,.mp3,.wav,.aac,.mp4,.mov" hidden></div>
      <div class="note">동영상은 음성만 뽑아내고, 큰 파일은 휴대폰 안에서 음성 인식용으로 압축한 뒤 보냅니다. 원본은 기기에 그대로 남습니다.</div>
      ${p.checklist.length ? `<div class="panel"><h3 style="font-size:14px">AI가 확인할 교육 내용 (${p.checklist.length}개)</h3><div class="stack" style="gap:4px;font-size:13.5px">${p.checklist.map((c) => `<div><span class="hint">${esc(c.type)} · </span>${esc(c.text)}</div>`).join("")}</div></div>`
        : '<div class="banner warn">이 행사는 아직 교육자료 체크리스트가 없어요. 공통 평가 항목으로만 점검합니다.</div>'}`;
  } else {
    body = processView();
  }
  return `<div class="stack">${F.phase === "pick" ? steps : ""}${body}</div>`;
}

async function myCounts() {
  const rows = must(await sb.from("evaluations").select("product_id").eq("employee_id", S.me.id).eq("kind", "practice"));
  return rows.reduce((a, r) => (a[r.product_id] = (a[r.product_id] ?? 0) + 1, a), {});
}

function processView() {
  const f = F.file;
  const stages = [
    ["prep", f && kindOf(f) === "video" ? "동영상에서 음성 추출·압축" : "음성 준비·압축"],
    ["uploading", "서버로 올리기"], ["transcribing", "말소리를 텍스트로 변환(화자 구분)"], ["analyzing", "교육자료 기준으로 AI 분석"],
  ];
  const order = ["prep", "ready", "uploading", "transcribing", "analyzing", "done"];
  const cur = F.phase === "prep" ? "prep" : F.phase === "ready" ? "ready" : F.status ?? "uploading";
  const ci = order.indexOf(busy(cur) || cur === "prep" || cur === "ready" ? cur : "done");
  const shown = F.phase === "prep" || F.phase === "ready" ? stages.slice(0, 1) : stages;
  let out = `<div class="panel"><div class="meta" style="margin-bottom:10px"><span>${ic("file", 16)} ${esc(f.name)}</span><span>${kindOf(f) === "video" ? "동영상" : "음성"} · 원본 ${fmtBytes(f.size)}</span></div>
    <div class="stages">${shown.map(([k, l]) => {
      const i = order.indexOf(k); const failed = F.phase === "failed" && i === ci;
      const st = failed ? "wait" : i < ci || (k === "prep" && F.prep) ? "done" : i === ci ? "run" : "wait";
      return `<div class="stage ${st}"><span class="ic">${st === "done" ? "✓" : failed ? "!" : ""}</span><span>${l}</span><span class="num hint" id="${k === "prep" ? "prep-pct" : ""}">${k === "prep" && st === "run" ? F.pct + "%" : ""}</span></div>`;
    }).join("")}</div>
    ${F.phase === "prep" ? `<div class="hint" id="prep-stage" style="margin-top:10px">${esc(F.stage)}</div><div class="bar" style="margin-top:6px"><i id="prep-bar" style="width:${F.pct}%"></i></div>` : ""}</div>`;
  if (F.prep) {
    out += `<div class="panel"><div class="sizes"><div><div class="k">원본</div><div class="v">${fmtBytes(f.size)}</div></div><div class="hint">→</div><div><div class="k">보낼 음성</div><div class="v" style="color:var(--good)">${fmtBytes(F.prep.blob.size)}</div></div></div>
      <div class="hint" style="text-align:center;margin-top:6px">${F.prep.converted ? `${Math.max(0, 100 - F.prep.blob.size / f.size * 100).toFixed(1)}% 줄었어요 · 모노 16kHz` : "작은 음성 파일이라 그대로 보내요"}</div></div>`;
  }
  if (F.phase === "ready") {
    out += `<div class="panel"><h3 style="font-size:14px">미리듣기</h3><audio controls preload="metadata" src="${F.audioUrl}"></audio><div class="hint">목소리가 잘 들리는지 확인한 뒤 보내 주세요.</div></div>
      <div class="btns"><button class="btn ghost" data-act="again">다른 파일</button><button class="btn" data-act="send">올리고 AI 점검 시작</button></div>`;
  }
  if (F.phase === "wait") {
    out += `<div class="note">${F.status === "transcribing" ? "녹음 길이에 따라 1~5분쯤 걸려요." : F.status === "analyzing" ? "AI가 대화를 꼼꼼히 읽고 있어요. 1~2분쯤 걸려요." : "올리는 중이에요."} 이 화면을 닫아도 분석은 계속되고, 결과는 ‘연습 기록’에서 볼 수 있어요.</div>`;
  }
  if (F.phase === "failed") {
    out += `<div class="banner bad">${esc(F.error)}</div><div class="btns">
      ${F.evalId && F.status === "failed" ? '<button class="btn" data-act="retry">다시 시도</button>' : ""}<button class="btn ghost" data-act="again">처음부터 다시</button></div>`;
  }
  return out;
}

async function pickFile(file) {
  if (!file) return;
  if (kindOf(file) === "unknown") { toast("녹음(음성) 또는 동영상 파일만 올릴 수 있어요", true); return; }
  if (file.size > WARN_SIZE) toast("2GB가 넘는 파일은 기기에 따라 변환이 느리거나 실패할 수 있어요");
  F.file = file; F.phase = "prep"; F.pct = 0; F.stage = passThrough(file) ? "확인 중" : "준비 중"; F.prep = null;
  await refresh();
  try {
    F.prep = await prepareAudio(file, {
      onStage: (s) => { F.stage = s; const el = document.getElementById("prep-stage"); if (el) el.textContent = s; },
      onProgress: (p) => { F.pct = p; const b = document.getElementById("prep-bar"), t = document.getElementById("prep-pct"); if (b) b.style.width = p + "%"; if (t) t.textContent = p + "%"; },
    });
    if (F.prep.blob.size > MAX_UPLOAD) throw new Error("파일이 50MB를 넘어요");
    F.audioUrl = URL.createObjectURL(F.prep.blob);
    F.phase = "ready";
  } catch (e) {
    F.phase = "failed"; F.error = e.message;
  }
  await refresh();
}

async function send() {
  const { blob, ext, mime } = F.prep;
  F.phase = "wait"; F.status = "uploading"; await refresh();
  let id;
  try {
    const row = must(await sb.from("evaluations").insert({ employee_id: F.emp, product_id: F.prod, kind: F.mode, uploaded_by: S.me.id }).select("id").single());
    id = F.evalId = row.id;
    const path = `${id}.${ext}`;
    const up = await sb.storage.from("recordings").upload(path, blob, { contentType: mime, upsert: false });
    if (up.error) throw new Error(up.error.message?.includes("size") ? "파일이 너무 커요(최대 50MB)" : "파일을 올리지 못했어요. 인터넷 연결을 확인해 주세요");
    const r = await fn("process-recording", { evaluation_id: id, audio_path: path, orig_name: F.file.name, orig_size: F.file.size, sent_size: blob.size });
    F.status = r.status;
    if (r.status === "failed") throw Object.assign(new Error(r.error), { keep: true });
    await refresh();
    watch();
  } catch (e) {
    if (id && !e.keep && F.status === "uploading") await sb.from("evaluations").delete().eq("id", id);
    if (!e.keep && F.status === "uploading") F.evalId = null;
    F.phase = "failed"; F.error = e.message; await refresh();
  }
}

function watch() {
  clearTimeout(F.poll);
  const id = F.evalId;
  F.poll = setTimeout(async () => {
    if (!F || F.evalId !== id) return;
    const { data } = await sb.from("evaluations").select("status, error").eq("id", id).maybeSingle();
    if (!data) return watch();
    F.status = data.status;
    if (data.status === "failed") { F.phase = "failed"; F.error = data.error ?? "처리 중 문제가 생겼어요"; }
    else if (!busy(data.status)) { const evalId = id; reset(F.mode); toast("분석이 끝났어요"); go("eval", evalId); return; }
    if (isHere()) await refresh();
    if (F.phase === "wait") watch();
  }, 3000);
}
const isHere = () => ["practice", "upload"].includes(location.hash.replace(/^#\/?/, "").split("/")[0]);

async function retry() {
  const r = await fn("process-recording", { evaluation_id: F.evalId, retry: true });
  F.status = r.status; F.phase = r.status === "failed" ? "failed" : "wait"; F.error = r.error;
  await refresh();
  if (F.phase === "wait") watch();
}

const actions = {
  emp: (id) => { F.emp = id; return refresh(); },
  prod: (id) => { F.prod = id; return refresh(); },
  next: () => { F.step++; return refresh(); },
  step: (n) => { F.step = +n; return refresh(); },
  again: () => { const m = F.mode, { emp, prod } = F; reset(m); F.emp = emp; F.prod = prod; F.step = 3; return refresh(); },
  send: () => send(),
  retry: () => retry(),
};
const change = (ev) => { if (ev.target.id === "file-in") pickFile(ev.target.files[0]); };

page("practice", { title: "연습하기", roles: ["employee"], render: () => view("practice"), actions, change });
page("upload", { title: "대리 업로드", roles: ["manager", "admin"], render: () => view("proxy"), actions, change });

// 사원 연습 기록의 ‘다시 연습’에서 행사를 미리 골라 들어올 때
export function startPractice(productId) {
  reset("practice"); F.prod = productId; F.step = 3; go("practice");
}
export { STATUS };
