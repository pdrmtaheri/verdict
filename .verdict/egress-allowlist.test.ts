// scope: startEgress() in src/agents/egress.ts, driven over its TCP port and (when unix sockets can be opened) its unix socket with raw bytes. Allowlist is host 127.0.0.1 + one port; counting servers observe whether the proxy ever opens an upstream connection. Covers ~40 hostile CONNECT/GET/other requests (wrong port, other host names for the same machine such as localhost/LOCALHOST/trailing dot/decimal/hex/short/IPv6 forms, odd casing, padding with spaces/tabs/CRLF/NUL, userinfo, absolute URIs, pipelined requests, smuggled second CONNECT inside a tunnel), each sent whole, one byte at a time, and split at every line. Real outbound hosts (DNS) are not used; the codex wiring in src/agents/codex.ts and the netns forwarder are not covered.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEgress } from "../src/agents/egress.ts";

const canUnix = (() => {
  const r = Bun.spawnSync([process.execPath, "-e", `require("net").createServer().listen(require("path").join(${JSON.stringify(tmpdir())}, "verdict-probe-" + process.pid + ".sock"), function () { this.close(); process.exit(0) }).on("error", () => process.exit(1))`]);
  return r.exitCode === 0;
})();

interface Counter { port: number; count: () => number; close: () => void }
// Counts every inbound connection. Tries dual-stack so localhost via ::1 is seen too.
async function counter(): Promise<Counter> {
  let n = 0;
  const mk = (): Server => createServer((c) => { n++; c.on("error", () => {}); c.pipe(c); });
  let s = mk();
  try {
    await new Promise<void>((res, rej) => { s.once("error", rej); s.listen(0, "::", () => res()); });
  } catch {
    s = mk();
    await new Promise<void>((res) => s.listen(0, "127.0.0.1", () => res()));
  }
  return { port: (s.address() as { port: number }).port, count: () => n, close: () => s.close() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Target = { port?: number; path?: string };
type Mode = "whole" | "bytes" | "lines";

async function send(target: Target, req: string, mode: Mode): Promise<string> {
  const c = target.path ? connect(target.path) : connect(target.port!, "127.0.0.1");
  let out = "";
  c.on("data", (d) => (out += d.toString("latin1")));
  c.on("error", () => {});
  await new Promise<void>((r) => c.once("connect", () => r()));
  const buf = Buffer.from(req, "latin1");
  const parts: Buffer[] =
    mode === "whole" ? [buf]
    : mode === "bytes" ? Array.from(buf, (b) => Buffer.from([b]))
    : req.split(/(?<=\n)/).map((l) => Buffer.from(l, "latin1"));
  for (const p of parts) {
    if (c.destroyed) break;
    c.write(p);
    if (mode !== "whole") await sleep(1);
  }
  await sleep(60);
  c.destroy();
  return out;
}

test("the egress proxy never opens an upstream connection outside its host+port allowlist", async () => {
  const allowedSrv = await counter(); // the allowed port, on the allowed host (and on every alias of this machine)
  const otherSrv = await counter(); // a port that is not allowed
  const P = allowedSrv.port;
  const Q = otherSrv.port;
  const dir = canUnix ? mkdtempSync(join(tmpdir(), "verdict-egress-allow-")) : undefined;
  const egress = await startEgress(["127.0.0.1"], dir ? join(dir, "e.sock") : undefined, [P]);
  const targets: Target[] = [{ port: egress.port }];
  if (canUnix) targets.push({ path: egress.socketPath });

  try {
    // Control: the harness can see an allowed connection, so a zero below means something.
    for (const t of targets) {
      const before = allowedSrv.count();
      const r = await send(t, `CONNECT 127.0.0.1:${P} HTTP/1.1\r\nHost: x\r\n\r\n`, "whole");
      expect(r).toContain("200 Connection Established");
      expect(allowedSrv.count()).toBe(before + 1);
    }

    const H = "127.0.0.1";
    const hostile: [string, string][] = [
      ["wrong port", `CONNECT ${H}:${Q} HTTP/1.1\r\n\r\n`],
      ["port 80", `CONNECT ${H}:80 HTTP/1.1\r\n\r\n`],
      ["port off by one", `CONNECT ${H}:${P + 1} HTTP/1.1\r\n\r\n`],
      ["port +65536", `CONNECT ${H}:${P + 65536} HTTP/1.1\r\n\r\n`],
      ["port with sign", `CONNECT ${H}:+${P} HTTP/1.1\r\n\r\n`],
      ["port with fraction", `CONNECT ${H}:${P}.0 HTTP/1.1\r\n\r\n`],
      ["port hex", `CONNECT ${H}:0x${P.toString(16)} HTTP/1.1\r\n\r\n`],
      ["port empty", `CONNECT ${H}: HTTP/1.1\r\n\r\n`],
      ["no port", `CONNECT ${H} HTTP/1.1\r\n\r\n`],
      ["two ports", `CONNECT ${H}:${P}:${Q} HTTP/1.1\r\n\r\n`],
      ["port list", `CONNECT ${H}:${P},${Q} HTTP/1.1\r\n\r\n`],
      ["localhost", `CONNECT localhost:${P} HTTP/1.1\r\n\r\n`],
      ["LOCALHOST", `CONNECT LOCALHOST:${P} HTTP/1.1\r\n\r\n`],
      ["LocalHost wrong port", `CONNECT LocalHost:${Q} HTTP/1.1\r\n\r\n`],
      ["trailing dot", `CONNECT ${H}.:${P} HTTP/1.1\r\n\r\n`],
      ["suffix", `CONNECT ${H}.evil.example:${P} HTTP/1.1\r\n\r\n`],
      ["prefix", `CONNECT x${H}:${P} HTTP/1.1\r\n\r\n`],
      ["leading zero octet", `CONNECT 0127.0.0.1:${P} HTTP/1.1\r\n\r\n`],
      ["short form", `CONNECT 127.1:${P} HTTP/1.1\r\n\r\n`],
      ["decimal", `CONNECT 2130706433:${P} HTTP/1.1\r\n\r\n`],
      ["hex", `CONNECT 0x7f000001:${P} HTTP/1.1\r\n\r\n`],
      ["zero addr", `CONNECT 0.0.0.0:${P} HTTP/1.1\r\n\r\n`],
      ["ipv6 loopback", `CONNECT [::1]:${P} HTTP/1.1\r\n\r\n`],
      ["ipv6 mapped", `CONNECT [::ffff:127.0.0.1]:${P} HTTP/1.1\r\n\r\n`],
      ["ipv6 bare", `CONNECT ::1:${P} HTTP/1.1\r\n\r\n`],
      ["userinfo", `CONNECT evil@${H}:${P} HTTP/1.1\r\n\r\n`],
      ["userinfo reversed", `CONNECT ${H}@evil.example:${P} HTTP/1.1\r\n\r\n`],
      ["lowercase method, other host", `connect localhost:${P} HTTP/1.1\r\n\r\n`],
      ["leading space", ` CONNECT localhost:${P} HTTP/1.1\r\n\r\n`],
      ["leading CRLF", `\r\nCONNECT localhost:${P} HTTP/1.1\r\n\r\n`],
      ["double space", `CONNECT  localhost:${P} HTTP/1.1\r\n\r\n`],
      ["tab", `CONNECT\tlocalhost:${P} HTTP/1.1\r\n\r\n`],
      ["NUL in host", `CONNECT ${H}\0.evil.example:${P} HTTP/1.1\r\n\r\n`],
      ["http scheme", `CONNECT http://localhost:${P}/ HTTP/1.1\r\n\r\n`],
      ["absolute-URI GET to allowed", `GET http://${H}:${P}/ HTTP/1.1\r\nHost: ${H}:${P}\r\n\r\n`],
      ["GET with Host header", `GET / HTTP/1.1\r\nHost: ${H}:${P}\r\n\r\n`],
      ["CONNECT in a header", `GET / HTTP/1.1\r\nX: a\r\nCONNECT ${H}:${P} HTTP/1.1\r\n\r\n`],
      ["bare LF terminator", `CONNECT localhost:${P} HTTP/1.1\n\n`],
      ["HTTP/2 version", `CONNECT localhost:${P} HTTP/2.0\r\n\r\n`],
      ["forbidden then allowed pipelined", `CONNECT localhost:${P} HTTP/1.1\r\n\r\nCONNECT ${H}:${P} HTTP/1.1\r\n\r\n`],
      ["allowed-looking Host header, bad target", `CONNECT localhost:${Q} HTTP/1.1\r\nHost: ${H}:${P}\r\n\r\n`],
    ];

    const failures: string[] = [];
    for (const t of targets) {
      for (const mode of ["whole", "bytes", "lines"] as Mode[]) {
        for (const [name, req] of hostile) {
          const a = allowedSrv.count();
          const o = otherSrv.count();
          await send(t, req, mode);
          const dA = allowedSrv.count() - a;
          const dO = otherSrv.count() - o;
          if (dA || dO) failures.push(`${t.path ? "unix" : "tcp"}/${mode}: ${name} opened ${dA + dO} upstream connection(s)`);
        }
      }
    }

    // Smuggling inside an established tunnel goes to the upstream as bytes, never as a new connection.
    for (const t of targets) {
      const a = allowedSrv.count();
      const o = otherSrv.count();
      await send(t, `CONNECT ${H}:${P} HTTP/1.1\r\n\r\nCONNECT ${H}:${Q} HTTP/1.1\r\n\r\n`, "whole");
      if (otherSrv.count() !== o) failures.push(`${t.path ? "unix" : "tcp"}: request tunnelled inside a tunnel reached the disallowed port`);
      if (allowedSrv.count() !== a + 1) failures.push(`${t.path ? "unix" : "tcp"}: tunnel with trailing bytes opened ${allowedSrv.count() - a} connections, wanted 1`);
    }

    expect(failures).toEqual([]);
  } finally {
    await egress.close();
    allowedSrv.close();
    otherSrv.close();
  }
}, 180_000);
