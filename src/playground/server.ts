// `verdict playground`: a local web UI and an MCP endpoint over one verdict repo.
// Localhost only. Every request needs the session token, and a Host or Origin
// that isn't this server's own is refused, so a web page can't drive it.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { callTool } from "../agent.ts";
import { errorMessage, inside } from "../fsx.ts";
import { readTools } from "../tools.ts";
// With { type: "file" } each import is the file's path (embedded when
// compiled); TypeScript types the .html and .js ones as modules.
import indexHtml from "./ui/index.html" with { type: "file" };
// oxlint-disable-next-line import/default -- a file import is its path, not the module
import appJs from "./ui/app.js" with { type: "file" };
import styleCss from "./ui/style.css" with { type: "file" };
import { Events } from "./events.ts";
import { handleMcp } from "./mcp.ts";
import { MANIFEST_FILE, loadManifest } from "./manifest.ts";
import { LAWS_FILE, newState, playgroundTools, type PlaygroundState } from "./tools.ts";
import { lawViews, tally } from "./view.ts";
import { MAIN, codePath, hasVersion, versionList } from "./versions.ts";

// Imported as files so `bun build --compile` embeds them in the executable.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- with { type: "file" } each is a path
const ASSETS: Record<string, string> = { "/": indexHtml as unknown as string, "/app.js": appJs as unknown as string, "/style.css": styleCss };
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };

export interface Playground {
  url: string; // the UI, with its token
  mcpUrl: string; // the first playground's MCP endpoint
  mcpUrls: Record<string, string>; // one per playground
  ids: string[];
  token: string;
  events: Events;
  stop(): Promise<void>;
}

export function tokenOk(given: string | null, token: string): boolean {
  if (!given || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

// null when the request may proceed, else the refusal.
export function refuse(req: Request, port: number, token: string, needsToken: boolean, allowNullOrigin = false): Response | null {
  const url = new URL(req.url);
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.get("host") ?? "")) return new Response("bad Host header: open the playground at the URL verdict printed", { status: 403 });
  const origin = req.headers.get("origin");
  if (origin && !(allowNullOrigin && origin === "null") && !hosts.some((h) => origin === `http://${h}`)) return new Response("bad Origin: this playground only talks to its own page", { status: 403 });
  if (needsToken) {
    const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
    const given = bearer ?? req.headers.get("x-playground-token") ?? url.searchParams.get("token");
    if (!tokenOk(given, token)) return new Response("missing or wrong token: use the URL verdict printed", { status: 401 });
  }
  return null;
}

const json = (v: unknown, status = 200) => Response.json(v, { status });
const nothing = (): void => undefined;

interface Instance {
  id: string;
  root: string;
  state: PlaygroundState;
  events: Events;
  tools: ReturnType<typeof playgroundTools>;
  read: ReturnType<typeof readTools>;
}

// A folder is a playground when it has a PLAYGROUND.json, or a hub of them when
// its subfolders do. Returns the playgrounds' folders, a hub's in name order.
export function discoverPlaygrounds(dir: string): string[] {
  if (existsSync(join(dir, MANIFEST_FILE))) return [dir];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .toSorted()
    .map((n) => join(dir, n))
    .filter((d) => statSync(d).isDirectory() && existsSync(join(d, MANIFEST_FILE)));
}

export async function startPlayground(target: string, opts: { port?: number; token?: string } = {}): Promise<Playground> {
  const roots = discoverPlaygrounds(target);
  if (roots.length === 0) loadManifest(target); // throws a message that says what to fix
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const instances = new Map<string, Instance>();
  for (const root of roots) {
    loadManifest(root); // fail early, with a message that says what to fix
    let id = basename(root);
    while (instances.has(id)) id += "-2";
    const events = new Events();
    const state = newState();
    state.onProgress = () => events.ping("progress");
    instances.set(id, { id, root, state, events, tools: playgroundTools(root, state, (l) => events.add("server", "plan", l)), read: readTools(root) });
  }
  const first = [...instances.values()][0]!;
  let busy: Promise<unknown> = Promise.resolve();
  // check and plan write the lock and run code: one at a time.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = busy.then(fn, fn);
    busy = next.catch(() => {});
    return next;
  };
  const pick = (url: URL): Instance | null => (url.searchParams.has("p") ? instances.get(url.searchParams.get("p")!) ?? null : first);

  // The program the agent builds, served from public/ of a version. It is the
  // agent's code, so it is untrusted: the page puts it in a sandboxed iframe
  // (opaque origin, no access to this API), and the CSP below stops it from
  // fetching or embedding anything but its own files. The token rides in the
  // path because an iframe can't send headers; the page's Origin is "null", so
  // only Host is checked here.
  const preview = (req: Request, port: number, inst: Instance, version: string, given: string | undefined, rel: string): Response => {
    if (req.method !== "GET") return new Response("preview is read-only", { status: 405 });
    const bad = refuse(req, port, token, false, true);
    if (bad) return bad;
    if (!tokenOk(given ?? null, token)) return new Response("missing or wrong token: use the URL verdict printed", { status: 401 });
    try {
      if (!hasVersion(inst.root, loadManifest(inst.root), version)) return new Response(`there is no version "${version}"`, { status: 404 });
      const dir = codePath(inst.root, version, "public");
      if (!existsSync(dir)) return new Response("nothing in public/ yet: the agent writes the program there", { status: 404 });
      const file = rel || "index.html";
      const abs = inside(inst.root, join(dir, file), dir);
      if (!existsSync(abs) || !statSync(abs).isFile()) return new Response(`public/${file} does not exist`, { status: 404 });
      return new Response(Bun.file(abs), {
        headers: {
          "content-security-policy": "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        },
      });
    } catch (err) {
      return new Response(errorMessage(err), { status: 400 });
    }
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    idleTimeout: 0, // SSE and long plans
    async fetch(req) {
      const url = new URL(req.url);
      const port: number = server.port ?? 0;
      const asset = ASSETS[url.pathname];
      if (asset) {
        // The page itself carries no secrets; the token is checked on / so the
        // URL is the only way in, and the assets it loads are public.
        const bad = refuse(req, port, token, url.pathname === "/");
        if (bad) return bad;
        const ext = asset.split(".").pop()!;
        return new Response(Bun.file(asset), { headers: { "content-type": TYPES[ext]!, "cache-control": "no-store" } });
      }
      // /preview/<token>/<file>: the first playground's main version.
      // /pv/<token>/<playground>/<version>/<file>: any of them.
      if (url.pathname.startsWith("/preview/")) {
        const [, , given, ...parts] = url.pathname.split("/");
        return preview(req, port, first, MAIN, given, decodeURIComponent(parts.join("/")));
      }
      if (url.pathname.startsWith("/pv/")) {
        const [, , given, id, version, ...parts] = url.pathname.split("/");
        const inst = instances.get(id ?? "");
        if (!inst) return new Response(`there is no playground "${id}"`, { status: 404 });
        return preview(req, port, inst, version ?? MAIN, given, decodeURIComponent(parts.join("/")));
      }
      const bad = refuse(req, port, token, true);
      if (bad) return bad;

      if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
        const inst = url.pathname === "/mcp" ? first : instances.get(url.pathname.slice(5));
        if (!inst) return new Response(`there is no playground "${url.pathname.slice(5)}": use one of ${[...instances.keys()].join(", ")}`, { status: 404 });
        return handleMcp(req, inst.tools, inst.events);
      }

      const inst = pick(url);
      if (!inst) return new Response(`there is no playground "${url.searchParams.get("p")}": use one of ${[...instances.keys()].join(", ")}`, { status: 404 });
      const manifest = () => loadManifest(inst.root);

      if (url.pathname === "/api/state" && req.method === "GET") {
        const m = manifest();
        const versions = versionList(inst.root, m);
        const v = url.searchParams.get("v") ?? MAIN;
        if (!versions.some((x) => x.id === v)) return new Response(`there is no version "${v}": use one of ${versions.map((x) => x.id).join(", ")}`, { status: 404 });
        const files = await callTool(inst.read.list_files, {});
        const lawsFile = join(inst.root, LAWS_FILE);
        return json({
          id: inst.id,
          playgrounds: [...instances.values()].map((i) => {
            try {
              const pm = loadManifest(i.root);
              return { id: i.id, title: pm.title, idea: pm.idea };
            } catch {
              return { id: i.id, title: i.id, idea: "its PLAYGROUND.json has a problem: run verdict playground validate" };
            }
          }),
          manifest: m,
          version: v,
          versions: versions.map((x) => ({ ...x, tally: tally(inst.state.byVersion[x.id] ?? null) })),
          lawsMarkdown: existsSync(lawsFile) ? readFileSync(lawsFile, "utf8") : "",
          checking: v in inst.state.running,
          laws: lawViews(inst.root, inst.state.byVersion[v] ?? null, inst.state.running[v]),
          files: files.isError ? [] : files.text.split("\n").filter((f) => f && f !== "(no files)"),
          activity: inst.events.recent(),
        });
      }
      if (url.pathname === "/api/file" && req.method === "GET") {
        const path = url.searchParams.get("path") ?? "";
        const r = await callTool(inst.read.read_file, { path });
        return r.isError ? new Response(r.text, { status: 400 }) : new Response(r.text, { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (url.pathname === "/api/laws" && req.method === "PUT") {
        const body = z.object({ markdown: z.string() }).safeParse(await req.json().catch(() => null));
        if (!body.success) return new Response("send {markdown: string}", { status: 400 });
        const r = await callTool(inst.tools.write_laws!, body.data);
        inst.events.add("ui", "write_laws", r.text, r.isError);
        return r.isError ? new Response(r.text, { status: 400 }) : json({ ok: true, message: r.text });
      }
      if (url.pathname === "/api/check" && req.method === "POST") {
        // ?v=<version>, or ?v=all to run the laws on every version, one after another
        const want = url.searchParams.get("v") ?? MAIN;
        const ids = want === "all" ? versionList(inst.root, manifest()).map((x) => x.id) : [want];
        const out: string[] = [];
        for (const v of ids) {
          inst.events.add("ui", "check", `started${ids.length > 1 || v !== MAIN ? ` on ${v}` : ""}`);
          const r = await serial(() => callTool(inst.tools.check!, { version: v }));
          inst.events.add("ui", "check", r.text.split("\n").find((l) => /^(PASS|FAIL|INCONC|NOT PLANNED)/.test(l)) ?? r.text.split("\n")[0] ?? "", r.isError);
          if (r.isError) return new Response(r.text, { status: 500 });
          out.push(r.text);
        }
        return json({ text: out.join("\n\n") });
      }
      if (url.pathname === "/api/plan" && req.method === "POST") {
        inst.events.add("ui", "plan", "started");
        const r = await serial(() => callTool(inst.tools.plan!, {}));
        inst.events.add("ui", "plan", r.text.split("\n")[0] ?? "", r.isError);
        return r.isError ? new Response(r.text, { status: 500 }) : json({ text: r.text });
      }
      if (url.pathname === "/api/events" && req.method === "GET") {
        let off = nothing;
        const stream = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            const send = (a: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(a)}\n\n`));
            send({ id: 0, at: new Date().toISOString(), source: "server", tool: "connected", summary: "live", isError: false });
            off = inst.events.subscribe(send);
          },
          cancel: () => off(),
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const origin = `http://127.0.0.1:${server.port}`;
  const mcpUrls = Object.fromEntries([...instances.keys()].map((id) => [id, `${origin}/mcp/${id}?token=${token}`]));
  return {
    url: `${origin}/?token=${token}`,
    mcpUrl: `${origin}/mcp?token=${token}`,
    mcpUrls,
    ids: [...instances.keys()],
    token,
    events: first.events,
    stop: async () => {
      await server.stop(true);
    },
  };
}

// Used by the CLI to tell the user where the playground is.
export function describe(p: Playground): string {
  const many = p.ids.length > 1;
  return [
    `${many ? `${p.ids.length} playgrounds (${p.ids.join(", ")})\n` : ""}playground:  ${p.url}`,
    ``,
    `connect your agent (Claude Code)${many ? ", one per playground" : ""}:`,
    ...p.ids.map((id) => `  claude mcp add --transport http ${many ? `playground-${id}` : "playground"} ${p.mcpUrls[id]}`),
    ``,
    `other MCP agents: streamable HTTP at ${p.mcpUrl.split("?")[0]} with header "Authorization: Bearer ${p.token}"`,
  ].join("\n");
}
