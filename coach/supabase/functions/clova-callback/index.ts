// CLOVA Speech가 인식을 마치면 호출하는 주소. 서명으로 우리 요청인지 확인한 뒤 AI 평가를 시작함
import { adminClient, background, json, serviceKey, sign, SUPABASE_URL } from "../_shared/common.ts";

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const id = u.searchParams.get("e") ?? "";
  if (!id || u.searchParams.get("s") !== await sign(id)) return json({ error: "invalid signature" }, 401);
  const admin = adminClient();
  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad body" }, 400); }

  if (body.result !== "COMPLETED") {
    await admin.from("evaluations").update({ status: "failed", error: `음성 인식에 실패했어요 (${body.message ?? body.result ?? "알 수 없음"})` }).eq("id", id);
    return json({ ok: true });
  }
  // deno-lint-ignore no-explicit-any
  const segs = (body.segments ?? []).map((x: any) => ({
    s: (x.start ?? 0) / 1000, e: (x.end ?? 0) / 1000,
    spk: String(x.speaker?.label ?? x.speaker?.name ?? "1"), t: String(x.text ?? "").trim(),
  })).filter((x: { t: string }) => x.t);
  if (!segs.length) {
    await admin.from("evaluations").update({ status: "failed", error: "녹음에서 대화를 찾지 못했어요. 목소리가 잘 들리는지 확인해 주세요" }).eq("id", id);
    return json({ ok: true });
  }
  await admin.from("evaluations").update({
    transcript: segs, audio_seconds: Math.round(segs[segs.length - 1].e), status: "analyzing", error: null,
  }).eq("id", id);
  background(fetch(`${SUPABASE_URL}/functions/v1/evaluate`, {
    method: "POST", headers: { Authorization: `Bearer ${serviceKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ evaluation_id: id }),
  }));
  return json({ ok: true });
});
