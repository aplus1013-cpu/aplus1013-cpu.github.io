// 우수 사례 게시판: 매니저가 고른 대화를 듣고 벤치마킹
import { must, rpc, sb, signedUrl } from "../api.js";
import { page, refresh, S } from "../core.js";
import { empty, esc, fmtDate, mmss, num1, toSec, toast } from "../ui.js";

let filter = "all", played = new Set();

page("best", {
  title: "우수 사례",
  render: async () => {
    const posts = must(await sb.from("best_practices").select("*").order("created_at", { ascending: false }).limit(100));
    const likes = posts.length ? must(await sb.from("best_likes").select("best_id, user_id").in("best_id", posts.map((p) => p.id))) : [];
    const cnt = {}, mine = new Set();
    likes.forEach((l) => { cnt[l.best_id] = (cnt[l.best_id] ?? 0) + 1; if (l.user_id === S.me.id) mine.add(l.best_id); });
    const prods = [...new Map(posts.map((p) => [p.product_id, p.product_name])).entries()];
    const list = posts.filter((p) => filter === "all" || p.product_id === filter);
    const isAdmin = S.me.role === "admin";
    return `<div class="stack">
      <div class="note">매니저가 고른 잘한 판매 대화예요. 표시된 구간을 누르면 그 장면부터 들을 수 있어요.</div>
      ${prods.length > 1 ? `<div class="chips">${[["all", "전체"], ...prods].map(([k, l]) => `<button class="pill ${filter === k ? "p-info" : "p-mute"}" style="border:0;padding:6px 12px;font-size:13px" data-act="f:${k}">${esc(l)}</button>`).join("")}</div>` : ""}
      ${list.length ? list.map((b) => `<article class="panel" ${b.hidden ? 'style="opacity:.6"' : ""}>
        <div style="display:flex;gap:10px;align-items:center"><div class="avatar">${esc(b.emp_name[0])}</div>
          <div style="flex:1;min-width:0"><div style="font-weight:600">${esc(b.emp_name)} <span class="hint" style="font-weight:400">· ${esc(b.store_name)}</span> ${b.hidden ? '<span class="pill p-mute">내림</span>' : ""}</div>
          <div class="hint">${esc(b.product_name)} · ${fmtDate(b.created_at)} · 추천 ${esc(b.manager_name)} 매니저${b.scope === "store" ? " · 우리 매장 공개" : ""}</div></div>
          <div style="text-align:right"><div class="score">${num1(b.score)}</div><div class="hint" style="font-size:11px">준수 ${b.compliance_rate ?? "—"}%</div></div></div>
        <p style="margin:12px 0 10px;white-space:pre-wrap"><span class="lab b">매니저 추천 포인트</span>${esc(b.point)}</p>
        <audio id="au-${b.id}" controls preload="none" data-path="${esc(b.audio_path)}" data-best="${b.id}"></audio>
        ${b.chapters?.length ? `<div class="stack" style="gap:6px;margin-top:10px">${b.chapters.map((c) => `<button class="choice" style="padding:9px 12px" data-act="seek:${b.id}|${esc(c.time)}">
          <span class="num" style="color:var(--accent);font-size:13px">${esc(c.time || mmss(0))}</span><div class="main"><div style="font-weight:600;font-size:14px">${esc(c.label)}</div><div class="hint" style="white-space:normal">${esc(c.quote)}</div></div></button>`).join("")}</div>` : ""}
        <div class="btns" style="margin-top:10px;align-items:center"><button class="btn ghost" data-act="like:${b.id}" data-nobusy="1">${mine.has(b.id) ? "♥" : "♡"} 도움이 됐어요 ${cnt[b.id] ?? 0}</button><span class="hint">재생 ${b.plays}회</span></div>
        ${isAdmin ? `<button class="btn ghost sm" style="margin-top:6px" data-act="hide:${b.id}:${b.hidden ? 0 : 1}">${b.hidden ? "다시 올리기" : "게시판에서 내리기"}</button>` : ""}
      </article>`).join("") : empty("아직 공유된 우수 사례가 없어요. 매니저가 평가를 마친 대화 중 잘한 대화를 공유하면 여기에 올라와요.")}
    </div>`;
  },
  mounted: () => {
    document.querySelectorAll("audio[data-best]").forEach((a) => {
      a.addEventListener("play", async () => {
        if (!a.dataset.ready) {
          a.dataset.ready = 1;
          try { a.src = await signedUrl("recordings", a.dataset.path); a.play(); } catch (e) { toast(e.message, true); }
        }
        if (!played.has(a.dataset.best)) { played.add(a.dataset.best); rpc("play_best", { p_id: a.dataset.best }).catch(() => {}); }
        document.querySelectorAll("audio[data-best]").forEach((o) => { if (o !== a) o.pause(); });
      });
    });
  },
  actions: {
    f: (k) => { filter = k; return refresh(); },
    seek: async (arg) => {
      const [id, t] = arg.split("|");
      const a = document.getElementById("au-" + id);
      if (!a.dataset.ready) { a.dataset.ready = 1; a.src = await signedUrl("recordings", a.dataset.path); }
      a.currentTime = toSec(t); await a.play();
    },
    like: async (id) => {
      const { data } = await sb.from("best_likes").select("best_id").eq("best_id", id).eq("user_id", S.me.id).maybeSingle();
      if (data) must(await sb.from("best_likes").delete().eq("best_id", id).eq("user_id", S.me.id));
      else must(await sb.from("best_likes").insert({ best_id: id, user_id: S.me.id }));
      await refresh();
    },
    hide: async (arg) => {
      const [id, h] = arg.split(":");
      must(await sb.from("best_practices").update({ hidden: h === "1" }).eq("id", id));
      toast(h === "1" ? "게시판에서 내렸어요" : "다시 올렸어요"); await refresh();
    },
  },
});
