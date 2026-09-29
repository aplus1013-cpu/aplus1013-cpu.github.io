import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

// 새 프로젝트는 SUPABASE_SECRET_KEYS(JSON), 이전 방식은 SUPABASE_SERVICE_ROLE_KEY
export function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    const parsed = JSON.parse(keys);
    return parsed.default ?? Object.values(parsed)[0];
  }
  throw new Error("service key missing");
}

export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
}

export type Profile = {
  id: string; role: "admin" | "manager" | "employee"; name: string;
  store_id: string | null; emp_no: string | null; active: boolean;
};

// 요청한 사용자의 프로필. 서비스 키로 호출하면 null(서버 내부 호출)
export async function caller(req: Request, admin: SupabaseClient): Promise<Profile | null> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "로그인이 필요해요");
  if (token === serviceKey()) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "로그인이 만료됐어요. 다시 로그인해 주세요");
  const { data: p } = await admin.from("profiles").select("id, role, name, store_id, emp_no, active").eq("id", data.user.id).single();
  if (!p || !p.active) throw new HttpError(403, "사용할 수 없는 계정이에요");
  return p as Profile;
}

export function handler(fn: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "서버에서 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요" }, 500);
    }
  };
}

// 콜백 URL 서명
export async function sign(value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(serviceKey()),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function mmss(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// deno-lint-ignore no-explicit-any
export function background(p: Promise<any>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p); else p.catch(console.error);
}
