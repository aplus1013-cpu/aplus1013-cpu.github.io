// DB 권한(RLS)·RPC 테스트: node coach/tests/db.test.mjs
import assert from "node:assert/strict";
import { addUser, as, createDb } from "./db.mjs";

const db = await createDb();
const results = [];
async function t(name, fn) {
  try { await fn(); results.push(["PASS", name]); } catch (e) { results.push(["FAIL", name, e.message.split("\n")[0]]); }
}
const rejects = async (p, re) => {
  let err; try { await p; } catch (e) { err = e; }
  assert.ok(err, "실패해야 하는데 성공함");
  if (re) assert.match(err.message, re);
};
const svc = (fn) => as(db, "service_role", null, fn);

// ---- 준비 ----
const { rows: [sa] } = await db.query(`insert into stores (name) values ('강남점') returning id`);
const { rows: [sb] } = await db.query(`insert into stores (name) values ('홍대점') returning id`);
const admin = await addUser(db, { email: "admin@t.co", role: "admin", name: "본사" });
const mA = await addUser(db, { email: "ma@t.co", role: "manager", name: "정유진", store_id: sa.id });
const mB = await addUser(db, { email: "mb@t.co", role: "manager", name: "한지우", store_id: sb.id });
const eA1 = await addUser(db, { email: "20231042@staff.coach.local", role: "employee", name: "박서준", emp_no: "20231042", store_id: sa.id, manager_id: mA });
const eA2 = await addUser(db, { email: "20220815@staff.coach.local", role: "employee", name: "김민지", emp_no: "20220815", store_id: sa.id, manager_id: mA });
const eB1 = await addUser(db, { email: "20240301@staff.coach.local", role: "employee", name: "이하은", emp_no: "20240301", store_id: sb.id, manager_id: mB });
const { rows: [prod] } = await db.query(`insert into products (name, checklist) values ('수분크림 1+1', '[{"id":"c1","type":"필수 설명","text":"72시간 보습"}]') returning id`);
const { rows: crit } = await db.query(`select id from criteria order by sort_order`);

const newPractice = (emp) => as(db, "authenticated", emp, (tx) =>
  tx.query(`insert into evaluations (employee_id, product_id, kind) values ($1,$2,'practice') returning id, attempt_no, store_id`, [emp, prod.id]));
const finishAi = (id, kind = "practice") => svc((tx) => tx.query(
  `update evaluations set status = $2, audio_path = $1 || '.m4a', ai = $3, ai_total = 7.5, compliance_rate = 80 where id = $1`,
  [id, kind === "proxy" ? "reviewing" : "practice", { items: crit.map((c) => ({ criterion_id: c.id, score: 7 })), compliance: [{ text: "72시간 보습", status: "missed" }] }]));
const see = (user, id) => as(db, "authenticated", user, (tx) => tx.query(`select id, status from evaluations where id = $1`, [id])).then((r) => r.rows.length === 1);

let p1, p2;
await t("사원: 본인 연습 기록 생성, 회차 번호 1·2 자동", async () => {
  p1 = (await newPractice(eA1)).rows[0];
  p2 = (await newPractice(eA1)).rows[0];
  assert.equal(p1.attempt_no, 1); assert.equal(p2.attempt_no, 2); assert.equal(p1.store_id, sa.id);
});
await t("사원: 다른 사원 이름으로 기록 생성 불가", () => rejects(as(db, "authenticated", eA1, (tx) =>
  tx.query(`insert into evaluations (employee_id, product_id, kind) values ($1,$2,'practice')`, [eA2, prod.id])), /row-level security/));
await t("사원: 대리 업로드(proxy) 생성 불가", () => rejects(as(db, "authenticated", eA1, (tx) =>
  tx.query(`insert into evaluations (employee_id, product_id, kind) values ($1,$2,'proxy')`, [eA1, prod.id])), /row-level security/));
await t("사원: 기록 상태를 직접 바꿀 수 없음", async () => {
  const r = await as(db, "authenticated", eA1, (tx) => tx.query(`update evaluations set status='completed' where id=$1`, [p1.id]));
  assert.equal(r.affectedRows ?? 0, 0);
});
await finishAi(p1.id); await finishAi(p2.id);

await t("매니저: 제출 안 된 연습은 볼 수 없음", async () => assert.equal(await see(mA, p1.id), false));
await t("관리자: 모든 기록 조회 가능", async () => assert.equal(await see(admin, p1.id), true));
await t("사원: 1회차 제출 → 매니저에게 보임", async () => {
  await as(db, "authenticated", eA1, (tx) => tx.query(`select submit_attempt($1, '잘한 회차')`, [p1.id]));
  assert.equal(await see(mA, p1.id), true);
});
await t("다른 매장 매니저는 제출 건도 볼 수 없음", async () => assert.equal(await see(mB, p1.id), false));
await t("사원: 2회차로 제출 변경 → 1회차는 연습으로 돌아감", async () => {
  await as(db, "authenticated", eA1, (tx) => tx.query(`select submit_attempt($1, null)`, [p2.id]));
  const { rows } = await db.query(`select id, status from evaluations where id in ($1,$2) order by attempt_no`, [p1.id, p2.id]);
  assert.deepEqual(rows.map((r) => r.status), ["practice", "submitted"]);
  assert.equal(await see(mA, p1.id), false);
});
await t("다른 사원은 남의 연습을 제출할 수 없음", () => rejects(as(db, "authenticated", eA2, (tx) => tx.query(`select submit_attempt($1, null)`, [p1.id])), /제출할 수 없는/));
await t("사원: 제출 취소 가능", async () => {
  await as(db, "authenticated", eA1, (tx) => tx.query(`select withdraw_attempt($1)`, [p2.id]));
  await as(db, "authenticated", eA1, (tx) => tx.query(`select submit_attempt($1, null)`, [p2.id]));
});

const scores = crit.map((c, i) => ({ criterion_id: c.id, name: "x", score: i < 5 ? 8 : 6 }));
await t("매니저: 임시 저장 → 평가 중, 사원은 아직 결과를 못 봄", async () => {
  await as(db, "authenticated", mA, (tx) => tx.query(`select save_review($1,$2,'좋아요',array['과제1'],false)`, [p2.id, JSON.stringify(scores)]));
  const { rows } = await db.query(`select status from evaluations where id=$1`, [p2.id]);
  assert.equal(rows[0].status, "reviewing");
  const r = await as(db, "authenticated", eA1, (tx) => tx.query(`select * from manager_reviews where evaluation_id=$1`, [p2.id]));
  assert.equal(r.rows.length, 0);
});
await t("평가가 시작되면 사원은 제출을 바꿀 수 없음", () => rejects(as(db, "authenticated", eA1, (tx) => tx.query(`select submit_attempt($1, null)`, [p1.id])), /이미 시작/));
await t("다른 매장 매니저는 평가 불가", () => rejects(as(db, "authenticated", mB, (tx) =>
  tx.query(`select save_review($1,$2,'',null,true)`, [p2.id, JSON.stringify(scores)])), /평가할 수 없는/));
await t("매니저: 평가 완료 → 사원에게 공개, 종합 점수 계산(가중치 반영)", async () => {
  await as(db, "authenticated", mA, (tx) => tx.query(`select save_review($1,$2,'잘했어요',array['과제1'],true)`, [p2.id, JSON.stringify(scores)]));
  const r = await as(db, "authenticated", eA1, (tx) => tx.query(`select total, comment from manager_reviews where evaluation_id=$1`, [p2.id]));
  assert.equal(r.rows.length, 1);
  assert.equal(Number(r.rows[0].total), 7);
});

await t("우수 사례: 동의 없이 공유 불가", () => rejects(as(db, "authenticated", mA, (tx) =>
  tx.query(`select share_best($1,'포인트','[]','all',false,true)`, [p2.id])), /동의/));
let bestStore;
await t("우수 사례: 우리 매장만 공유 → 다른 매장 사원에게 안 보임", async () => {
  bestStore = (await as(db, "authenticated", mA, (tx) => tx.query(`select share_best($1,'포인트','[]','store',true,true) id`, [p2.id]))).rows[0].id;
  const a = await as(db, "authenticated", eA2, (tx) => tx.query(`select id from best_practices`));
  const b = await as(db, "authenticated", eB1, (tx) => tx.query(`select id from best_practices`));
  assert.equal(a.rows.length, 1); assert.equal(b.rows.length, 0);
});
await t("우수 사례: 전체 공개로 바꾸면 다른 매장 사원도 보고, 녹음도 들을 수 있음", async () => {
  await as(db, "authenticated", admin, (tx) => tx.query(`update best_practices set scope='all' where id=$1`, [bestStore]));
  await svc((tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('recordings', $1)`, [`${p2.id}.m4a`]));
  const b = await as(db, "authenticated", eB1, (tx) => tx.query(`select id from best_practices`));
  const o = await as(db, "authenticated", eB1, (tx) => tx.query(`select name from storage.objects where bucket_id='recordings'`));
  assert.equal(b.rows.length, 1); assert.equal(o.rows.length, 1);
});
await t("우수 사례: 좋아요는 본인 이름으로만", async () => {
  await as(db, "authenticated", eB1, (tx) => tx.query(`insert into best_likes (best_id) values ($1)`, [bestStore]));
  await rejects(as(db, "authenticated", eB1, (tx) => tx.query(`insert into best_likes (best_id, user_id) values ($1,$2)`, [bestStore, eA2])), /row-level security/);
});
await t("우수 사례: 사원은 게시물을 내릴 수 없음", async () => {
  const r = await as(db, "authenticated", eB1, (tx) => tx.query(`update best_practices set hidden=true where id=$1`, [bestStore]));
  assert.equal(r.affectedRows ?? 0, 0);
});

let px;
await t("매니저: 자기 매장 사원 대리 업로드 가능", async () => {
  px = (await as(db, "authenticated", mA, (tx) => tx.query(`insert into evaluations (employee_id, product_id, kind) values ($1,$2,'proxy') returning id`, [eA2, prod.id]))).rows[0];
});
await t("매니저: 다른 매장 사원 대리 업로드 불가", () => rejects(as(db, "authenticated", mA, (tx) =>
  tx.query(`insert into evaluations (employee_id, product_id, kind) values ($1,$2,'proxy')`, [eB1, prod.id])), /row-level security/));
await t("매니저: 실패한 대리 업로드 기록은 지울 수 있고, 다른 사람 기록은 못 지움", async () => {
  const x = (await as(db, "authenticated", mA, (tx) => tx.query(`insert into evaluations (employee_id, product_id, kind) values ($1,$2,'proxy') returning id`, [eA1, prod.id]))).rows[0];
  const d0 = await as(db, "authenticated", mB, (tx) => tx.query(`delete from evaluations where id=$1`, [x.id]));
  assert.equal(d0.affectedRows ?? 0, 0);
  const d = await as(db, "authenticated", mA, (tx) => tx.query(`delete from evaluations where id=$1`, [x.id]));
  assert.equal(d.affectedRows, 1);
});
await t("녹음 업로드: 본인이 만든 업로드 중 기록 경로만 허용", async () => {
  await as(db, "authenticated", mA, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('recordings', $1)`, [`${px.id}.m4a`]));
  await rejects(as(db, "authenticated", mA, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('recordings', 'other.m4a')`)), /row-level security/);
  await rejects(as(db, "authenticated", eA2, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('recordings', $1)`, [`${p1.id}.m4a`])), /row-level security/);
});
await t("녹음 읽기: 매니저는 제출 안 된 연습 녹음을 못 들음", async () => {
  await svc((tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('recordings', $1)`, [`${p1.id}.m4a`]));
  const r = await as(db, "authenticated", mA, (tx) => tx.query(`select name from storage.objects where name=$1`, [`${p1.id}.m4a`]));
  assert.equal(r.rows.length, 0);
});
await t("사원: 본인 연습 기록 삭제 가능, 제출·평가된 기록은 삭제 불가", async () => {
  const p3 = (await newPractice(eA1)).rows[0];
  const d = await as(db, "authenticated", eA1, (tx) => tx.query(`delete from evaluations where id=$1`, [p3.id]));
  assert.equal(d.affectedRows, 1);
  const d2 = await as(db, "authenticated", eA1, (tx) => tx.query(`delete from evaluations where id=$1`, [p2.id]));
  assert.equal(d2.affectedRows ?? 0, 0);
});

await t("팀 현황: 매니저는 자기 매장 사원만, 사원은 빈 결과", async () => {
  const m = await as(db, "authenticated", mA, (tx) => tx.query(`select name, attempts from team_practice_stats()`));
  assert.deepEqual(m.rows.map((r) => r.name).sort(), ["김민지", "박서준"]);
  assert.equal(m.rows.find((r) => r.name === "박서준").attempts, 2);
  const e = await as(db, "authenticated", eA1, (tx) => tx.query(`select * from team_practice_stats()`));
  assert.equal(e.rows.length, 0);
});
await t("매장 현황: 관리자만", async () => {
  const a = await as(db, "authenticated", admin, (tx) => tx.query(`select store_name, waiting from store_overview()`));
  assert.equal(a.rows.length, 2);
  const m = await as(db, "authenticated", mA, (tx) => tx.query(`select * from store_overview()`));
  assert.equal(m.rows.length, 0);
});
await t("항목 평균·자주 놓치는 내용 RPC 동작", async () => {
  const c = await as(db, "authenticated", eA1, (tx) => tx.query(`select * from criteria_averages($1)`, [sa.id]));
  assert.equal(c.rows.length, 10);
  const m = await as(db, "authenticated", mA, (tx) => tx.query(`select * from missed_items($1)`, [sa.id]));
  assert.ok(Array.isArray(m.rows));
});
await t("프로필: 사원은 본인만, 매니저는 자기 매장만", async () => {
  const e = await as(db, "authenticated", eA1, (tx) => tx.query(`select id from profiles`));
  assert.equal(e.rows.length, 1);
  const m = await as(db, "authenticated", mA, (tx) => tx.query(`select name from profiles`));
  assert.deepEqual(m.rows.map((r) => r.name).sort(), ["김민지", "박서준", "정유진"]);
});
await t("행사 품목·교육자료: 사원은 읽기만, 관리자는 수정 가능", async () => {
  const e = await as(db, "authenticated", eA1, (tx) => tx.query(`update products set name='x' where id=$1`, [prod.id]));
  assert.equal(e.affectedRows ?? 0, 0);
  const a = await as(db, "authenticated", admin, (tx) => tx.query(`update products set name='수분크림 1+1' where id=$1`, [prod.id]));
  assert.equal(a.affectedRows, 1);
});
await t("설정 테이블(설정 코드)은 앱 사용자가 읽을 수 없음", () => rejects(as(db, "authenticated", admin, (tx) => tx.query(`select * from app_settings`)), /permission denied/));
await t("로그인 안 한 사용자는 RPC·데이터 접근 불가", async () => {
  await rejects(as(db, "anon", null, (tx) => tx.query(`select * from team_practice_stats()`)), /permission denied/);
  const r = await as(db, "anon", null, (tx) => tx.query(`select * from criteria`));
  assert.equal(r.rows.length, 0);
});
await t("비밀번호 변경 완료 표시", async () => {
  await db.query(`update profiles set must_change_pw=true where id=$1`, [eA2]);
  await as(db, "authenticated", eA2, (tx) => tx.query(`select password_changed()`));
  const { rows } = await db.query(`select must_change_pw from profiles where id=$1`, [eA2]);
  assert.equal(rows[0].must_change_pw, false);
});

const fails = results.filter((r) => r[0] === "FAIL");
for (const r of results) console.log(r[0] === "PASS" ? "✓" : "✗", r[1], r[2] ? `— ${r[2]}` : "");
console.log(`\nDB 테스트: ${results.length - fails.length}/${results.length} 통과`);
process.exit(fails.length ? 1 : 0);
