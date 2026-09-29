import Anthropic from "npm:@anthropic-ai/sdk";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { mmss } from "./common.ts";

export const MODEL = "claude-opus-5";

function client() {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("AI 키(ANTHROPIC_API_KEY)가 아직 설정되지 않았어요");
  return new Anthropic({ apiKey: key });
}

// 구조화 출력(JSON schema)으로 한 번 호출하고 파싱한 객체를 돌려줌
// deno-lint-ignore no-explicit-any
export async function askJson(system: string, content: any[], schema: object, effort: "low" | "medium" | "high" = "medium"): Promise<any> {
  const stream = client().beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort, format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content }],
  // deno-lint-ignore no-explicit-any
  } as any);
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("AI가 이 요청을 처리하지 않았어요");
  if (msg.stop_reason === "max_tokens") throw new Error("AI 응답이 너무 길어 중간에 끊겼어요");
  // deno-lint-ignore no-explicit-any
  const text = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  return JSON.parse(text);
}

const EVAL_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["seller_speaker", "items", "compliance", "summary", "tasks", "highlights"],
  properties: {
    seller_speaker: { type: "string", description: "판매 사원으로 판단한 화자 라벨" },
    items: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["criterion_id", "score", "basis", "improvement"],
        properties: {
          criterion_id: { type: "string" },
          score: { type: "integer", description: "0~10" },
          basis: { type: "string", description: "점수의 근거. 대화 속 구체적 장면(mm:ss)과 표현을 인용" },
          improvement: { type: "string", description: "다음에 바로 써먹을 수 있는 구체적 개선 방법이나 예시 멘트" },
        },
      },
    },
    compliance: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["item_id", "status", "time", "quote", "note"],
        properties: {
          item_id: { type: "string" },
          status: { type: "string", enum: ["met", "partial", "missed", "clear", "violation"] },
          time: { type: "string", description: "근거 발화 시각 mm:ss, 없으면 빈 문자열" },
          quote: { type: "string", description: "근거가 된 사원의 실제 발화. 누락이면 빈 문자열" },
          note: { type: "string", description: "판정 이유 한 문장" },
        },
      },
    },
    summary: { type: "string", description: "총평 3~4문장. 잘한 점을 먼저, 격려하는 말투" },
    tasks: { type: "array", items: { type: "string" }, description: "다음 연습 과제 2~3개" },
    highlights: {
      type: "array",
      description: "다른 사원이 들어 볼 만한 잘한 장면 2~4개",
      items: {
        type: "object", additionalProperties: false, required: ["time", "label", "quote"],
        properties: { time: { type: "string" }, label: { type: "string" }, quote: { type: "string" } },
      },
    },
  },
};

const EVAL_SYSTEM = `당신은 화장품·생활용품 매장의 판매 코치입니다. 매장 사원이 고객과 나눈 판매 대화 녹취를 읽고 코칭 피드백을 작성합니다.

원칙:
- 녹취는 음성 인식 결과라 오타가 있을 수 있습니다. 문맥으로 이해하세요.
- 화자 라벨 중 판매하는 사원을 먼저 판단하고(seller_speaker), 사원의 발화를 기준으로 평가합니다.
- 평가 항목마다 0~10점 정수로 점수를 매깁니다. 대화에서 해당 행동을 확인할 수 없으면 낮은 점수를 주고 그 이유를 적습니다.
- 근거에는 반드시 대화의 구체적 장면(mm:ss)과 실제 표현을 인용합니다. 추측으로 칭찬하거나 지적하지 않습니다.
- 교육자료 체크리스트는 항목 하나하나 판정합니다.
  - '필수 설명'과 '필수 콜멘트': met(충분히 전달) / partial(일부만 또는 부정확) / missed(없음)
  - '금지 표현': clear(사용하지 않음) / violation(사용함)
  - 콜멘트는 문구가 완전히 같지 않아도 핵심 의미와 행사 조건이 전달되면 met입니다.
- 이 기록은 사원이 스스로 연습하며 보는 결과입니다. 잘한 점을 먼저 짚고, 개선점은 바로 따라 할 수 있는 예시 멘트로 제안하세요. 말투는 친근하고 존중하는 존댓말로 씁니다.
- 모든 문장은 한국어로 씁니다.`;

type Seg = { s: number; e: number; spk: string; t: string };

export function transcriptText(segs: Seg[]) {
  return segs.map((x) => `[${mmss(x.s)}] 화자${x.spk}: ${x.t}`).join("\n");
}

// 평가 실행: 결과를 evaluations에 저장
export async function runEvaluation(admin: SupabaseClient, evalId: string) {
  const { data: ev, error } = await admin.from("evaluations").select("*").eq("id", evalId).single();
  if (error || !ev) throw new Error("평가 기록을 찾지 못했어요");
  if (!ev.transcript?.length) throw new Error("녹취가 없어요");
  await admin.from("evaluations").update({ status: "analyzing", error: null }).eq("id", evalId);

  const [{ data: product }, { data: criteria }] = await Promise.all([
    admin.from("products").select("name, checklist").eq("id", ev.product_id).single(),
    admin.from("criteria").select("id, name, description, weight").eq("active", true).order("sort_order"),
  ]);
  const checklist: { id: string; type: string; text: string }[] = product?.checklist ?? [];
  const crit = criteria ?? [];

  const prompt = [
    `## 행사 품목\n${product?.name ?? ""}`,
    `## 평가 항목 (criterion_id: 이름 — 보는 행동)\n` + crit.map((c) => `- ${c.id}: ${c.name} — ${c.description}`).join("\n"),
    `## 교육자료 체크리스트 (item_id: [유형] 내용)\n` +
      (checklist.length ? checklist.map((c) => `- ${c.id}: [${c.type}] ${c.text}`).join("\n") : "(등록된 체크리스트 없음)"),
    `## 대화 녹취\n${transcriptText(ev.transcript)}`,
    `위 대화를 평가하세요. items에는 평가 항목 ${crit.length}개를 모두, compliance에는 체크리스트 ${checklist.length}개를 모두 포함하세요.`,
  ].join("\n\n");

  const out = await askJson(EVAL_SYSTEM, [{ type: "text", text: prompt }], EVAL_SCHEMA, "medium");

  // 정리: 이름·유형을 함께 저장해 두면 항목이 나중에 바뀌어도 기록이 유지됨
  // deno-lint-ignore no-explicit-any
  const byCrit = new Map(out.items.map((i: any) => [i.criterion_id, i]));
  const items = crit.map((c) => {
    // deno-lint-ignore no-explicit-any
    const i: any = byCrit.get(c.id) ?? { score: 0, basis: "평가하지 못했어요", improvement: "" };
    return { criterion_id: c.id, name: c.name, weight: Number(c.weight), score: Math.max(0, Math.min(10, Math.round(i.score))), basis: i.basis, improvement: i.improvement };
  });
  // deno-lint-ignore no-explicit-any
  const byItem = new Map(out.compliance.map((c: any) => [c.item_id, c]));
  const compliance = checklist.map((c) => {
    // deno-lint-ignore no-explicit-any
    const r: any = byItem.get(c.id) ?? { status: c.type === "금지 표현" ? "clear" : "missed", time: "", quote: "", note: "" };
    let status = r.status;
    if (c.type === "금지 표현" && !["clear", "violation"].includes(status)) status = status === "met" ? "clear" : "violation";
    if (c.type !== "금지 표현" && !["met", "partial", "missed"].includes(status)) status = status === "clear" ? "met" : "missed";
    return { item_id: c.id, type: c.type, text: c.text, status, time: r.time, quote: r.quote, note: r.note };
  });
  const wsum = items.reduce((a, i) => a + i.weight, 0) || 1;
  const aiTotal = Math.round((items.reduce((a, i) => a + i.score * i.weight, 0) / wsum) * 10) / 10;
  const pts = compliance.map((c) => (c.status === "met" || c.status === "clear" ? 1 : c.status === "partial" ? 0.5 : 0));
  const rate = pts.length ? Math.round((pts.reduce((a: number, b: number) => a + b, 0) / pts.length) * 100) : null;

  await admin.from("evaluations").update({
    ai: { seller_speaker: out.seller_speaker, items, compliance, summary: out.summary, tasks: out.tasks, highlights: out.highlights, model: MODEL },
    ai_total: aiTotal,
    compliance_rate: rate,
    status: ev.kind === "proxy" ? "reviewing" : "practice",
    error: null,
  }).eq("id", evalId);
}

// 7일 넘게 제출되지 않은 연습 녹음은 지워 저장 공간을 아낌 (공유·제출 건은 보관)
export async function cleanupOldAudio(admin: SupabaseClient) {
  const cutoff = new Date(Date.now() - 7 * 864e5).toISOString();
  const { data } = await admin.from("evaluations").select("id, audio_path")
    .eq("kind", "practice").in("status", ["practice", "failed"]).eq("audio_deleted", false)
    .not("audio_path", "is", null).lt("created_at", cutoff).limit(50);
  if (!data?.length) return;
  const { data: shared } = await admin.from("best_practices").select("audio_path").in("audio_path", data.map((d) => d.audio_path));
  const keep = new Set((shared ?? []).map((s) => s.audio_path));
  const targets = data.filter((d) => !keep.has(d.audio_path));
  if (!targets.length) return;
  await admin.storage.from("recordings").remove(targets.map((d) => d.audio_path!));
  await admin.from("evaluations").update({ audio_deleted: true }).in("id", targets.map((d) => d.id));
}

const CHECK_SCHEMA = {
  type: "object", additionalProperties: false, required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["type", "text"],
        properties: {
          type: { type: "string", enum: ["필수 설명", "필수 콜멘트", "금지 표현"] },
          text: { type: "string" },
        },
      },
    },
  },
};

const CHECK_SYSTEM = `당신은 매장 판매 교육 담당자입니다. 제품 설명서와 행사 콜멘트 자료를 읽고, 판매 대화에서 사원이 지켰는지 확인할 수 있는 체크리스트를 만듭니다.
- 필수 설명: 고객에게 반드시 전달해야 하는 제품 정보(성분, 수치, 사용법, 행사 구성 등). 한 항목에 한 가지 내용만.
- 필수 콜멘트: 자료에 나온 권장 멘트. 핵심 문구를 따옴표로 담아 "오프닝: “…”"처럼 쓰세요.
- 금지 표현: 자료에 금지·주의로 나온 표현이나, 화장품 판매에서 문제가 되는 의약품 효능 표현 등.
- 대화 녹취로 확인 가능한 것만 넣고, 모호하거나 중복된 항목은 빼세요. 보통 6~12개가 적당합니다.
- 한국어로 짧고 분명하게 씁니다.`;

// deno-lint-ignore no-explicit-any
export async function extractChecklist(productName: string, blocks: any[]) {
  const content = [...blocks, { type: "text", text: `행사 품목: ${productName}\n위 교육자료로 체크리스트를 만들어 주세요.` }];
  const out = await askJson(CHECK_SYSTEM, content, CHECK_SCHEMA, "medium");
  // deno-lint-ignore no-explicit-any
  return out.items.map((i: any) => ({ id: crypto.randomUUID().slice(0, 8), type: i.type, text: i.text.trim() }));
}
