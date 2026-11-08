import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { startEgress } from "../src/egress.ts";
import { macProfile } from "../src/sandbox.ts";

const dir = () => mkdtempSync(join(process.env.TMPDIR!, "verdict-egress-"));

// Unix sockets can't be opened when the tests run in some sandboxes; the
// Linux-only socket path is then skipped.
const canUnix = (() => {
  const r = Bun.spawnSync([process.execPath, "-e", `require("net").createServer().listen(require("path").join(${JSON.stringify(process.env.TMPDIR ?? "/tmp")}, "verdict-probe-" + process.pid + ".sock"), function () { this.close(); process.exit(0) }).on("error", () => process.exit(1))`]);
  return r.exitCode === 0;
})();

// An upstream that echoes what it receives, standing in for an allowed host.
async function echoServer(): Promise<{ port: number; close: () => void }> {
  const s = createServer((c) => c.pipe(c));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return { port: (s.address() as { port: number }).port, close: () => s.close() };
}

function talk(target: { port?: number; path?: string }, request: string, then = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = target.path ? connect(target.path) : connect(target.port!, "127.0.0.1");
    let out = "";
    c.on("data", (d) => {
      out += d.toString();
      if (out.includes("\r\n\r\n") && then && !out.includes(then)) c.write(then);
      if (!then || out.includes(then) || out.startsWith("HTTP/1.1 403")) c.end();
    });
    c.on("close", () => resolve(out));
    c.on("error", reject);
    c.write(request);
  });
}

test("the egress proxy tunnels only to allowed hosts and ports, and refuses plain HTTP", async () => {
  const echo = await echoServer();
  const egress = await startEgress(["127.0.0.1"], canUnix ? join(dir(), "e.sock") : undefined, [echo.port]);
  try {
    const ok = await talk({ port: egress.port }, `CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: x\r\n\r\n`, "ping");
    expect(ok).toContain("200 Connection Established");
    expect(ok).toContain("ping");
    expect(await talk({ port: egress.port }, "CONNECT evil.example:443 HTTP/1.1\r\n\r\n")).toContain("403");
    expect(await talk({ port: egress.port }, `CONNECT 127.0.0.1:${echo.port + 1} HTTP/1.1\r\n\r\n`)).toContain("403");
    expect(await talk({ port: egress.port }, "GET http://evil.example/ HTTP/1.1\r\n\r\n")).toContain("403");
    // The unix socket (used from inside a Linux network namespace) has the same rules.
    if (canUnix) expect(await talk({ path: egress.socketPath }, "CONNECT evil.example:443 HTTP/1.1\r\n\r\n")).toContain("403");
  } finally {
    await egress.close();
    echo.close();
  }
});

test.skipIf(!canUnix)("the forwarder carries a connection from its port to the proxy's unix socket", async () => {
  const echo = await echoServer();
  const egress = await startEgress(["127.0.0.1"], join(dir(), "e.sock"), [echo.port]);
  const fwdPort = 20000 + Math.floor(Math.random() * 20000);
  const client = `const s=require("net").connect(${fwdPort},"127.0.0.1");let o="";s.on("data",d=>{o+=d;if(o.includes("\\r\\n\\r\\n")&&!o.includes("ping"))s.write("ping");if(o.includes("ping")){console.log(o);s.end()}});s.write("CONNECT 127.0.0.1:${echo.port} HTTP/1.1\\r\\n\\r\\n")`;
  try {
    const p = Bun.spawn([process.execPath, "src/agents/netns-forward.ts", egress.socketPath!, String(fwdPort), "--", process.execPath, "-e", client], { stdout: "pipe" });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(out).toContain("200 Connection Established");
    expect(out).toContain("ping");
  } finally {
    await egress.close();
    echo.close();
  }
});

test("Codex's sandbox may reach only the proxy's localhost port", () => {
  const p = macProfile({ readable: [], writable: [], network: false, localhostPorts: [4321] }, "/Users/me");
  expect(p).toContain('(allow network-outbound (remote ip "localhost:4321"))');
  expect(p).not.toContain('"localhost:*"');
  expect(p).toContain("(deny network*)");
});
