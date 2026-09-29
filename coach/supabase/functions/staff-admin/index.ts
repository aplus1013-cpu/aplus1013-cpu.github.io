// 계정 관리: 첫 관리자 설정, 사원·매니저 일괄 등록, 비밀번호 초기화, 사용 중지
import { adminClient, caller, handler, HttpError, json, type Profile } from "../_shared/common.ts";

export const STAFF_DOMAIN = "staff.coach.local";
const EMP_NO = /^\d{6,10}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function genPw() {
  const a = "abcdefghjkmnpqrstuvwxyz", d = "23456789";
  const pick = (s: string, n: number) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => s[x % s.length]).join("");
  const w = pick(a, 4);
  return w[0].toUpperCase() + w.slice(1) + pick(d, 4);
}

type Row = { row?: number; name?: string; emp_no?: string; email?: string; store?: string; manager_email?: string; password?: string };

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const body = await req.json();

  // 시스템 점검: 로그인한 사용자에게만 키 설정 여부(값은 보내지 않음)를 알려 줌
  if (body.action === "health") {
    let me = null;
    try { me = await caller(req, admin); } catch { /* 로그인 전 */ }
    if (!me) return json({ ok: true });
    return json({ ok: true, anthropic: !!Deno.env.get("ANTHROPIC_API_KEY"), clova: !!(Deno.env.get("CLOVA_INVOKE_URL") && Deno.env.get("CLOVA_SECRET_KEY")) });
  }

  // 첫 관리자 만들기: 관리자가 한 명도 없고 설정 코드가 맞을 때만
  if (body.action === "bootstrap") {
    const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin");
    if (count) throw new HttpError(400, "이미 관리자가 있어요. 로그인해 주세요");
    const { data: code } = await admin.from("app_settings").select("value").eq("key", "setup_code").single();
    if (!code || String(body.code ?? "").trim().toUpperCase() !== code.value) throw new HttpError(403, "설정 코드가 맞지 않아요");
    const email = String(body.email ?? "").trim().toLowerCase(), name = String(body.name ?? "").trim(), pw = String(body.password ?? "");
    if (!EMAIL.test(email) || !name) throw new HttpError(400, "이름과 이메일을 확인해 주세요");
    if (pw.length < 8) throw new HttpError(400, "비밀번호는 8자 이상이어야 해요");
    const { data: u, error } = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true, user_metadata: { name } });
    if (error || !u.user) throw new HttpError(400, error?.message ?? "계정을 만들지 못했어요");
    await admin.from("profiles").insert({ id: u.user.id, role: "admin", name, email, must_change_pw: false });
    await admin.from("app_settings").delete().eq("key", "setup_code");
    return json({ ok: true });
  }

  const me = await caller(req, admin);
  if (!me || me.role === "employee") throw new HttpError(403, "권한이 없어요");

  if (body.action === "create_users") return json({ results: await createUsers(admin, me, body.role, body.rows ?? [], !!body.name_only) });

  if (body.action === "reset_password" || body.action === "set_active") {
    const { data: target } = await admin.from("profiles").select("id, role, store_id, name").eq("id", body.user_id).single();
    if (!target) throw new HttpError(404, "계정을 찾지 못했어요");
    const allowed = me.role === "admin" ? target.id !== me.id || body.action === "reset_password"
      : target.role === "employee" && target.store_id === me.store_id;
    if (!allowed) throw new HttpError(403, "이 계정은 바꿀 수 없어요");
    if (body.action === "reset_password") {
      const password = genPw();
      const { error } = await admin.auth.admin.updateUserById(target.id, { password });
      if (error) throw new HttpError(400, error.message);
      await admin.from("profiles").update({ must_change_pw: true }).eq("id", target.id);
      return json({ password });
    }
    const active = !!body.active;
    await admin.auth.admin.updateUserById(target.id, { ban_duration: active ? "none" : "876000h" });
    await admin.from("profiles").update({ active }).eq("id", target.id);
    return json({ ok: true });
  }
  throw new HttpError(400, "알 수 없는 요청이에요");
}));

// deno-lint-ignore no-explicit-any
// nameOnly: 사원을 이름(과 매장)만으로 등록. 로그인 계정은 나중에 사번을 정할 때 만듦
async function createUsers(admin: any, me: Profile, role: string, rows: Row[], nameOnly = false) {
  if (nameOnly && role !== "employee") throw new HttpError(400, "이름만 등록은 사원만 할 수 있어요");
  if (!["employee", "manager", "admin"].includes(role)) throw new HttpError(400, "역할이 올바르지 않아요");
  if (role !== "employee" && me.role !== "admin") throw new HttpError(403, "매니저·관리자 등록은 관리자만 할 수 있어요");
  if (rows.length > 500) throw new HttpError(400, "한 번에 500명까지 올릴 수 있어요");

  const { data: stores } = await admin.from("stores").select("id, name");
  const storeByName = new Map<string, string>((stores ?? []).map((s: { id: string; name: string }) => [s.name, s.id]));
  const { data: managers } = await admin.from("profiles").select("id, email, store_id").eq("role", "manager").eq("active", true);
  const seen = new Set<string>();
  const results = [];

  for (const [i, r] of rows.entries()) {
    const rowNo = r.row ?? i + 2;
    const name = String(r.name ?? "").trim();
    const out: Record<string, unknown> = { row: rowNo, name };
    try {
      if (!name) throw new Error("이름이 비어 있어요");
      let email: string, emp_no: string | null = null, store_id: string | null = null, manager_id: string | null = null;
      if (role === "employee") {
        if (nameOnly) {
          emp_no = null;
          email = `m-${crypto.randomUUID()}@${STAFF_DOMAIN}`;
        } else {
          emp_no = String(r.emp_no ?? "").trim();
          if (!EMP_NO.test(emp_no)) throw new Error("사번은 숫자 6~10자리여야 해요");
          if (seen.has(emp_no)) throw new Error("파일 안에서 사번이 겹쳐요");
          seen.add(emp_no);
          email = `${emp_no}@${STAFF_DOMAIN}`;
        }
        if (me.role === "manager") { store_id = me.store_id; manager_id = me.id; }
        else {
          const sname = String(r.store ?? "").trim();
          store_id = sname ? storeByName.get(sname) ?? null : null;
          if (!store_id && (sname || !nameOnly)) throw new Error(`‘${sname}’은 등록된 매장이 아니에요`);
          const mEmail = String(r.manager_email ?? "").trim().toLowerCase();
          // deno-lint-ignore no-explicit-any
          const m = mEmail ? managers?.find((x: any) => x.email === mEmail) : managers?.find((x: any) => x.store_id === store_id);
          if (mEmail && !m) throw new Error("등록되지 않은 매니저 이메일이에요");
          if (m && m.store_id !== store_id) throw new Error("매니저와 매장이 맞지 않아요");
          manager_id = m?.id ?? null;
        }
        if (emp_no) out.emp_no = emp_no;
      } else {
        email = String(r.email ?? "").trim().toLowerCase();
        if (!EMAIL.test(email)) throw new Error("이메일 형식이 올바르지 않아요");
        if (seen.has(email)) throw new Error("파일 안에서 이메일이 겹쳐요");
        seen.add(email);
        if (role === "manager") {
          const sname = String(r.store ?? "").trim();
          if (!sname) throw new Error("매장이 비어 있어요");
          store_id = storeByName.get(sname) ?? null;
          if (!store_id) {
            const { data: s, error } = await admin.from("stores").insert({ name: sname }).select("id").single();
            if (error) throw new Error("매장을 만들지 못했어요");
            store_id = s.id; storeByName.set(sname, s.id);
          }
        }
        out.email = email;
      }
      const pwIn = String(r.password ?? "").trim();
      if (pwIn && pwIn.length < 8) throw new Error("초기 비밀번호는 8자 이상이어야 해요");
      const password = nameOnly ? genPw() + genPw() : pwIn || genPw();

      const { data: u, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
      if (error || !u?.user) {
        throw new Error(/already|registered|exists/i.test(error?.message ?? "") ? (role === "employee" ? "이미 등록된 사번이에요" : "이미 등록된 이메일이에요") : (error?.message ?? "계정을 만들지 못했어요"));
      }
      const { error: pErr } = await admin.from("profiles").insert({
        id: u.user.id, role, name, emp_no, email: role === "employee" ? null : email, store_id, manager_id, must_change_pw: true,
      });
      if (pErr) { await admin.auth.admin.deleteUser(u.user.id); throw new Error("프로필을 저장하지 못했어요"); }
      if (role === "manager") managers?.push({ id: u.user.id, email, store_id });
      results.push({ ...out, ok: true, id: u.user.id, password: nameOnly ? null : password, store: role === "employee" && me.role === "manager" ? null : r.store ?? null });
    } catch (e) {
      results.push({ ...out, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
