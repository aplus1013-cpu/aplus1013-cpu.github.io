// 업로드된 녹음을 CLOVA Speech 음성 인식(비동기)에 보내고, 결과는 clova-callback으로 받음
import { adminClient, background, caller, handler, HttpError, json, serviceKey, sign, SUPABASE_URL } from "../_shared/common.ts";

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const me = await caller(req, admin);
  const body = await req.json();
  const id: string = body.evaluation_id;
  const { data: ev } = await admin.from("evaluations").select("*").eq("id", id).single();
  if (!ev) throw new HttpError(404, "기록을 찾지 못했어요");
  if (me) {
    const staff = me.role === "admin" || (me.role === "manager" && ev.store_id === me.store_id);
    if (ev.uploaded_by !== me.id && ev.employee_id !== me.id && !staff) throw new HttpError(403, "권한이 없어요");
  }

  // 다시 시도: 녹취가 있으면 AI 평가만, 없으면 음성 인식부터
  if (body.retry) {
    if (ev.status !== "failed") throw new HttpError(400, "실패한 기록만 다시 시도할 수 있어요");
    if (ev.transcript?.length) {
      await admin.from("evaluations").update({ status: "analyzing", error: null }).eq("id", id);
      background(fetch(`${SUPABASE_URL}/functions/v1/evaluate`, {
        method: "POST", headers: { Authorization: `Bearer ${serviceKey()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ evaluation_id: id }),
      }));
      return json({ status: "analyzing" });
    }
    if (!ev.audio_path || ev.audio_deleted) throw new HttpError(400, "녹음 파일이 없어 다시 올려야 해요");
  } else {
    if (ev.status !== "uploading") throw new HttpError(400, "이미 처리 중인 기록이에요");
    const path: string = body.audio_path;
    if (!path || !path.startsWith(`${id}.`)) throw new HttpError(400, "파일 경로가 올바르지 않아요");
    ev.audio_path = path;
    await admin.from("evaluations").update({
      audio_path: path, orig_name: body.orig_name ?? null, orig_size: body.orig_size ?? null, sent_size: body.sent_size ?? null,
    }).eq("id", id);
  }

  const fail = async (msg: string) => {
    await admin.from("evaluations").update({ status: "failed", error: msg }).eq("id", id);
    return json({ status: "failed", error: msg });
  };
  const invoke = Deno.env.get("CLOVA_INVOKE_URL");
  const secret = Deno.env.get("CLOVA_SECRET_KEY");
  if (!invoke || !secret) return fail("음성 인식 키(CLOVA)가 아직 설정되지 않았어요. 관리자에게 알려 주세요");

  const { data: signed, error: sErr } = await admin.storage.from("recordings").createSignedUrl(ev.audio_path, 60 * 60 * 6);
  if (sErr || !signed) return fail("녹음 파일을 찾지 못했어요. 다시 올려 주세요");

  await admin.from("evaluations").update({ status: "transcribing", error: null }).eq("id", id);
  const callback = `${SUPABASE_URL}/functions/v1/clova-callback?e=${id}&s=${await sign(id)}`;
  const res = await fetch(`${invoke.replace(/\/$/, "")}/recognizer/url`, {
    method: "POST",
    headers: { "X-CLOVASPEECH-API-KEY": secret, "Content-Type": "application/json" },
    body: JSON.stringify({
      url: signed.signedUrl, language: "ko-KR", completion: "async", callback,
      fullText: true, wordAlignment: false, diarization: { enable: true },
    }),
  });
  if (!res.ok) {
    console.error("clova", res.status, await res.text());
    return fail(`음성 인식 요청이 거절됐어요 (코드 ${res.status})`);
  }
  return json({ status: "transcribing" });
}));
