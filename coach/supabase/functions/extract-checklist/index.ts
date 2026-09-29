// 관리자: 행사 품목의 교육자료(PDF·텍스트·이미지)에서 필수 체크리스트를 뽑아 저장
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { adminClient, caller, handler, HttpError, json } from "../_shared/common.ts";
import { extractChecklist } from "../_shared/ai.ts";

const IMAGE = ["image/jpeg", "image/png", "image/gif", "image/webp"];

Deno.serve(handler(async (req) => {
  const admin = adminClient();
  const me = await caller(req, admin);
  if (!me || me.role !== "admin") throw new HttpError(403, "관리자만 할 수 있어요");
  const { product_id } = await req.json();
  const { data: product } = await admin.from("products").select("id, name").eq("id", product_id).single();
  if (!product) throw new HttpError(404, "행사 품목을 찾지 못했어요");
  const { data: mats } = await admin.from("materials").select("*").eq("product_id", product_id).order("created_at");
  if (!mats?.length) throw new HttpError(400, "먼저 교육자료를 올려 주세요");

  // deno-lint-ignore no-explicit-any
  const blocks: any[] = [];
  for (const m of mats) {
    blocks.push({ type: "text", text: `### 자료: ${m.title}` });
    if (m.text_content) { blocks.push({ type: "text", text: m.text_content }); continue; }
    if (!m.file_path) continue;
    const { data: file, error } = await admin.storage.from("materials").download(m.file_path);
    if (error || !file) continue;
    const mime = m.mime ?? file.type;
    if (mime === "application/pdf") {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: encodeBase64(new Uint8Array(await file.arrayBuffer())) } });
    } else if (IMAGE.includes(mime)) {
      blocks.push({ type: "image", source: { type: "base64", media_type: mime, data: encodeBase64(new Uint8Array(await file.arrayBuffer())) } });
    } else {
      blocks.push({ type: "text", text: await file.text() });
    }
  }
  const checklist = await extractChecklist(product.name, blocks);
  await admin.from("products").update({ checklist }).eq("id", product_id);
  return json({ checklist });
}));
