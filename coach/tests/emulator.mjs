// 로컬 테스트용 Supabase 흉내 서버.
// - 앱 파일(coach/) 제공
// - REST(PostgREST 일부) · 인증 · 저장소를 PGlite 위에서 RLS 그대로 적용해 처리
// - Edge Functions는 실제 함수 코드를 Deno로 실행해 전달(fn-runner.ts)
// - CLOVA 음성 인식과 Claude API는 가짜 응답(요청 형식은 기록해 검사)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = normalize(join(here, ".."));
export const SERVICE_KEY = "test-service-key";
export const ANON_KEY = "test-anon-key";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm" };
const IDENT = /^[a-z_][a-z0-9_]*$/;
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

export async function startEmulator({ port = 0, fnPort, ffmpegDir, log = () => {} } = {}) {
  const db = await createDb();
  const state = { anthropicRequests: [], clovaRequests: [], fnPort, errors: [] };
  const base = () => `http://127.0.0.1:${server.address().port}`;

  // ---- 토큰 ----
  const makeToken = (u) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return { access_token: `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: u.id, email: u.email, role: "authenticated", aud: "authenticated", exp, iat: exp - 3600 })}.sig`, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: Buffer.from(u.id).toString("base64url"), user: userJson(u) };
  };
  const userJson = (u) => ({ id: u.id, aud: "authenticated", role: "authenticated", email: u.email, email_confirmed_at: new Date().toISOString(), app_metadata: { provider: "email" }, user_metadata: u.raw_user_meta_data ?? {}, created_at: u.created_at ?? new Date().toISOString() });
  function whoFrom(req) {
    const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const key = req.headers.apikey;
    if (auth === SERVICE_KEY || (!auth && key === SERVICE_KEY)) return { role: "service_role" };
    if (auth && auth.split(".").length === 3) {
      try {
        const p = JSON.parse(Buffer.from(auth.split(".")[1], "base64url").toString());
        if (p.exp * 1000 < Date.now()) return { role: "anon", expired: true };
        return { role: "authenticated", sub: p.sub };
      } catch { /* 형식 오류 */ }
    }
    return { role: "anon" };
  }
  async function asWho(who, fn) {
    return db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [who.sub ?? ""]);
      await tx.exec(`set local role ${who.role}`);
      return fn(tx);
    });
  }
  const pgErr = (e) => {
    const code = e.code ?? "";
    const status = code === "42501" ? 403 : code === "23505" ? 409 : code === "P0001" ? 400 : code.startsWith("22") || code.startsWith("23") ? 400 : code === "42883" || code === "42P01" ? 404 : 400;
    return [status, { code, message: e.message, details: e.detail ?? null, hint: e.hint ?? null }];
  };

  // ---- PostgREST ----
  function filters(params) {
    const where = [], vals = [];
    for (const [k, v] of params) {
      if (["select", "order", "limit", "offset", "columns", "on_conflict"].includes(k)) continue;
      if (!IDENT.test(k)) throw Object.assign(new Error(`bad column ${k}`), { code: "42703" });
      let neg = false, s = v;
      if (s.startsWith("not.")) { neg = true; s = s.slice(4); }
      const dot = s.indexOf("."), op = s.slice(0, dot), raw = s.slice(dot + 1);
      let cond;
      const p = () => { vals.push(raw); return `$${vals.length}`; };
      if (op === "eq") cond = `"${k}" = ${p()}`;
      else if (op === "neq") cond = `"${k}" <> ${p()}`;
      else if (op === "gt") cond = `"${k}" > ${p()}`;
      else if (op === "gte") cond = `"${k}" >= ${p()}`;
      else if (op === "lt") cond = `"${k}" < ${p()}`;
      else if (op === "lte") cond = `"${k}" <= ${p()}`;
      else if (op === "is") cond = `"${k}" is ${raw === "null" ? "null" : raw === "true" ? "true" : "false"}`;
      else if (op === "in") {
        const items = raw.replace(/^\(|\)$/g, "").match(/("([^"\\]|\\.)*"|[^,]+)/g) ?? [];
        cond = items.length ? `"${k}"::text in (${items.map((x) => { vals.push(x.replace(/^"|"$/g, "")); return `$${vals.length}`; }).join(",")})` : "false";
      } else throw Object.assign(new Error(`unsupported op ${op}`), { code: "PGRST100" });
      where.push(neg ? `not (${cond})` : cond);
    }
    return { where: where.length ? " where " + where.join(" and ") : "", vals };
  }
  const colList = (sel) => {
    if (!sel || sel === "*") return "*";
    return sel.split(",").map((c) => c.trim()).map((c) => { if (!IDENT.test(c)) throw Object.assign(new Error(`unsupported select ${c}`), { code: "PGRST100" }); return `"${c}"`; }).join(", ");
  };
  const orderBy = (o) => !o ? "" : " order by " + o.split(",").map((x) => { const [c, dir, nulls] = x.split("."); if (!IDENT.test(c)) throw new Error("bad order"); return `"${c}" ${dir === "desc" ? "desc" : "asc"}${nulls === "nullsfirst" ? " nulls first" : nulls === "nullslast" ? " nulls last" : ""}`; }).join(", ");
  // 쓰기 값: JSON 컬럼과 배열 컬럼을 알맞게 변환
  const colTypes = {};
  async function typesOf(table) {
    if (!colTypes[table]) {
      const { rows } = await db.query(`select column_name, data_type from information_schema.columns where table_schema='public' and table_name=$1`, [table]);
      colTypes[table] = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
    }
    return colTypes[table];
  }
  const toPg = (v, type) => v == null ? null : type === "jsonb" || type === "json" ? JSON.stringify(v) : type === "ARRAY" ? `{${v.map((x) => `"${String(x).replace(/["\\]/g, "\\$&")}"`).join(",")}}` : typeof v === "object" ? JSON.stringify(v) : v;

  async function rest(req, res, path, url, body) {
    const who = whoFrom(req);
    if (who.expired) return send(res, 401, { code: "PGRST303", message: "JWT expired" });
    const single = (req.headers.accept ?? "").includes("vnd.pgrst.object");
    const prefer = req.headers.prefer ?? "";
    const params = [...url.searchParams.entries()];
    try {
      if (path.startsWith("rpc/")) {
        const name = path.slice(4);
        const { rows: [pr] } = await db.query(`select proretset, prorettype::regtype::text as rt, proargnames, (select array_agg(t::regtype::text) from unnest(proargtypes) t) as argtypes from pg_proc where proname=$1 and pronamespace='public'::regnamespace`, [name]);
        if (!pr) return send(res, 404, { code: "PGRST202", message: `function ${name} not found` });
        const args = body ?? {};
        const names = Object.keys(args);
        const vals = names.map((n) => { const i = (pr.proargnames ?? []).indexOf(n); const t = pr.argtypes?.[i]; return Array.isArray(args[n]) && t?.endsWith("[]") ? toPg(args[n], "ARRAY") : toPg(args[n], t === "jsonb" ? "jsonb" : undefined); });
        const call = `public.${name}(${names.map((n, i) => { if (!IDENT.test(n)) throw new Error("bad arg"); return `${n} => $${i + 1}`; }).join(", ")})`;
        const out = await asWho(who, async (tx) => pr.proretset ? (await tx.query(`select * from ${call}`, vals)).rows : (await tx.query(`select ${call} as v`, vals)).rows[0].v);
        return send(res, 200, pr.rt === "void" ? null : out);
      }
      const table = path;
      if (!IDENT.test(table)) return send(res, 404, { message: "not found" });
      const sel = colList(url.searchParams.get("select"));
      if (req.method === "GET" || req.method === "HEAD") {
        const { where, vals } = filters(params);
        const lim = url.searchParams.get("limit"), off = url.searchParams.get("offset");
        const rows = await asWho(who, async (tx) => (await tx.query(`select ${sel} from public."${table}"${where}${orderBy(url.searchParams.get("order"))}${lim ? ` limit ${+lim}` : ""}${off ? ` offset ${+off}` : ""}`, vals)).rows);
        return single ? (rows.length === 1 ? send(res, 200, rows[0]) : send(res, 406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${rows.length} rows` })) : send(res, 200, rows);
      }
      const types = await typesOf(table);
      if (req.method === "POST") {
        const items = Array.isArray(body) ? body : [body];
        const out = await asWho(who, async (tx) => {
          const res2 = [];
          for (const it of items) {
            const cols = Object.keys(it).filter((c) => { if (!IDENT.test(c)) throw new Error("bad col"); return true; });
            const q = cols.length ? `insert into public."${table}" (${cols.map((c) => `"${c}"`).join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning ${sel}`
              : `insert into public."${table}" default values returning ${sel}`;
            res2.push(...(await tx.query(q, cols.map((c) => toPg(it[c], types[c])))).rows);
          }
          return res2;
        });
        if (!prefer.includes("return=representation")) return send(res, 201, null);
        return single ? send(res, 201, out[0]) : send(res, 201, out);
      }
      if (req.method === "PATCH") {
        const { where, vals } = filters(params);
        const cols = Object.keys(body ?? {});
        const set = cols.map((c, i) => { if (!IDENT.test(c)) throw new Error("bad col"); return `"${c}" = $${vals.length + i + 1}`; }).join(", ");
        const out = await asWho(who, async (tx) => (await tx.query(`update public."${table}" set ${set}${where} returning ${sel}`, [...vals, ...cols.map((c) => toPg(body[c], types[c]))])).rows);
        return prefer.includes("return=representation") ? send(res, 200, single ? out[0] : out) : send(res, 204, null);
      }
      if (req.method === "DELETE") {
        const { where, vals } = filters(params);
        const out = await asWho(who, async (tx) => (await tx.query(`delete from public."${table}"${where} returning ${sel}`, vals)).rows);
        return prefer.includes("return=representation") ? send(res, 200, out) : send(res, 204, null);
      }
      return send(res, 405, { message: "method not allowed" });
    } catch (e) {
      const [st, b] = pgErr(e);
      log(`REST ${req.method} ${path} → ${st} ${b.message}`);
      return send(res, st, b);
    }
  }

  // ---- 인증 ----
  async function authApi(req, res, path, url, body) {
    const who = whoFrom(req);
    if (path === "health") return send(res, 200, { name: "GoTrue", version: "emu" });
    if (path === "token") {
      const grant = url.searchParams.get("grant_type");
      let u;
      if (grant === "password") {
        u = (await db.query(`select * from auth.users where lower(email)=lower($1)`, [body.email])).rows[0];
        if (!u || u.password !== body.password) return send(res, 400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
      } else if (grant === "refresh_token") {
        const id = Buffer.from(body.refresh_token ?? "", "base64url").toString();
        u = (await db.query(`select * from auth.users where id::text=$1`, [id])).rows[0];
        if (!u) return send(res, 400, { error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
      } else return send(res, 400, { msg: "unsupported grant" });
      if (u.banned) return send(res, 400, { error_code: "user_banned", msg: "User is banned" });
      return send(res, 200, makeToken(u));
    }
    if (path === "logout") return send(res, 204, null);
    if (path === "user") {
      if (!who.sub) return send(res, 401, { error_code: "bad_jwt", msg: "invalid JWT" });
      const u = (await db.query(`select * from auth.users where id=$1`, [who.sub])).rows[0];
      if (!u) return send(res, 404, { msg: "User not found" });
      if (req.method === "PUT") {
        if (body.password) {
          if (body.password.length < 6) return send(res, 422, { error_code: "weak_password", msg: "Password should be at least 6 characters." });
          if (body.password === u.password) return send(res, 422, { error_code: "same_password", msg: "New password should be different from the old password." });
          await db.query(`update auth.users set password=$2 where id=$1`, [u.id, body.password]);
        }
        return send(res, 200, userJson(u));
      }
      return send(res, 200, userJson(u));
    }
    if (path.startsWith("admin/users")) {
      if (who.role !== "service_role") return send(res, 403, { msg: "User not allowed" });
      const id = path.split("/")[2];
      if (req.method === "POST") {
        const exists = (await db.query(`select 1 from auth.users where lower(email)=lower($1)`, [body.email])).rows.length;
        if (exists) return send(res, 422, { code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return send(res, 400, { error_code: "validation_failed", msg: "Unable to validate email address: invalid format" });
        const u = (await db.query(`insert into auth.users (email, password, raw_user_meta_data) values (lower($1),$2,$3) returning *`, [body.email, body.password, body.user_metadata ?? {}])).rows[0];
        return send(res, 200, userJson(u));
      }
      if (req.method === "PUT") {
        if (body.password) await db.query(`update auth.users set password=$2 where id=$1`, [id, body.password]);
        if (body.ban_duration) await db.query(`update auth.users set banned=$2 where id=$1`, [id, body.ban_duration !== "none"]);
        const u = (await db.query(`select * from auth.users where id=$1`, [id])).rows[0];
        return u ? send(res, 200, userJson(u)) : send(res, 404, { msg: "User not found" });
      }
      if (req.method === "DELETE") { await db.query(`delete from auth.users where id=$1`, [id]); return send(res, 200, {}); }
    }
    return send(res, 404, { msg: `auth ${path} not emulated` });
  }

  // ---- 저장소 ----
  async function storageApi(req, res, path, url, raw) {
    const who = whoFrom(req);
    const m = path.match(/^object\/(sign\/|list\/)?([^/]+)\/?(.*)$/);
    if (!m) return send(res, 404, { error: "not found" });
    const [, kind, bucket, name] = m;
    const objName = decodeURIComponent(name);
    try {
      if (kind === "sign/" && req.method === "POST") {
        const ok = await asWho(who, async (tx) => (await tx.query(`select 1 from storage.objects where bucket_id=$1 and name=$2`, [bucket, objName])).rows.length);
        if (!ok) return send(res, 400, { statusCode: "404", error: "not_found", message: "Object not found" });
        return send(res, 200, { signedURL: `/object/sign/${bucket}/${name}?token=${b64u({ bucket, name: objName, exp: Date.now() + 36e5 })}` });
      }
      if (kind === "sign/" && req.method === "GET") {
        const t = JSON.parse(Buffer.from(url.searchParams.get("token") ?? "", "base64url").toString() || "{}");
        if (t.bucket !== bucket || t.name !== objName || t.exp < Date.now()) return send(res, 400, { error: "InvalidSignature" });
        const o = (await db.query(`select data, mime from storage.objects where bucket_id=$1 and name=$2`, [bucket, objName])).rows[0];
        if (!o) return send(res, 404, { error: "not_found" });
        res.writeHead(200, { "Content-Type": o.mime ?? "application/octet-stream", "Content-Length": o.data.length, "Accept-Ranges": "bytes" });
        return res.end(Buffer.from(o.data));
      }
      if (kind === "list/") {
        const body = raw.length ? JSON.parse(raw.toString()) : {};
        const rows = await asWho(who, async (tx) => (await tx.query(`select name, created_at from storage.objects where bucket_id=$1 and name like $2 limit $3`, [bucket, (body.prefix ?? "") + "%", body.limit ?? 100])).rows);
        return send(res, 200, rows.map((r) => ({ name: r.name, id: r.name, created_at: r.created_at, metadata: {} })));
      }
      if (req.method === "POST" || req.method === "PUT") {
        const b = (await db.query(`select * from storage.buckets where id=$1`, [bucket])).rows[0];
        if (!b) return send(res, 400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
        let data = raw, mime = req.headers["content-type"];
        if (mime?.startsWith("multipart/form-data")) {
          const fd = await new Request("http://x", { method: "POST", headers: { "content-type": mime }, body: raw }).formData();
          const file = [...fd.values()].find((v) => typeof v === "object");
          data = Buffer.from(await file.arrayBuffer()); mime = file.type || "application/octet-stream";
        }
        if (b.file_size_limit && data.length > b.file_size_limit) return send(res, 413, { statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" });
        if (b.allowed_mime_types && !b.allowed_mime_types.includes(mime)) return send(res, 400, { statusCode: "415", error: "invalid_mime_type", message: `mime type ${mime} is not supported` });
        await asWho(who, (tx) => tx.query(`insert into storage.objects (bucket_id, name, size, mime, data) values ($1,$2,$3,$4,$5)`, [bucket, objName, data.length, mime, data]));
        return send(res, 200, { Key: `${bucket}/${objName}`, Id: objName });
      }
      if (req.method === "DELETE") {
        const body = raw.length ? JSON.parse(raw.toString()) : {};
        const names = body.prefixes ?? [objName];
        const rows = await asWho(who, async (tx) => (await tx.query(`delete from storage.objects where bucket_id=$1 and name = any($2) returning name`, [bucket, names])).rows);
        return send(res, 200, rows.map((r) => ({ name: r.name })));
      }
      if (req.method === "GET") {
        const o = await asWho(who, async (tx) => (await tx.query(`select data, mime from storage.objects where bucket_id=$1 and name=$2`, [bucket, objName])).rows[0]);
        if (!o) return send(res, 400, { statusCode: "404", error: "not_found", message: "Object not found" });
        res.writeHead(200, { "Content-Type": o.mime ?? "application/octet-stream" });
        return res.end(Buffer.from(o.data));
      }
    } catch (e) {
      const [st, b] = pgErr(e);
      log(`STORAGE ${req.method} ${path} → ${st} ${b.message}`);
      return send(res, st === 403 ? 400 : st, { statusCode: String(st), error: "Unauthorized", message: e.message.includes("row-level") ? "new row violates row-level security policy" : e.message });
    }
    return send(res, 404, { error: "not emulated" });
  }

  // ---- 가짜 CLOVA: 녹음 주소를 실제로 받아 본 뒤 콜백으로 결과를 보냄 ----
  async function clova(req, res, body) {
    state.clovaRequests.push({ headers: req.headers, body });
    if (req.headers["x-clovaspeech-api-key"] !== "test-clova") return send(res, 401, { message: "bad key" });
    const audio = await fetch(body.url);
    const size = audio.ok ? (await audio.arrayBuffer()).byteLength : -1;
    send(res, 200, { token: "tok-" + Date.now() });
    setTimeout(async () => {
      const segs = audio.ok ? [
        [1000, 4000, "1", "어서 오세요. 이번 주까지 수분크림 1+1 행사 중이에요."],
        [4500, 7000, "2", "건조해서 보습 잘 되는 거 찾고 있어요."],
        [7500, 12000, "1", "이 제품은 72시간 보습이 임상으로 확인됐어요. 세럼 바르고 다음 단계에 쓰시면 돼요."],
        [12500, 15000, "2", "음 생각해 볼게요."],
        [15500, 19000, "1", "오늘 구매하시면 샘플 키트도 함께 드려요."],
      ] : [];
      await fetch(body.callback, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(audio.ok
        ? { result: "COMPLETED", message: "Succeeded", token: "t", segments: segs.map(([s, e, l, t]) => ({ start: s, end: e, text: t, speaker: { label: l, name: l === "1" ? "A" : "B" } })), fullText: segs.map((x) => x[3]).join(" "), _audioBytes: size }
        : { result: "FAILED", message: "audio not reachable" }) }).catch((e) => state.errors.push("callback " + e.message));
    }, 300);
  }

  // ---- 가짜 Claude API: 받은 스키마에 맞춰 JSON 응답(스트리밍) ----
  function anthropic(req, res, body) {
    state.anthropicRequests.push({ headers: req.headers, body });
    const user = body.messages?.[0]?.content?.filter?.((b) => b.type === "text").map((b) => b.text).join("\n") ?? "";
    let out;
    if (/교육 담당자/.test(body.system ?? "")) {
      out = { items: [{ type: "필수 설명", text: "72시간 보습 지속 임상 결과 안내" }, { type: "필수 콜멘트", text: "오프닝: “이번 주까지 수분크림 1+1 행사 중이에요”" }, { type: "필수 콜멘트", text: "클로징: “오늘 구매하시면 샘플 키트도 함께 드려요”" }, { type: "금지 표현", text: "“여드름이 낫는다” 등 의약품 효능 표현" }] };
    } else {
      const crit = [...user.matchAll(/^- ([0-9a-f-]{36}): (.+?) —/gm)].map((m) => m[1]);
      const items = [...user.matchAll(/^- ([\w-]+): \[(.+?)\] (.+)$/gm)].filter((m) => !/^[0-9a-f-]{36}$/.test(m[1]));
      out = {
        seller_speaker: "1",
        items: crit.map((id, i) => ({ criterion_id: id, score: 5 + (i % 5), basis: `[00:07] “72시간 보습이 임상으로 확인됐어요”라고 근거를 들어 설명함 (${i + 1})`, improvement: "고객이 망설일 때 “오늘 구매하시면 샘플 키트도 드려요”를 먼저 제안해 보세요." })),
        compliance: items.map((m, i) => ({ item_id: m[1], status: m[2] === "금지 표현" ? "clear" : ["met", "partial", "missed"][i % 3], time: i % 3 === 2 ? "" : "00:07", quote: i % 3 === 2 ? "" : "이 제품은 72시간 보습이 임상으로 확인됐어요.", note: "테스트 판정" })),
        summary: "행사 안내로 자연스럽게 시작했고 제품 근거를 정확히 전달했어요. 고객이 망설일 때 클로징 멘트를 바로 이어 가면 더 좋아요.",
        tasks: ["고객이 망설일 때 샘플 키트 혜택으로 클로징하기", "세럼 묶음 제안 멘트 연습하기"],
        highlights: [{ time: "00:01", label: "행사 오프닝", quote: "이번 주까지 수분크림 1+1 행사 중이에요." }, { time: "00:07", label: "제품 근거 설명", quote: "72시간 보습이 임상으로 확인됐어요." }],
      };
    }
    const text = JSON.stringify(out);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "request-id": "req_test" });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: { id: "msg_test", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (let i = 0; i < text.length; i += 400) ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(i, i + 400) } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 500 } });
    ev("message_stop", {});
    res.end();
  }

  // ---- 정적 파일 ----
  async function staticFile(res, path) {
    let f = normalize(join(appRoot, decodeURIComponent(path)));
    if (!f.startsWith(appRoot)) return send(res, 403, null);
    try { if ((await stat(f)).isDirectory()) f = join(f, "index.html"); } catch { return send(res, 404, { error: "not found" }); }
    const data = await readFile(f);
    res.writeHead(200, { "Content-Type": MIME[extname(f)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  }

  function send(res, status, body) {
    if (res.headersSent) return;
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Expose-Headers": "*" };
    if (body === null || status === 204) { res.writeHead(status, cors); return res.end(status === 200 ? "null" : undefined); }
    res.writeHead(status, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body = null;
    try { if (raw.length && !(req.headers["content-type"] ?? "").startsWith("multipart") && (req.headers["content-type"] ?? "").includes("json")) body = JSON.parse(raw.toString()); } catch { /* 본문이 JSON 아님 */ }
    if (req.method === "OPTIONS") return send(res, 200, {});
    const p = url.pathname;
    try {
      if (p.startsWith("/rest/v1/")) return await rest(req, res, p.slice(9), url, body);
      if (p.startsWith("/auth/v1/")) return await authApi(req, res, p.slice(9), url, body ?? {});
      if (p.startsWith("/storage/v1/")) return await storageApi(req, res, p.slice(12), url, raw);
      if (p.startsWith("/functions/v1/")) {
        const r = await fetch(`http://127.0.0.1:${state.fnPort}${p}${url.search}`, { method: req.method, headers: { ...req.headers, host: undefined }, body: raw.length ? raw : undefined });
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "application/json", "Access-Control-Allow-Origin": "*" });
        return res.end(buf);
      }
      if (p === "/clova/recognizer/url") return await clova(req, res, body);
      if (p === "/anthropic/v1/messages") return anthropic(req, res, body);
      if (p.startsWith("/ffmpeg-core/") && ffmpegDir) {
        const f = join(ffmpegDir, p.slice(13));
        const data = await readFile(f);
        res.writeHead(200, { "Content-Type": MIME[extname(f)] ?? "application/octet-stream", "Access-Control-Allow-Origin": "*" });
        return res.end(req.method === "HEAD" ? undefined : data);
      }
      if (p.startsWith("/coach/") || p === "/coach") return await staticFile(res, p.slice(6) || "/");
      return send(res, 404, { error: "not found" });
    } catch (e) {
      state.errors.push(`${req.method} ${p}: ${e.stack}`);
      log(`500 ${req.method} ${p}: ${e.message}`);
      return send(res, 500, { message: e.message });
    }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { db, server, state, url: base(), close: () => new Promise((r) => server.close(r)) };
}
