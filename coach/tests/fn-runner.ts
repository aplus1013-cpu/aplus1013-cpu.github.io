// 로컬 테스트: 실제 Edge Function 코드를 그대로 불러와 한 포트에서 실행
// deno run -A fn-runner.ts <port>
type H = (req: Request) => Response | Promise<Response>;
const handlers: Record<string, H> = {};
const realServe = Deno.serve;
let current = "";
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: any) => { handlers[current] = typeof h === "function" ? h : h.handler; return { finished: Promise.resolve(), shutdown() {} }; };
for (const name of ["staff-admin", "process-recording", "clova-callback", "evaluate", "extract-checklist"]) {
  current = name;
  await import(`../supabase/functions/${name}/index.ts`);
}
const port = Number(Deno.args[0] ?? 54399);
realServe({ port, hostname: "127.0.0.1", onListen: () => console.log(`fn-runner ready ${port}`) }, (req) => {
  const name = new URL(req.url).pathname.replace(/^\/functions\/v1\//, "").split("/")[0];
  const h = handlers[name];
  return h ? h(req) : new Response(JSON.stringify({ error: `no function ${name}` }), { status: 404 });
});
