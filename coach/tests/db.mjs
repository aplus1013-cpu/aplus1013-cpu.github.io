// 로컬 테스트 DB: PGlite(메모리 Postgres)에 Supabase 흉내 + 실제 마이그레이션을 적용
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migDir = join(here, "../supabase/migrations");

export async function createDb() {
  const db = new PGlite();
  await db.exec(readFileSync(join(here, "supabase-stubs.sql"), "utf8"));
  for (const f of readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migDir, f), "utf8").replace(/create extension[^;]*;/gi, "");
    try { await db.exec(sql); } catch (e) { throw new Error(`${f}: ${e.message}`); }
  }
  return db;
}

// role: 'anon' | 'authenticated' | 'service_role', sub: 사용자 id
export async function as(db, role, sub, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub ?? ""]);
    await tx.exec(`set local role ${role}`);
    return fn(tx);
  });
}

export async function addUser(db, { email, password = "Passw0rd!", role, name, emp_no = null, store_id = null, manager_id = null }) {
  const { rows: [u] } = await db.query(`insert into auth.users (email, password, raw_user_meta_data) values ($1,$2,$3) returning id`,
    [email, password, { name }]);
  if (role) {
    await db.query(`insert into public.profiles (id, role, name, emp_no, email, store_id, manager_id, must_change_pw)
                    values ($1,$2,$3,$4,$5,$6,$7,false)`, [u.id, role, name, emp_no, role === "employee" ? null : email, store_id, manager_id]);
  }
  return u.id;
}
