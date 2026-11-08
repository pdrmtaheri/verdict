// Runs inside a Linux sandbox that has its own network namespace: listens on
// 127.0.0.1:<port> there and forwards each connection to the egress proxy's
// unix socket outside, then runs the given command and exits with its code.
// Usage: bun netns-forward.ts <socket> <port> -- <command...>
import { connect, createServer } from "node:net";

const [socketPath, port, sep, ...command] = process.argv.slice(2);
if (!socketPath || !port || sep !== "--" || command.length === 0) {
  console.error("usage: netns-forward.ts <socket> <port> -- <command...>");
  process.exit(2);
}
const server = createServer((client) => {
  const upstream = connect(socketPath);
  client.pipe(upstream);
  upstream.pipe(client);
  const drop = () => (client.destroy(), upstream.destroy());
  client.on("error", drop);
  upstream.on("error", drop);
});
server.listen(Number(port), "127.0.0.1", async () => {
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exit(await child.exited);
});
