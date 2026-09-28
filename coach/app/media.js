// 업로드 전 휴대폰/PC 안에서 처리: 동영상은 음성만 뽑고, 큰 음성은 음성 인식용으로 압축
import { FFMPEG_CORE, MAX_UPLOAD } from "./config.js";

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i;
const AUDIO_OK = { "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm", "audio/flac": "flac" };
const EXT_MIME = { m4a: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", webm: "audio/webm", flac: "audio/flac" };
export const SMALL_AUDIO = 12 * 1024 * 1024;
export const WARN_SIZE = 2 * 1024 * 1024 * 1024;

export function kindOf(file) {
  if (file.type.startsWith("video/") || VIDEO_EXT.test(file.name)) return "video";
  if (file.type.startsWith("audio/") || /\.(m4a|aac|mp3|wav|ogg|flac|amr|3ga|opus|wma)$/i.test(file.name)) return "audio";
  return "unknown";
}

// 변환 없이 그대로 보내도 되는지
export function passThrough(file) {
  if (kindOf(file) !== "audio" || file.size > SMALL_AUDIO) return null;
  const ext = file.name.split(".").pop().toLowerCase();
  const mime = AUDIO_OK[file.type] ? file.type : EXT_MIME[ext];
  if (!mime) return null;
  return { blob: file, ext: AUDIO_OK[mime] ?? ext, mime };
}

async function toBlobURL(url, type) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("음성 변환 엔진을 받지 못했어요. 인터넷 연결을 확인해 주세요");
  return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type }));
}

let ffmpegP = null;
async function getFFmpeg(onStage) {
  if (!ffmpegP) {
    ffmpegP = (async () => {
      onStage?.("변환 엔진 준비 중(처음 한 번만 약 30MB)");
      const { FFmpeg } = await import("../vendor/ffmpeg/index.js");
      const ff = new FFmpeg();
      await ff.load({
        classWorkerURL: new URL("../vendor/ffmpeg/worker.js", import.meta.url).href,
        coreURL: await toBlobURL(`${FFMPEG_CORE}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${FFMPEG_CORE}/ffmpeg-core.wasm`, "application/wasm"),
      });
      return ff;
    })().catch((e) => { ffmpegP = null; throw e; });
  }
  return ffmpegP;
}

// 반환: { blob, ext, mime, converted }
export async function prepareAudio(file, { onStage, onProgress } = {}) {
  const pass = passThrough(file);
  if (pass) return { ...pass, converted: false };
  const kind = kindOf(file);
  if (kind === "unknown") throw new Error("녹음(음성) 또는 동영상 파일만 올릴 수 있어요");

  const ff = await getFFmpeg(onStage);
  const prog = ({ progress }) => onProgress?.(Math.max(0, Math.min(100, Math.round((progress || 0) * 100))));
  ff.on("progress", prog);
  const dir = "/in" + Date.now();
  try {
    onStage?.(kind === "video" ? "동영상에서 음성 추출·압축 중" : "음성 인식용으로 압축 중");
    await ff.createDir(dir);
    // 원본을 메모리로 복사하지 않고 파일을 직접 읽음(큰 동영상 대응)
    await ff.mount("WORKERFS", { files: [file] }, dir);
    const code = await ff.exec(["-i", `${dir}/${file.name}`, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "32k", "out.m4a"]);
    if (code !== 0) throw new Error("파일을 변환하지 못했어요. 소리가 들어 있는 파일인지 확인해 주세요");
    const data = await ff.readFile("out.m4a");
    await ff.deleteFile("out.m4a");
    const blob = new Blob([data.buffer], { type: "audio/mp4" });
    if (blob.size > MAX_UPLOAD) throw new Error("압축해도 50MB가 넘어요. 녹음을 나눠서 올려 주세요");
    if (blob.size < 2000) throw new Error("파일에서 소리를 찾지 못했어요");
    return { blob, ext: "m4a", mime: "audio/mp4", converted: true };
  } finally {
    ff.off("progress", prog);
    try { await ff.unmount(dir); await ff.deleteDir(dir); } catch { /* 이미 정리됨 */ }
  }
}
