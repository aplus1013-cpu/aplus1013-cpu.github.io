import { createClient } from "../vendor/supabase.js";
import { SUPABASE_KEY, SUPABASE_URL } from "./config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "coach.auth" } });

// Supabase 응답에서 오류를 꺼내 한국어 메시지로 던짐
export function must({ data, error }) {
  if (error) throw new Error(friendly(error.message ?? String(error)));
  return data;
}

export function friendly(msg) {
  if (/Invalid login credentials/i.test(msg)) return "사번(이메일) 또는 비밀번호가 맞지 않아요";
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return "서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요";
  if (/row-level security|permission denied/i.test(msg)) return "이 작업을 할 권한이 없어요";
  if (/JWT expired|invalid JWT/i.test(msg)) return "로그인이 만료됐어요. 다시 로그인해 주세요";
  if (/Payload too large|exceeded the maximum allowed size/i.test(msg)) return "파일이 너무 커요(최대 50MB)";
  if (/Password should be at least/i.test(msg)) return "비밀번호는 8자 이상이어야 해요";
  if (/same_password|should be different/i.test(msg)) return "지금과 다른 비밀번호를 입력해 주세요";
  return msg;
}

export async function rpc(name, args) {
  return must(await sb.rpc(name, args));
}

// Edge Function 호출. 함수가 보낸 {error} 메시지를 그대로 보여 줌
export async function fn(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context?.json(); if (j?.error) msg = j.error; } catch { /* 본문 없음 */ }
    throw new Error(friendly(msg));
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function signedUrl(bucket, path, sec = 3600) {
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, sec);
  if (error) throw new Error(friendly(error.message));
  return data.signedUrl;
}
