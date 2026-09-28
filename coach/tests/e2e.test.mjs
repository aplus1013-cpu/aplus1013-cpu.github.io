// 앱 전체 흐름 테스트: node coach/tests/e2e.test.mjs
// 흉내 서버(PGlite) + 실제 Edge Function 코드(Deno) + 실제 앱 화면(Chromium)
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANON_KEY, SERVICE_KEY, startEmulator } from "./emulator.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCRATCH = process.env.SCRATCH ?? join(here, ".tmp");
mkdirSync(SCRATCH, { recursive: true });
const DENO = process.env.DENO ?? "deno";
const PW = process.env.PLAYWRIGHT ?? "playwright";
const { chromium } = await import(PW);
const XLSX = await import("xlsx");
const ONLY = process.env.ONLY;
const SHOTS = process.env.SHOTS;

// ---- 준비: 테스트 파일 ----
function wav(seconds, rate = 16000) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 440) * 8000 * (0.5 + 0.5 * Math.sin(i / rate * 3))), 44 + i * 2);
  return buf;
}
const smallWav = join(SCRATCH, "대화녹음_짧은.wav"); writeFileSync(smallWav, wav(3));
const bigWav = join(SCRATCH, "매장녹음_긴.wav"); writeFileSync(bigWav, wav(420));
const matTxt = join(SCRATCH, "10월 행사 콜멘트.txt");
writeFileSync(matTxt, "하이드라 수분크림 1+1 행사 콜멘트\n- 오프닝: 이번 주까지 수분크림 1+1 행사 중이에요\n- 72시간 보습 임상 결과를 꼭 안내\n- 클로징: 오늘 구매하시면 샘플 키트도 함께 드려요\n- 금지: 여드름이 낫는다 등 의약품 효능 표현");
const xlsxPath = join(SCRATCH, "사원명단.xlsx");
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["이름", "사번", "매장", "담당 매니저 이메일", "초기 비밀번호"],
    ["박서준", "20231042", "강남점", "", ""], ["김민지", "20220815", "강남점", "", "Minji2024!"], ["이하은", "20240301", "홍대점", "", ""],
    ["", "20240918", "강남점", "", ""], ["신예린", "2024A19", "강남점", "", ""], ["안재현", "20240920", "부산점", "", ""], ["고은비", "20231042", "강남점", "", ""], ["김선우", "20240921", "강남점", "", "1234"]]), "명단");
  XLSX.writeFile(wb, xlsxPath);
}

// ---- 서버 시작 ----
const logs = [];
const emu = await startEmulator({ ffmpegDir: process.env.FFMPEG_CORE_DIR, log: (m) => logs.push(m) });
const fnPort = 54300 + Math.floor(Math.random() * 90);
emu.state.fnPort = fnPort;
const deno = spawn(DENO, ["run", "-A", "--quiet", join(here, "fn-runner.ts"), String(fnPort)], {
  env: { ...process.env, SUPABASE_URL: emu.url, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, ANTHROPIC_API_KEY: "test-anthropic", ANTHROPIC_BASE_URL: `${emu.url}/anthropic`, CLOVA_INVOKE_URL: `${emu.url}/clova`, CLOVA_SECRET_KEY: "test-clova" },
});
let denoOut = "";
deno.stdout.on("data", (d) => { denoOut += d; }); deno.stderr.on("data", (d) => { denoOut += d; });
for (let i = 0; i < 120 && !denoOut.includes("fn-runner ready"); i++) await new Promise((r) => setTimeout(r, 500));
if (!denoOut.includes("fn-runner ready")) { console.log("Deno 함수 실행 실패:\n" + denoOut); process.exit(1); }
await emu.db.query(`update app_settings set value='TESTCODE' where key='setup_code'`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const results = [];
const pageErrors = [];
const openPages = [];
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, acceptDownloads: true });
  await ctx.addInitScript(([url, key, core]) => { window.COACH_CONFIG = { url, key, ffmpegCore: core }; }, [emu.url, ANON_KEY, `${emu.url}/ffmpeg-core`]);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(`[pageerror] ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_FAILED|fonts/.test(m.text())) pageErrors.push(`[console] ${m.text()}`); });
  p.setDefaultTimeout(15000);
  openPages.push(p);
  return p;
}
async function step(name, fn) {
  if (ONLY && !name.includes(ONLY) && !results.length) { /* 앞 단계는 모두 실행해야 해서 무시하지 않음 */ }
  const t0 = Date.now();
  try { await fn(); results.push(["PASS", name, Date.now() - t0]); }
  catch (e) {
    let dump = "";
    for (const [i, p] of openPages.entries()) { try { dump += `\n    [화면${i + 1}] ${(await p.locator("#app").innerText()).replace(/\s+/g, " ").slice(0, 700)}`; } catch { /* 닫힘 */ } }
    results.push(["FAIL", name, Date.now() - t0, e.message.split("\n").slice(0, 3).join(" | ") + dump + (pageErrors.length ? "\n    [브라우저 오류] " + pageErrors.slice(-5).join(" / ") : "")]); throw e;
  }
}
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: join(SHOTS, name + ".png"), fullPage: true }); };
const text = (p) => p.locator("#app").innerText();
async function see(p, t, timeout = 15000) { await p.getByText(t, { exact: false }).first().waitFor({ state: "visible", timeout }); }
async function login(p, id, pw) {
  // 이미 로그인돼 있으면 메뉴에서 로그아웃
  await p.goto(`${emu.url}/coach/#/menu`);
  if (await p.locator('[data-act="logout"]').count()) { await p.locator('[data-act="logout"]').click(); }
  await p.locator("#login-id").waitFor();
  await p.fill("#login-id", id); await p.fill("#login-pw", pw); await p.click("#login-btn");
}
async function changePw(p, pw) {
  await see(p, "처음 로그인하셨어요");
  await p.fill("#pw-new", pw); await p.fill("#pw-new2", pw); await p.click("#pw-btn");
}
// 경로에 한글이 있으면 이 Playwright 버전은 파일을 조용히 빠뜨려서, 내용을 직접 넘김(파일 이름은 한글 그대로)
const FTYPE = { wav: "audio/wav", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", txt: "text/plain" };
const upload = (p, sel, f) => p.setInputFiles(sel, { name: basename(f), mimeType: FTYPE[f.split(".").pop()] ?? "application/octet-stream", buffer: readFileSync(f) });
const act = (p, a) => p.locator(`[data-act="${a}"]`).first();

const creds = {};
let failed = false;
try {
  const A = await newPage();
  await step("처음 설정: 틀린 코드는 거절", async () => {
    await A.goto(`${emu.url}/coach/#/setup`);
    await A.fill("#setup-code", "WRONG"); await A.fill("#setup-name", "본사 교육팀"); await A.fill("#setup-email", "admin@test.co"); await A.fill("#setup-pw", "Admin1234!");
    await A.click("#setup-btn"); await see(A, "설정 코드가 맞지 않아요");
  });
  await step("처음 설정: 관리자 생성 → 전체 현황", async () => {
    await A.fill("#setup-code", "testcode"); await A.click("#setup-btn");
    await see(A, "매장별 현황"); await shot(A, "01-admin-dash");
  });
  await step("관리자: 매니저 한 명 등록(강남점 생성)", async () => {
    await act(A, "nav:people").click(); await see(A, "매니저·관리자 한 명 등록");
    await A.fill("#st-name", "정유진"); await A.fill("#st-email", "yujin@test.co"); await A.fill("#st-store", "강남점"); await A.click("#st-btn");
    await see(A, "정유진님의 새 초기 비밀번호"); creds.mA = (await A.locator(".banner.good b.num").innerText()).trim();
  });
  await step("관리자: 매니저 한 명 더(홍대점)", async () => {
    await A.fill("#st-name", "한지우"); await A.fill("#st-email", "jiwoo@test.co"); await A.fill("#st-store", "홍대점"); await A.click("#st-btn");
    await see(A, "한지우님의 새 초기 비밀번호"); creds.mB = (await A.locator(".banner.good b.num").innerText()).trim();
  });
  await step("관리자: 엑셀 사원 일괄 등록 — 오류 행 표시", async () => {
    await upload(A, "#bulk-in-employee", xlsxPath);
    await see(A, "등록 가능 3명"); await see(A, "확인 필요 5행");
    for (const t of ["이름이 비어 있어요", "사번은 숫자 6~10자리", "‘부산점’은 등록된 매장이 아니에요", "2행과 사번이 겹쳐요", "8자 이상"]) await see(A, t);
    await shot(A, "02-bulk-check");
  });
  await step("관리자: 오류 행 빼고 3명 등록 → 초기 비밀번호 표", async () => {
    await act(A, "bulkgo:employee").click(); await see(A, "3명을 등록했어요");
    const rows = await A.locator("table").filter({ hasText: "초기 비밀번호" }).last().locator("tbody tr").allInnerTexts();
    for (const r of rows) { const [n, id, pw] = r.split("\t").map((s) => s.trim()); creds[id] = pw; }
    if (creds["20220815"] !== "Minji2024!") throw new Error("지정한 초기 비밀번호가 반영되지 않음: " + JSON.stringify(creds));
    await shot(A, "03-bulk-done");
  });
  await step("관리자: 행사 품목 등록", async () => {
    await act(A, "nav:events").click(); await act(A, "newp").click();
    await A.fill("#pf-name", "하이드라 수분크림 1+1");
    const d = (o) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
    await A.fill("#pf-start", d(-3)); await A.fill("#pf-end", d(20)); await A.click('#prod-form button[type="submit"]');
    await see(A, "저장했어요"); await see(A, "교육자료");
  });
  await step("관리자: 교육자료(txt) 올리기 → AI 체크리스트 뽑기", async () => {
    const input = A.locator('input[data-mat]').first();
    await upload(A, "input[data-mat]", matTxt); await see(A, "10월 행사 콜멘트");
    await A.locator('[data-act^="extract:"]').first().click();
    await see(A, "체크리스트 4개를 뽑았어요", 30000);
    await A.waitForFunction(() => !document.querySelector("#app .spin") && document.querySelectorAll("input[data-cl]").length === 4);
    const req = emu.state.anthropicRequests.at(-1);
    if (req.body.model !== "claude-opus-5") throw new Error("모델 ID가 다름: " + req.body.model);
    if (req.body.fallbacks !== "default" || !String(req.headers["anthropic-beta"]).includes("server-side-fallback-2026-07-01")) throw new Error("fallbacks 설정 누락");
    if (req.body.output_config?.format?.type !== "json_schema" || req.body.thinking?.type !== "adaptive") throw new Error("구조화 출력/thinking 설정 누락");
    if (!JSON.stringify(req.body.messages).includes("72시간 보습")) throw new Error("교육자료 내용이 AI에 전달되지 않음");
  });
  await step("관리자: 체크리스트 수정·추가 저장", async () => {
    const inputs = A.locator("input[data-cl]"); const n0 = await inputs.count();
    await A.locator('[data-act^="addc:"]').first().click();
    await A.waitForFunction((n) => document.querySelectorAll("input[data-cl]").length === n + 1, n0);
    await inputs.nth(n0).fill("사용 순서(세럼 다음 단계) 안내");
    await inputs.nth(0).fill("72시간 보습 지속 임상 결과를 수치로 안내");
    await A.locator('[data-act^="savec:"]').first().click(); await see(A, "체크리스트를 저장했어요");
    const { rows } = await emu.db.query(`select checklist from products`);
    const cl = rows[0].checklist;
    if (cl.length !== n0 + 1 || !cl.some((c) => c.text.includes("사용 순서")) || !cl[0].text.includes("수치로")) throw new Error("체크리스트 저장 결과: " + JSON.stringify(cl));
    await shot(A, "04-events");
  });
  await step("관리자: 평가 항목 화면·저장", async () => {
    await act(A, "nav:criteria").click(); await see(A, "보는 행동");
    const f = A.locator("form.crit-form").first(); await f.locator('input[name="weight"]').fill("1.2"); await f.locator('button[type="submit"]').click();
    await see(A, "저장했어요");
  });
  await step("관리자: 시스템 점검 모두 통과", async () => {
    await A.goto(`${emu.url}/coach/#/selftest`); await see(A, "음성 인식 키(CLOVA)");
    await A.waitForFunction(() => !document.querySelector(".st .wait"), null, { timeout: 20000 });
    const bad = await A.locator(".st .no").count();
    if (bad) throw new Error("점검 실패 항목: " + (await A.locator(".st").filter({ has: A.locator(".no") }).allInnerTexts()).join(" / "));
    await shot(A, "05-selftest");
  });

  const E = await newPage();
  await step("사원: 틀린 비밀번호 안내", async () => {
    await login(E, "20231042", "wrong-pass"); await see(E, "사번(이메일) 또는 비밀번호가 맞지 않아요");
  });
  await step("사원: 사번 로그인 → 첫 비밀번호 변경", async () => {
    await login(E, "20231042", creds["20231042"]); await changePw(E, "Seojun1234!");
    await see(E, "어떤 행사 품목을 판매했나요?"); await shot(E, "06-practice");
  });
  const practice = async (file, timeout = 60000) => {
    await act(E, "nav:practice").click();
    await E.locator('[data-act^="prod:"]').first().click(); await act(E, "next").click();
    await upload(E, "#file-in", file);
    await see(E, "올리고 AI 점검 시작", timeout);
    await act(E, "send").click();
    await see(E, "AI 총평과 연습 과제", 60000);
  };
  await step("사원: 짧은 녹음 올리기 → 음성 인식 → AI 결과", async () => {
    await practice(smallWav);
    await see(E, "교육자료 준수 체크"); await see(E, "1회차 연습");
    const clova = emu.state.clovaRequests.at(-1);
    if (!clova.body.diarization?.enable || clova.body.language !== "ko-KR" || clova.body.completion !== "async") throw new Error("CLOVA 요청 형식 오류");
    await shot(E, "07-result");
  });
  await step("사원: 결과 화면 — 녹취 보기(화자 구분)·항목 펼치기", async () => {
    await act(E, "tx").click(); await see(E, "72시간 보습이 임상으로 확인됐어요"); await see(E, "고객");
    await act(E, "allitems").click(); await see(E, "이렇게 해 보세요");
  });
  await step("사원: 큰 녹음(>12MB)은 기기에서 압축 후 올리기(ffmpeg)", async () => {
    await act(E, "nav:practice").click();
    await E.locator('[data-act^="prod:"]').first().click(); await act(E, "next").click();
    await upload(E, "#file-in", bigWav);
    await see(E, "올리고 AI 점검 시작", 180000);
    await see(E, "줄었어요");
    await shot(E, "08-compressed");
    await act(E, "send").click(); await see(E, "2회차 연습", 60000); await see(E, "이전 회차 대비");
  });
  await step("사원: 연습 기록 — 추이·1회차 골라 보내기", async () => {
    await act(E, "nav:history").click(); await see(E, "회차별 추이");
    const first = E.locator(".attempt").filter({ hasText: "1회차" }).locator('[data-act^="pick:"]'); await first.click();
    await E.fill("#self-note", "고객 반응이 제일 좋았던 대화예요");
    await act(E, "submit").click(); await see(E, "매니저에게 보냈어요"); await see(E, "1회차를 보냈어요");
  });
  await step("사원: 2회차로 바꿔 보내기", async () => {
    await E.locator(".attempt").filter({ hasText: "2회차" }).locator('[data-act^="pick:"]').click();
    await act(E, "submit").click(); await see(E, "2회차를 보냈어요");
    await shot(E, "09-history");
  });

  const M = await newPage();
  await step("매니저: 이메일 로그인 → 비밀번호 변경 → 팀 현황", async () => {
    await login(M, "yujin@test.co", creds.mA); await changePw(M, "Yujin1234!");
    await see(M, "사원별 연습 현황"); await see(M, "박서준"); await shot(M, "10-mgr-dash");
  });
  await step("매니저: 제출된 대화 목록에 2회차만 보임(연습 내용 비공개)", async () => {
    await act(M, "nav:review").click(); await see(M, "본인 제출 · 2회차");
    if (await M.getByText("1회차").count()) throw new Error("보내지 않은 1회차가 매니저에게 보임");
  });
  await step("매니저: 평가 입력(임시 저장) → 사원은 제출 변경 불가", async () => {
    await M.locator('[data-act^="open:"]').first().click(); await see(M, "매니저 평가 입력");
    await M.fill("#ms-0", "10"); await see(M, "차이");
    await M.fill("#mg-comment", "매장에서 보면 응대가 훨씬 여유 있어요."); await act(M, "save:0").click(); await see(M, "임시 저장했어요");
    await E.reload(); await see(E, "진행 중이라 바꿀 수 없어요");
  });
  await step("매니저: 평가 완료·공개", async () => {
    await act(M, "save:1").click(); await see(M, "평가를 완료했어요"); await see(M, "항목별 점수: 매니저 vs AI");
  });
  await step("매니저: 우수 사례 공유(동의 전엔 버튼 잠김)", async () => {
    await see(M, "우수 사례로 공유");
    if (await M.locator("#share-btn").isEnabled()) throw new Error("동의 없이 공유 버튼이 켜져 있음");
    await M.fill("#share-point", "행사 오프닝과 제품 근거 설명이 교과서 같아요"); await M.check("#ok-emp"); await M.check("#ok-priv");
    await M.click("#share-btn"); await see(M, "우수 사례 게시판에 공유했어요");
  });
  await step("매니저: 대리 업로드 → 바로 평가 대기", async () => {
    await act(M, "nav:upload").click(); await see(M, "누구의 판매 대화인가요?");
    await M.locator('[data-act^="emp:"]').filter({ hasText: "김민지" }).click(); await act(M, "next").click();
    await M.locator('[data-act^="prod:"]').first().click(); await act(M, "next").click();
    await upload(M, "#file-in", smallWav); await see(M, "올리고 AI 점검 시작"); await act(M, "send").click();
    await see(M, "매니저 평가 입력", 60000); await see(M, "매니저 대리 업로드");
  });
  await step("매니저: 사원 한 명 등록·비밀번호 초기화", async () => {
    await act(M, "nav:team").click(); await M.fill("#new-name", "오하린"); await M.fill("#new-no", "20240922"); await M.click("#one-btn");
    await see(M, "오하린"); await see(M, "새 초기 비밀번호");
    const row = M.locator(".row").filter({ hasText: "박서준" }); await row.locator('[data-act^="reset:"]').click(); await row.locator('[data-act^="reset:"]').click();
    await see(M, "박서준님의 새 초기 비밀번호"); creds.seojunReset = (await M.locator(".banner.good b.num").innerText()).trim();
    await shot(M, "11-team");
  });

  await step("사원: 받은 평가·우수 사례 게시판", async () => {
    await login(E, "20231042", creds.seojunReset); await changePw(E, "Seojun5678!");
    await act(E, "nav:results").click(); await see(E, "최근 매니저 평가"); await see(E, "매니저 코칭 과제");
    await act(E, "nav:best").click(); await see(E, "행사 오프닝과 제품 근거 설명이 교과서 같아요");
    await act(E, "nav:best").click();
    const like = E.locator('[data-act^="like:"]').first(); await like.click(); await see(E, "♥ 도움이 됐어요 1");
    await shot(E, "12-best");
  });
  await step("다른 매장 매니저: 강남점 기록을 볼 수 없음, 게시판은 보임", async () => {
    const B = await newPage();
    await login(B, "jiwoo@test.co", creds.mB); await changePw(B, "Jiwoo1234!");
    await act(B, "nav:review").click(); await see(B, "평가할 대화가 없어요");
    await act(B, "nav:best").click(); await see(B, "교과서 같아요");
  });
  await step("다른 매장 사원(홍대점): 교육자료 보기", async () => {
    const H = await newPage();
    await login(H, "20240301", creds["20240301"]); await changePw(H, "Haeun1234!");
    await act(H, "nav:study").click(); await see(H, "72시간 보습"); await see(H, "10월 행사 콜멘트");
  });
  await step("관리자: 전체 현황 수치·게시물 내리기", async () => {
    await A.goto(`${emu.url}/coach/#/adash`); await see(A, "강남점"); await see(A, "홍대점");
    await act(A, "nav:best").click(); await A.locator('[data-act^="hide:"]').first().click(); await see(A, "게시판에서 내렸어요");
  });
} catch { failed = true; } finally {
  await browser.close();
  deno.kill();
  await emu.close();
}

for (const r of results) console.log(r[0] === "PASS" ? "✓" : "✗", r[1], `(${(r[2] / 1000).toFixed(1)}s)`, r[3] ? `\n    → ${r[3]}` : "");
const serverErr = emu.state.errors;
if (pageErrors.length) console.log("\n브라우저 오류:\n  " + [...new Set(pageErrors)].slice(0, 15).join("\n  "));
if (serverErr.length) console.log("\n흉내 서버 오류:\n  " + serverErr.slice(0, 10).join("\n  "));
if (failed || pageErrors.length) { console.log("\n최근 서버 로그:\n  " + logs.slice(-15).join("\n  ")); if (/error|Error/.test(denoOut)) console.log("\nDeno 로그:\n" + denoOut.slice(-3000)); }
console.log(`\nE2E: ${results.filter((r) => r[0] === "PASS").length}/${results.length} 통과${failed ? " (실패에서 중단)" : ""}${pageErrors.length ? `, 브라우저 오류 ${pageErrors.length}건` : ""}`);
process.exit(failed || pageErrors.length ? 1 : 0);
