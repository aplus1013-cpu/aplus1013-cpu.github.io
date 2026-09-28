// 공개해도 되는 설정입니다. 데이터는 DB 권한 규칙(RLS)으로 보호됩니다.
const o = globalThis.COACH_CONFIG ?? {};
export const SUPABASE_URL = o.url ?? "https://dxvgidtjzrxeamfqhymy.supabase.co";
export const SUPABASE_KEY = o.key ?? "sb_publishable_O2TarY_-qZEHZa3LBH0GQA_53i9Uy4c";
export const STAFF_DOMAIN = "staff.coach.local";
export const FFMPEG_CORE = o.ffmpegCore ?? "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
export const MAX_UPLOAD = 50 * 1024 * 1024;
