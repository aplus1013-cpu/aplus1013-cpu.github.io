// 엑셀로 여러 계정 한 번에 등록 (사원: 매니저·관리자 / 매니저: 관리자)
import { fn } from "../api.js";
import { refresh, S } from "../core.js";
import { esc, toast } from "../ui.js";

const XLSX = () => import("../../vendor/xlsx.mjs");
const fresh = () => ({ file: null, rows: null, error: null, results: null, copied: "" });
const ST = { employee: fresh(), manager: fresh() };

const COLS = {
  employee: (admin) => [["이름", "필수", "한소영"], ["사번", "필수 · 숫자 6~10자리", "20240912"], ...(admin ? [["매장", "필수 · 등록된 매장 이름", "홍대점"], ["담당 매니저 이메일", "비우면 그 매장 매니저로 지정", ""]] : []), ["초기 비밀번호", "비우면 자동 생성 · 8자 이상", ""]],
  manager: () => [["이름", "필수", "한지우"], ["이메일", "필수 · 로그인 아이디", "manager@company.com"], ["매장", "필수 · 없으면 새로 만듦", "홍대점"], ["초기 비밀번호", "비우면 자동 생성 · 8자 이상", ""]],
};
const KEY = { 이름: "name", 사번: "emp_no", 매장: "store", 이메일: "email", "담당 매니저 이메일": "manager_email", "초기 비밀번호": "password" };

export function bulkPanel(role) {
  const B = ST[role];
  const admin = S.me.role === "admin";
  const cols = COLS[role](admin);
  const label = role === "employee" ? "사원" : "매니저";
  let out = `<div class="panel"><h3>엑셀로 ${label} 여러 명 등록</h3>
    <div class="hint" style="margin:-6px 0 8px">${role === "employee" ? (admin ? "여러 매장의 사원을 한 번에 등록합니다. 처음 앱을 시작할 때 전체 명단을 이렇게 올리세요." : `${esc(S.me.store_name)} 사원으로 등록되고 담당 매니저는 본인으로 지정돼요.`) : "매니저 계정을 한 번에 만듭니다. 매니저는 받은 초기 비밀번호로 로그인한 뒤 새 비밀번호로 바꿔요."}</div>
    <div class="tbl"><table><thead><tr><th>열 제목</th><th>입력 규칙</th><th>예시</th></tr></thead><tbody>
      ${cols.map((c) => `<tr><td><b>${c[0]}</b></td><td class="hint">${c[1]}</td><td class="num">${esc(c[2]) || '<span class="hint">(비움)</span>'}</td></tr>`).join("")}</tbody></table></div>
    <div class="btns" style="margin-top:10px"><button class="btn ghost" data-act="tpl:${role}">엑셀 양식 받기</button>
      <label class="btn" for="bulk-in-${role}">엑셀 파일 올리기</label><input id="bulk-in-${role}" data-bulk="${role}" type="file" accept=".xlsx,.xls,.csv" hidden></div>`;
  if (B.error) out += `<div class="banner bad" style="margin-top:10px">${esc(B.error)}</div>`;
  if (B.rows && !B.results) {
    const ok = B.rows.filter((r) => !r.err.length), bad = B.rows.filter((r) => r.err.length);
    out += `<div style="margin-top:12px"><div class="meta"><span>${esc(B.file)}</span><span>${B.rows.length}행</span></div>
      <div class="chips" style="margin:8px 0"><span class="pill p-good">등록 가능 ${ok.length}명</span>${bad.length ? `<span class="pill p-bad">확인 필요 ${bad.length}행</span>` : ""}</div>
      ${bad.map((r) => `<div class="banner warn" style="padding:8px 12px;font-size:13.5px;margin-top:6px"><span class="num">${r.row}행</span><span><b>${esc(r.name || "(이름 없음)")}</b> ${esc(r.emp_no ?? r.email ?? "")} · ${r.err.map(esc).join(", ")}</span></div>`).join("")}
      <div class="btns" style="margin-top:10px"><button class="btn ghost" data-act="bulkreset:${role}">취소</button><button class="btn" data-act="bulkgo:${role}" ${ok.length ? "" : "disabled"}>${bad.length ? `오류 ${bad.length}행 빼고 ` : ""}${ok.length}명 등록</button></div></div>`;
  }
  if (B.results) out += resultTable(B.results, role);
  return out + "</div>";
}

export function resultTable(results, role) {
  const B = ST[role];
  const ok = results.filter((r) => r.ok), bad = results.filter((r) => !r.ok);
  return `<div style="margin-top:12px">
    ${ok.length ? `<div class="banner good">${ok.length}명을 등록했어요. 초기 비밀번호를 각자에게 전달해 주세요. 첫 로그인 때 새 비밀번호로 바꾸게 돼요.</div>
      <div class="tbl" style="margin-top:8px"><table><thead><tr><th>이름</th><th>${role === "employee" ? "사번" : "이메일"}</th><th>초기 비밀번호</th></tr></thead><tbody>
      ${ok.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td class="num">${esc(r.emp_no ?? r.email)}</td><td class="num">${esc(r.password)}</td></tr>`).join("")}</tbody></table></div>
      <div class="btns" style="margin-top:8px"><button class="btn ghost" data-act="copyres:${role}">표 복사</button><button class="btn ghost" data-act="dlres:${role}">결과 엑셀 받기</button></div>
      ${B.copied ? `<div class="hint">${esc(B.copied)}</div>` : ""}
      <div class="hint" style="margin-top:6px">보안을 위해 이 화면을 벗어나면 초기 비밀번호를 다시 볼 수 없어요. 잊은 사람은 ‘비밀번호 초기화’로 새로 발급하세요.</div>` : ""}
    ${bad.map((r) => `<div class="banner bad" style="padding:8px 12px;font-size:13.5px;margin-top:6px"><span class="num">${r.row}행</span><span><b>${esc(r.name || "(이름 없음)")}</b> · ${esc(r.error)}</span></div>`).join("")}
    <button class="btn ghost block" style="margin-top:8px" data-act="bulkreset:${role}">다른 명단 올리기</button></div>`;
}

function validate(rows, role) {
  const seen = {};
  return rows.map((r) => {
    const err = [];
    if (!r.name) err.push("이름이 비어 있어요");
    if (role === "employee") {
      if (!/^\d{6,10}$/.test(r.emp_no ?? "")) err.push("사번은 숫자 6~10자리여야 해요");
      else if (seen[r.emp_no]) err.push(`${seen[r.emp_no]}행과 사번이 겹쳐요`); else seen[r.emp_no] = r.row;
      if (S.me.role === "admin") {
        if (!r.store) err.push("매장이 비어 있어요");
        else if (!S.stores.some((s) => s.name === r.store)) err.push(`‘${r.store}’은 등록된 매장이 아니에요`);
      }
    } else {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email ?? "")) err.push("이메일 형식이 올바르지 않아요");
      else if (seen[r.email]) err.push(`${seen[r.email]}행과 이메일이 겹쳐요`); else seen[r.email] = r.row;
      if (role === "manager" && !r.store) err.push("매장이 비어 있어요");
    }
    if (r.password && r.password.length < 8) err.push("초기 비밀번호는 8자 이상이어야 해요");
    return { ...r, err };
  });
}

async function readFile(file, role) {
  const X = await XLSX();
  const buf = new Uint8Array(await file.arrayBuffer());
  let wb;
  if (/\.csv$/i.test(file.name)) {
    let txt; try { txt = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { txt = new TextDecoder("euc-kr").decode(buf); }
    wb = X.read(txt.replace(/^﻿/, ""), { type: "string" });
  } else wb = X.read(buf, { type: "array" });
  const aoa = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false });
  const h = aoa.findIndex((r) => r.some((c) => String(c).trim() === "이름"));
  if (h < 0) throw new Error("첫 줄에서 ‘이름’ 제목을 찾지 못했어요. 양식의 제목 줄을 그대로 두고 아래에 입력해 주세요");
  const head = aoa[h].map((c) => KEY[String(c).trim()] ?? null);
  const rows = aoa.slice(h + 1).map((r, i) => ({ r, i })).filter(({ r }) => r.some((c) => String(c).trim()))
    .map(({ r, i }) => { const o = { row: h + i + 2 }; head.forEach((k, j) => { if (k) o[k] = String(r[j] ?? "").trim(); }); if (o.email) o.email = o.email.toLowerCase(); return o; });
  if (!rows.length) throw new Error("제목 줄 아래에 입력된 내용이 없어요");
  if (rows.length > 500) throw new Error("한 번에 500명까지 올릴 수 있어요. 나눠서 올려 주세요");
  return validate(rows, role);
}

export async function download(name, aoa) {
  const X = await XLSX();
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa), "명단");
  X.writeFile(wb, name);
}

export const bulkActions = {
  tpl: (role) => download(role === "employee" ? "사원등록_양식.xlsx" : "매니저등록_양식.xlsx",
    [COLS[role](S.me.role === "admin").map((c) => c[0]), COLS[role](S.me.role === "admin").map((c) => c[2])]),
  bulkreset: (role) => { ST[role] = fresh(); return refresh(); },
  bulkgo: async (role) => {
    const B = ST[role];
    const ok = B.rows.filter((r) => !r.err.length).map(({ err, ...r }) => r);
    const { results } = await fn("staff-admin", { action: "create_users", role, rows: ok });
    B.results = [...results, ...B.rows.filter((r) => r.err.length).map((r) => ({ row: r.row, name: r.name, ok: false, error: r.err.join(", ") }))].sort((a, b) => a.row - b.row);
    if (role === "manager") { const { loadRefs } = await import("../core.js"); await loadRefs(); }
    await refresh();
  },
  copyres: async (role) => {
    const B = ST[role];
    const t = ["이름\t아이디\t초기 비밀번호", ...B.results.filter((r) => r.ok).map((r) => `${r.name}\t${r.emp_no ?? r.email}\t${r.password}`)].join("\n");
    try { await navigator.clipboard.writeText(t); B.copied = "복사했어요. 메신저나 엑셀에 붙여 넣으세요."; } catch { B.copied = "복사가 막혀 있어요. 표를 길게 눌러 직접 선택해 주세요."; }
    await refresh();
  },
  dlres: (role) => download("초기비밀번호.xlsx", [["이름", "아이디", "초기 비밀번호"], ...ST[role].results.filter((r) => r.ok).map((r) => [r.name, r.emp_no ?? r.email, r.password])]),
};

export async function bulkChange(ev) {
  const role = ev.target.dataset.bulk;
  if (!role) return;
  const f = ev.target.files[0];
  if (!f) return;
  const B = ST[role];
  B.error = null; B.results = null; B.file = f.name;
  try { B.rows = await readFile(f, role); } catch (e) { B.rows = null; B.error = e.message; }
  ev.target.value = "";
  await refresh();
}
export { toast };
