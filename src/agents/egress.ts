// An HTTPS-only egress proxy for a sandboxed program that needs a few hosts
// and nothing else. It accepts `CONNECT host:443` for the allowed hosts and
// refuses everything else, including plain HTTP. It listens on 127.0.0.1 (the
// sandbox on macOS may reach that one port) and on a unix socket (for Linux,
// where the sandbox has its own network namespace and a forwarder inside it).
import { connect, createServer, type Server, type Socket } from "node:net";

export interface Egress {
  port: number;
  socketPath?: string;
  close(): Promise<void>;
}

// socketPath: also listen on this unix socket (needed on Linux only).
export async function startEgress(hosts: string[], socketPath?: string, ports = [443]): Promise<Egress> {
  const allowed = new Set(hosts.map((h) => h.toLowerCase()));
  const handle = (client: Socket) => {
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > 8192) client.destroy();
        return;
      }
      client.off("data", onData);
      const m = /^CONNECT ([^\s:]+):(\d+) HTTP\/1\.[01]\r\n/i.exec(head.subarray(0, end + 4).toString("latin1"));
      const host = m?.[1]?.toLowerCase();
      const port = Number(m?.[2]);
      if (!host || !allowed.has(host) || !ports.includes(port)) {
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const upstream = connect(port, host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = head.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      const drop = () => (client.destroy(), upstream.destroy());
      upstream.on("error", drop);
      client.on("error", drop);
      client.on("close", () => upstream.destroy());
    };
    client.on("data", onData);
    client.on("error", () => client.destroy());
  };
  const listen = (server: Server, ...args: unknown[]) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      (server.listen as (...a: unknown[]) => void)(...args, () => resolve());
    });
  const servers = [createServer(handle)];
  await listen(servers[0]!, 0, "127.0.0.1");
  if (socketPath) {
    servers.push(createServer(handle));
    await listen(servers[1]!, socketPath);
  }
  const port = (servers[0]!.address() as { port: number }).port;
  const shut = (s: Server) => new Promise<void>((r) => s.close(() => r()));
  return { port, socketPath, close: async () => void (await Promise.all(servers.map(shut))) };
}
