// 노트북 일괄 평가: 녹음 폴더를 고르면 파일 이름으로 사원·행사 품목을 알아보고, 한꺼번에 올려 AI 평가
import { fn, must, sb } from "../api.js";
import { MAX_UPLOAD } from "../config.js";
import { go, page, refresh, route, S, storeName } from "../core.js";
import { kindOf, prepareAudio } from "../media.js";
import { busy, esc, fmtBytes, ic, num1, statusPill, toast } from "../ui.js";
import { download } from "./people-bulk.js";

const DONE = ["reviewing", "completed", "submitted", "practice"];
const B = { rows: [], emps: [], defProd: "", running: false, names: null, addStore: "", addRes: null, poll: null };

// 맥에서 받은 파일 이름은 한글 자모가 풀려 있을 수 있어 NFC로 맞춤
const norm = (s) => String(s ?? "").normalize("NFC").toLowerCase().replace(/[\s_\-.,()[\]{}~+]+/g, "");
const here = () => route().name === "batch";

// 파일 경로 안에 이름이 들어 있는 후보 중 가장 긴 이름. 같은 길이가 여럿이면 폴더의 매장 이름으로 한 번 더 좁힘
function match(hay, list) {
  const hits = list.filter((x) => { const n = norm(x.name); return n && hay.includes(n); });
  if (!hits.length) return { id: "", how: "none" };
  const max = Math.max(...hits.map((x) => norm(x.name).length));
  let top = hits.filter((x) => norm(x.name).length === max);
  if (top.length > 1) {
    const byStore = top.filter((x) => x.store_id && hay.includes(norm(storeName(x.store_id))));
    if (byStore.length === 1) top = byStore;
  }
  return top.length === 1 ? { id: top[0].id, how: "auto" } : { id: "", how: "ambiguous" };
}

const STOP = new Set(["연습", "녹음", "통화", "대화", "판매", "상담", "음성", "메모", "파일", "영상", "동영상", "최종", "수정", "고객", "매장", "새로운", "녹음파일"]);
// 명단에 없는 사원의 이름 후보: 파일 이름의 한글 2~4글자 덩어리 중 행사·매장 이름이 아닌 첫 번째
function guessName(r) {
  let s = r.file.name.normalize("NFC").replace(/\.[^.]+$/, "");
  for (const p of S.products) s = s.split(p.name.normalize("NFC")).join(" ");
  for (const st of S.stores) s = s.split(st.name.normalize("NFC")).join(" ");
  return (s.match(/[가-힣]{2,4}/g) ?? []).find((w) => ![...STOP].some((x) => w.includes(x))) ?? null;
}

function rematch(r) {
  const hay = norm(r.rel);
  if (r.empHow !== "manual") { const m = match(hay, B.emps); r.emp = m.id; r.empHow = m.how; }
  if (r.prodHow !== "manual") {
    const m = match(hay, S.products);
    if (m.id) { r.prod = m.id; r.prodHow = "auto"; } else { r.prod = B.defProd; r.prodHow = B.defProd ? "default" : m.how; }
  }
  if (!r.touched && r.st === "ready") r.sel = !!(r.emp && r.prod && !r.dup);
}

async function loadEmps() {
  B.emps = must(await sb.from("profiles").select("id, name, emp_no, store_id").eq("role", "employee").eq("active", true).order("name"));
}

async function addFiles(files) {
  const have = new Set(B.rows.map((r) => r.rel + "|" + r.file.size));
  const fresh = [];
  let skipped = 0;
  for (const f of files) {
    if (f.name.startsWith(".")) continue;
    if (kindOf(f) === "unknown") { skipped++; continue; }
    const rel = (f.relPath || f.webkitRelativePath || f.name).normalize("NFC");
    if (have.has(rel + "|" + f.size)) continue;
    have.add(rel + "|" + f.size);
    fresh.push({ i: B.rows.length + fresh.length, file: f, rel, st: "ready", sel: false, touched: false, dup: false, emp: "", empHow: "none", prod: "", prodHow: "none", pct: 0, stage: "", id: null, err: null });
  }
  if (!fresh.length) { toast(skipped ? "녹음·동영상 파일이 없어요" : "이미 목록에 있는 파일이에요", !!skipped); return; }
  if (!B.emps.length) await loadEmps();
  // 전에 올린 적 있는 파일(같은 이름·크기)은 표시만 하고 기본으로 빼 둠
  const names = [...new Set(fresh.map((r) => r.file.name))];
  const prev = [];
  for (let k = 0; k < names.length; k += 100) {
    prev.push(...must(await sb.from("evaluations").select("orig_name, orig_size").in("orig_name", names.slice(k, k + 100))));
  }
  for (const r of fresh) {
    r.dup = prev.some((p) => p.orig_name === r.file.name && Number(p.orig_size) === r.file.size);
    rematch(r);
  }
  B.rows.push(...fresh);
  B.names = null; B.addRes = null;
  toast(`파일 ${fresh.length}개를 불러왔어요${skipped ? ` (녹음이 아닌 파일 ${skipped}개는 뺐어요)` : ""}`);
  await refresh();
}

// 끌어다 놓은 폴더 안의 파일을 모두 꺼냄
async function filesFromDrop(dt) {
  const out = [];
  const walk = async (entry, path) => {
    if (entry.isFile) {
      const f = await new Promise((ok, no) => entry.file(ok, no));
      f.relPath = path + f.name; out.push(f);
    } else if (entry.isDirectory) {
      const rd = entry.createReader();
      for (;;) {
        const batch = await new Promise((ok, no) => rd.readEntries(ok, no));
        if (!batch.length) break;
        for (const e of batch) await walk(e, path + entry.name + "/");
      }
    }
  };
  const entries = [...dt.items].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  for (const e of entries) await walk(e, "");
  return out;
}

// ---- 화면 ----
const empLabel = (e) => `${e.name}${e.emp_no ? ` (${e.emp_no})` : ""}${e.store_id ? ` · ${storeName(e.store_id)}` : ""}`;
const HOW = { auto: "", default: '<span class="hint">기본 행사</span>', ambiguous: '<span class="pill p-warn">동명이인·후보 여럿</span>', none: '<span class="pill p-warn">못 찾음</span>', manual: "" };

function statusCell(r) {
  if (r.st === "ready") {
    if (r.dup) return '<span class="pill p-mute">전에 올린 파일</span><div class="hint">다시 평가하려면 체크하세요</div>';
    return !r.emp || !r.prod ? '<span class="pill p-warn">확인 필요</span>' : '<span class="pill p-mute">대기</span>';
  }
  if (r.st === "prep") return `<span class="pill p-info" id="bst-${r.i}">${r.pct ? `압축 ${r.pct}%` : "준비 중"}</span>`;
  if (r.st === "failed") {
    return `${statusPill("failed")}<div class="hint" style="max-width:220px">${esc(r.err)}</div>
      ${r.id ? `<button class="btn ghost sm" data-act="retry:${r.i}">다시 시도</button>` : ""}`;
  }
  if (DONE.includes(r.st)) {
    return `<div><b class="num">${num1(r.score)}</b><span class="hint">점</span>${r.comp != null ? ` · 준수 <b class="num">${r.comp}%</b>` : ""}</div>
      <button class="btn ghost sm" data-act="open:${r.id}">결과 보기·평가</button>`;
  }
  return statusPill(r.st);
}

function rowHtml(r) {
  const locked = r.st !== "ready" && !(r.st === "failed" && !r.id);
  const empOpts = `<option value="">— 사원 선택 —</option>${B.emps.map((e) => `<option value="${e.id}" ${r.emp === e.id ? "selected" : ""}>${esc(empLabel(e))}</option>`).join("")}`;
  const prodOpts = `<option value="">— 행사 선택 —</option>${S.products.map((p) => `<option value="${p.id}" ${r.prod === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}`;
  return `<tr data-row="${r.i}">
    <td><input type="checkbox" data-row="${r.i}" data-f="sel" ${r.sel ? "checked" : ""} ${locked ? "disabled" : ""} aria-label="선택"></td>
    <td><div class="fname">${ic(kindOf(r.file) === "video" ? "file" : "file", 14)} ${esc(r.file.name)}</div>${r.rel !== r.file.name ? `<div class="hint">${esc(r.rel.slice(0, -r.file.name.length))}</div>` : ""}<div class="hint">${fmtBytes(r.file.size)}${kindOf(r.file) === "video" ? " · 동영상" : ""}</div></td>
    <td><select data-row="${r.i}" data-f="emp" ${locked ? "disabled" : ""}>${empOpts}</select>${HOW[r.empHow]}</td>
    <td><select data-row="${r.i}" data-f="prod" ${locked ? "disabled" : ""}>${prodOpts}</select>${HOW[r.prodHow]}</td>
    <td>${statusCell(r)}</td></tr>`;
}

function addPanel() {
  const missing = B.rows.filter((r) => r.st === "ready" && !r.emp && !r.dup);
  if (!missing.length && !B.addRes) return "";
  if (!missing.length) return `<div class="banner ${B.addRes.bad.length ? "warn" : "good"}">${B.addRes.ok}명 등록했어요. 모든 파일에 사원이 연결됐어요.${B.addRes.bad.map((x) => `<br>${esc(x.name)}: ${esc(x.error)}`).join("")}</div>`;
  if (B.names == null) B.names = [...new Set(missing.map(guessName).filter(Boolean))].join("\n");
  return `<div class="panel"><h3>명단에 없는 사원 추가</h3>
    <div class="hint">사원 선택이 비어 있는 파일이 ${missing.length}개 있어요. 파일 이름에서 찾은 이름을 넣어 두었어요. 고치고 등록하면 자동으로 다시 연결해요. 로그인 계정(사번)은 나중에 만들 수 있어요.</div>
    <div class="grid-names">
      <div class="field"><span>이름(한 줄에 한 명)</span><textarea id="batch-names" rows="4">${esc(B.names)}</textarea></div>
      <div class="field"><span>매장(선택)</span><select id="batch-store"><option value="">매장 없음</option>${S.stores.map((s) => `<option value="${esc(s.name)}" ${B.addStore === s.name ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div>
    </div>
    ${B.addRes ? `<div class="banner ${B.addRes.bad.length ? "warn" : "good"}">${B.addRes.ok}명 등록했어요.${B.addRes.bad.map((x) => `<br>${esc(x.name)}: ${esc(x.error)}`).join("")}</div>` : ""}
    <div class="btns"><button class="btn ghost" data-act="addnames">이름으로 등록하고 다시 연결</button></div></div>`;
}

async function view() {
  if (!B.emps.length) await loadEmps();
  const R = B.rows;
  const ready = R.filter((r) => r.st === "ready" || (r.st === "failed" && !r.id));
  const sel = ready.filter((r) => r.sel && r.emp && r.prod).length;
  const need = R.filter((r) => r.st === "ready" && (!r.emp || !r.prod)).length;
  const running = R.filter((r) => r.st === "prep" || busy(r.st)).length;
  const done = R.filter((r) => DONE.includes(r.st)).length;
  const failed = R.filter((r) => r.st === "failed").length;
  const noProducts = !S.products.length;
  return `<div class="stack">
    <div class="panel"><h3>1. 녹음 폴더 고르기</h3>
      <div class="hint">파일 이름이나 폴더 이름에 <b>사원 이름</b>과 <b>행사 품목 이름</b>이 들어 있으면 자동으로 알아봐요.<br>예) <span class="num">홍길동_갤럭시S26_0915.m4a</span> · <span class="num">갤럭시S26/홍길동.mp4</span></div>
      <div class="drop" id="batch-drop" style="margin-top:10px">${ic("up", 28)}<div><b>폴더를 여기로 끌어다 놓거나 골라 주세요</b><div class="hint">m4a · mp3 · wav · mp4 · mov 등. 큰 파일과 동영상은 이 노트북에서 음성만 압축해 보냅니다. 원본은 그대로 남아요.</div></div>
        <div class="btns"><label class="btn" for="batch-dir">폴더 선택</label><label class="btn ghost" for="batch-files">파일 여러 개 선택</label></div>
        <input id="batch-dir" type="file" webkitdirectory directory multiple hidden><input id="batch-files" type="file" multiple accept="audio/*,video/*,.m4a,.mp3,.wav,.aac,.mp4,.mov" hidden></div>
      ${noProducts ? '<div class="banner warn">먼저 ‘행사·교육자료’에서 행사 품목을 등록해 주세요.</div>' : ""}
    </div>
    ${R.length ? `<div class="panel"><h3>2. 확인하고 평가 시작</h3>
      <div class="tiles"><div class="tile"><div class="k">파일</div><div class="v">${R.length}</div></div>
        <div class="tile"><div class="k">확인 필요</div><div class="v" style="${need ? "color:var(--warn)" : ""}">${need}</div></div>
        <div class="tile"><div class="k">진행 중</div><div class="v">${running}</div></div>
        <div class="tile"><div class="k">완료</div><div class="v" style="color:var(--good)">${done}</div></div></div>
      <div class="field" style="margin-top:12px"><span>파일 이름에 행사가 없을 때 쓸 행사 품목</span><select id="batch-defprod"><option value="">— 고르지 않음 —</option>${S.products.map((p) => `<option value="${p.id}" ${B.defProd === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
      <div class="tbl batch-tbl" style="margin-top:12px"><table><thead><tr><th><input type="checkbox" data-f="all" aria-label="모두 선택" ${sel && sel === ready.filter((r) => r.emp && r.prod).length ? "checked" : ""}></th><th>파일</th><th>사원</th><th>행사 품목</th><th>상태·결과</th></tr></thead>
        <tbody>${R.map(rowHtml).join("")}</tbody></table></div>
      <div class="btns" style="margin-top:12px">
        <button class="btn" data-act="start" ${sel && !B.running ? "" : "disabled"}>${B.running ? `<span class="spin"></span> 차례대로 올리는 중` : `선택한 ${sel}개 평가 시작`}</button>
        ${done ? '<button class="btn ghost" data-act="export">결과 엑셀로 받기</button>' : ""}
        ${failed ? `<span class="hint">실패 ${failed}개</span>` : ""}
        <button class="btn ghost" data-act="clear" ${B.running || running ? "disabled" : ""}>목록 비우기</button></div>
      <div class="note">평가를 시작하면 파일을 하나씩 압축해 올리고, 텍스트 변환과 AI 분석은 서버에서 동시에 진행돼요. 끝난 대화는 ‘결과 보기·평가’에서 매니저 점수와 코멘트를 더할 수 있어요. 올리는 동안에는 이 탭을 닫지 말아 주세요.</div>
    </div>` : ""}
    ${addPanel()}
  </div>`;
}

function paintRow(r) {
  const el = document.getElementById(`bst-${r.i}`);
  if (el) el.textContent = r.pct ? `압축 ${r.pct}%` : r.stage || "준비 중";
}
const paint = () => (here() ? refresh() : null);

// ---- 처리 ----
async function runOne(r) {
  r.err = null; r.st = "prep"; r.pct = 0; r.stage = "";
  await paint();
  let id = null;
  try {
    const prep = await prepareAudio(r.file, {
      onStage: (s) => { r.stage = s; paintRow(r); },
      onProgress: (p) => { r.pct = p; paintRow(r); },
    });
    if (prep.blob.size > MAX_UPLOAD) throw new Error("압축해도 50MB가 넘어요. 녹음을 나눠 주세요");
    r.st = "uploading"; await paint();
    const row = must(await sb.from("evaluations").insert({ employee_id: r.emp, product_id: r.prod, kind: "proxy", uploaded_by: S.me.id }).select("id").single());
    id = r.id = row.id;
    const path = `${id}.${prep.ext}`;
    const up = await sb.storage.from("recordings").upload(path, prep.blob, { contentType: prep.mime, upsert: false });
    if (up.error) throw new Error(up.error.message?.includes("size") ? "파일이 너무 커요(최대 50MB)" : "파일을 올리지 못했어요. 인터넷 연결을 확인해 주세요");
    const res = await fn("process-recording", { evaluation_id: id, audio_path: path, orig_name: r.file.name, orig_size: r.file.size, sent_size: prep.blob.size });
    r.st = res.status;
    if (res.status === "failed") r.err = res.error ?? "처리 중 문제가 생겼어요";
  } catch (e) {
    if (id && r.st === "uploading") { await sb.from("evaluations").delete().eq("id", id); r.id = null; }
    r.st = "failed"; r.err = e.message ?? String(e);
  }
  r.sel = false;
  watch();
  await paint();
}

async function start() {
  if (B.running) return;
  const todo = B.rows.filter((r) => r.sel && r.emp && r.prod && (r.st === "ready" || (r.st === "failed" && !r.id)));
  if (!todo.length) { toast("평가할 파일을 골라 주세요", true); return; }
  B.running = true;
  try { for (const r of todo) await runOne(r); } finally { B.running = false; }
  await paint();
  toast(`${todo.length}개를 모두 올렸어요. 분석이 끝나면 점수가 표시돼요`);
}

// 서버에서 진행 중인 건들의 상태를 한꺼번에 확인
function watch() {
  if (B.poll) return;
  B.poll = setTimeout(async () => {
    B.poll = null;
    const live = B.rows.filter((r) => r.id && busy(r.st));
    if (!live.length) return;
    try {
      const rows = must(await sb.from("evaluations").select("id, status, error, ai_total, compliance_rate").in("id", live.map((r) => r.id)));
      let changed = false;
      for (const d of rows) {
        const r = live.find((x) => x.id === d.id);
        if (r.st !== d.status) { changed = true; r.st = d.status; r.err = d.error; r.score = d.ai_total; r.comp = d.compliance_rate; }
      }
      if (changed) await paint();
    } catch { /* 잠깐 끊겨도 다음 확인에서 이어서 */ }
    watch();
  }, 4000);
}

async function retry(i) {
  const r = B.rows[+i];
  const res = await fn("process-recording", { evaluation_id: r.id, retry: true });
  r.st = res.status; r.err = res.error ?? null;
  watch(); await paint();
}

async function addNames() {
  const names = [...new Set((document.getElementById("batch-names")?.value ?? B.names ?? "").split("\n").map((x) => x.trim()).filter(Boolean))];
  if (!names.length) { toast("등록할 이름을 적어 주세요", true); return; }
  const store = document.getElementById("batch-store")?.value ?? "";
  const { results } = await fn("staff-admin", { action: "create_users", role: "employee", name_only: true, rows: names.map((name, k) => ({ row: k + 1, name, store })) });
  B.addRes = { ok: results.filter((x) => x.ok).length, bad: results.filter((x) => !x.ok) };
  await loadEmps();
  for (const r of B.rows) if (r.st === "ready") rematch(r);
  B.names = null;
  await refresh();
}

async function exportResults() {
  const ids = B.rows.filter((r) => r.id && DONE.includes(r.st)).map((r) => r.id);
  const ev = [];
  for (let k = 0; k < ids.length; k += 100) ev.push(...must(await sb.from("evaluations").select("id, ai_total, compliance_rate, ai, status").in("id", ids.slice(k, k + 100))));
  const empName = (id) => B.emps.find((e) => e.id === id)?.name ?? "";
  const prodName = (id) => S.products.find((p) => p.id === id)?.name ?? "";
  const aoa = [["파일", "사원", "행사 품목", "AI 점수", "교육 준수율(%)", "총평", "연습 과제"]];
  for (const r of B.rows.filter((x) => x.id && DONE.includes(x.st))) {
    const d = ev.find((x) => x.id === r.id);
    aoa.push([r.rel, empName(r.emp), prodName(r.prod), d?.ai_total ?? "", d?.compliance_rate ?? "", d?.ai?.summary ?? "", (d?.ai?.tasks ?? []).join(" / ")]);
  }
  const t = new Date();
  await download(`일괄평가_${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, "0")}${String(t.getDate()).padStart(2, "0")}.xlsx`, aoa);
}

page("batch", {
  title: "일괄 평가",
  roles: ["admin", "manager"],
  render: view,
  mounted: () => {
    const d = document.getElementById("batch-drop");
    if (!d) return;
    d.addEventListener("dragover", (e) => { e.preventDefault(); d.classList.add("over"); });
    d.addEventListener("dragleave", () => d.classList.remove("over"));
    d.addEventListener("drop", async (e) => {
      e.preventDefault(); d.classList.remove("over");
      try { await addFiles(await filesFromDrop(e.dataTransfer)); } catch (err) { toast(err.message, true); }
    });
  },
  actions: {
    start: () => start(),
    retry: (i) => retry(i),
    open: (id) => go("eval", id),
    addnames: () => addNames(),
    export: () => exportResults(),
    clear: () => { B.rows = []; B.names = null; B.addRes = null; return refresh(); },
  },
  input: (ev) => { if (ev.target.id === "batch-names") B.names = ev.target.value; },
  change: async (ev) => {
    const t = ev.target;
    if (t.id === "batch-dir" || t.id === "batch-files") {
      const files = [...t.files]; t.value = "";
      try { await addFiles(files); } catch (e) { toast(e.message, true); }
      return;
    }
    if (t.id === "batch-store") { B.addStore = t.value; return; }
    if (t.id === "batch-defprod") {
      B.defProd = t.value;
      for (const r of B.rows) if (r.st === "ready" || (r.st === "failed" && !r.id)) rematch(r);
      return refresh();
    }
    if (t.dataset.f === "all") {
      for (const r of B.rows) if ((r.st === "ready" || (r.st === "failed" && !r.id)) && r.emp && r.prod) { r.sel = t.checked; r.touched = true; }
      return refresh();
    }
    const r = B.rows[+t.dataset.row];
    if (!r) return;
    if (t.dataset.f === "sel") { r.sel = t.checked; r.touched = true; }
    else if (t.dataset.f === "emp") { r.emp = t.value; r.empHow = "manual"; if (!r.touched) r.sel = !!(r.emp && r.prod); }
    else if (t.dataset.f === "prod") { r.prod = t.value; r.prodHow = "manual"; if (!r.touched) r.sel = !!(r.emp && r.prod); }
    return refresh();
  },
});
