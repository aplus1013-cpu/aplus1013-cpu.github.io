// 녹취 + 평가 항목 + 행사 교육자료 체크리스트로 AI 평가를 만들어 저장
import { adminClient, background, caller, handler, HttpError, json } from "../_shared/common.ts";
import { cleanupOldAudio, runEvaluation } from "../_shared/ai.ts";

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const me = await caller(req, admin);
  const { evaluation_id: id } = await req.json();
  const { data: ev } = await admin.from("evaluations").select("id, uploaded_by, employee_id, store_id, status, transcript").eq("id", id).single();
  if (!ev) throw new HttpError(404, "기록을 찾지 못했어요");
  if (me) {
    const staff = me.role === "admin" || (me.role === "manager" && ev.store_id === me.store_id);
    if (ev.uploaded_by !== me.id && ev.employee_id !== me.id && !staff) throw new HttpError(403, "권한이 없어요");
    if (ev.status !== "failed") throw new HttpError(400, "실패한 기록만 다시 분석할 수 있어요");
  }
  if (!ev.transcript?.length) throw new HttpError(400, "녹취가 없어요");

  background((async () => {
    try {
      await runEvaluation(admin, id);
    } catch (e) {
      console.error("evaluate", id, e);
      const msg = e instanceof Error && /[가-힣]/.test(e.message) ? e.message : "AI 분석 중 문제가 생겼어요. 다시 시도해 주세요";
      await admin.from("evaluations").update({ status: "failed", error: msg }).eq("id", id);
    }
    await cleanupOldAudio(admin).catch(console.error);
  })());
  return json({ status: "analyzing" });
}));
