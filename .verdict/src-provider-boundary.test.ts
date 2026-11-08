// scope: every .ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts file under src/ (symlinks skipped), except src/agents/** and src/models.ts; flags agent or provider packages, the ai SDK (except { experimental_decide } in src/enforcers.ts, which must take its model from decisionModel()), relative imports into src/agents/ (only src/agent.ts, the runAgent() gateway, may import them), non-literal import()/require(), SDK calls like generateText or createAgentSession, claude/codex/pi and similar CLIs spawned or located by literal name, provider hosts and provider key or base-URL env reads, and network calls (fetch, WebSocket, Bun.connect, http/https/undici/axios); static text only, so a route reached through a computed name or a binary held in a variable is caught only where it shows as a bare fetch, Bun[...], or a non-literal import; files outside src/ (tests, .verdict/) are not covered; runs no agent or provider, so a pass means the code's text has no route to one, not that none exists at runtime

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { extname, join, posix, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const LOADER: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx",
  ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx",
};

// The only files that may talk to a coding agent or a model provider.
const isAllowed = (p: string) => p === "src/models.ts" || p.startsWith("src/agents/");
// runAgent() lives here. It picks an adapter from src/agents/ and nothing else may import one.
const GATEWAY = "src/agent.ts";
// The one non-allowed file that calls the ai SDK, always with decisionModel().
const DECISION_FILE = "src/enforcers.ts";

const PROVIDER_PREFIXES = [
  "@anthropic-ai/", "@earendil-works/", "@ai-sdk/", "@openai/", "@mistralai/", "@langchain/",
  "@mastra/", "@openrouter/", "@huggingface/", "@cohere-ai/", "@google/genai", "@google/generative-ai",
  "@aws-sdk/client-bedrock", "@azure/openai",
];
const PROVIDER_PACKAGES = new Set(["openai", "cohere-ai", "groq-sdk", "ollama", "replicate", "langchain", "llamaindex", "together-ai"]);
const NETWORK_MODULES = new Set([
  "http", "https", "http2", "tls", "net", "dgram", "undici", "node-fetch", "axios", "got", "ws", "superagent",
  "node:http", "node:https", "node:http2", "node:tls", "node:net", "node:dgram",
]);
const isProviderPackage = (spec: string) => PROVIDER_PACKAGES.has(spec) || PROVIDER_PREFIXES.some((p) => spec.startsWith(p));

const AGENT_BIN = "(?:claude|codex|pi|gemini|aider|opencode|cursor-agent|amp)";
const SDK_NAMES = [
  "generateText", "streamText", "generateObject", "streamObject", "experimental_generateImage",
  "experimental_generateSpeech", "experimental_transcribe", "createAnthropic", "createOpenAI",
  "createGoogleGenerativeAI", "createGateway", "createAgentSession", "createSdkMcpServer", "ModelRuntime",
  "typeSafeAi", "languageModel", "textEmbeddingModel", "getModel",
];

// Each rule runs on the code with comments and types removed; strings are kept.
const RULES: { name: string; re: RegExp }[] = [
  { name: "SDK call outside src/agents/ and src/models.ts", re: new RegExp(`\\b(${SDK_NAMES.join("|")})\\b`, "g") },
  { name: "gateway member access", re: /\bgateway\s*\./g },
  { name: "agent CLI spawned by literal name", re: new RegExp(String.raw`\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|execa)\s*\(\s*\[?\s*["'\`]${AGENT_BIN}["'\`]`, "g") },
  { name: "agent CLI run as a shell template", re: new RegExp(String.raw`\$\`\s*${AGENT_BIN}\b`, "g") },
  { name: "agent CLI located by literal name", re: new RegExp(String.raw`\bwhich\s*\([^)]*["'\`]${AGENT_BIN}["'\`]`, "g") },
  {
    name: "provider host",
    re: /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|bedrock-runtime\.|api\.mistral\.ai|api\.groq\.com|openrouter\.ai|ai-gateway\.vercel\.sh/g,
  },
  {
    name: "provider key or base URL read",
    re: /process\.env(?:\.|\[\s*["'`])(?:ANTHROPIC|OPENAI|AI_GATEWAY|TYPESAFE_AI|GOOGLE_GENERATIVE_AI|MISTRAL|GROQ)_(?:API_KEY|BASE_URL|AUTH_TOKEN)\b/g,
  },
  { name: "network call", re: /\b(?:fetch|WebSocket|XMLHttpRequest)\b|\bBun\.(?:connect|udpSocket)\b/g },
  { name: "computed Bun or globalThis member", re: /\b(?:Bun|globalThis)\s*\[/g },
];

interface Scanned {
  path: string;
  imports: { path: string; kind: string }[];
  raw: string;
  code: string;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.isFile() && LOADER[extname(entry.name)]) out.push(relative(ROOT, full).split(sep).join("/"));
  }
  return out;
}

function scan(path: string): Scanned {
  // A shebang line is not valid to the transpiler; blank it out, keeping line numbers.
  const raw = readFileSync(join(ROOT, path), "utf8");
  const src = raw.startsWith("#!") ? "//" + raw.slice(2) : raw;
  const tr = new Bun.Transpiler({ loader: LOADER[extname(path)]! });
  return { path, imports: tr.scanImports(src), raw, code: tr.transformSync(src) };
}

// Named value imports from "ai". `import type` is skipped; `type X` inside braces is skipped too.
const AI_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']ai["']/g;

function violations(s: Scanned): string[] {
  const out: string[] = [];
  const add = (msg: string) => out.push(`${s.path}: ${msg}`);

  for (const imp of s.imports) {
    const spec = imp.path;
    if (spec.startsWith(".")) {
      const target = posix.normalize(posix.join(posix.dirname(s.path), spec));
      if ((target === "src/agents" || target.startsWith("src/agents/")) && s.path !== GATEWAY) {
        add(`imports ${spec} (${target}), a coding-agent adapter; go through runAgent()`);
      }
    } else if (isProviderPackage(spec)) {
      add(`imports ${spec}, a coding-agent or model-provider package`);
    } else if (NETWORK_MODULES.has(spec)) {
      add(`imports ${spec}, a network module`);
    }
  }

  const aiImports = s.imports.filter((i) => i.path === "ai").length;
  if (aiImports > 0) {
    const statements = [...s.raw.matchAll(AI_IMPORT)].filter((m) => !m[1]);
    const names = statements.flatMap((m) => m[2]!.split(",").map((n) => n.trim()).filter((n) => n && !n.startsWith("type ")));
    if (s.path !== DECISION_FILE) {
      add(`imports the ai SDK; only ${DECISION_FILE} may, for experimental_decide with decisionModel()`);
    } else {
      if (aiImports !== statements.length || names.some((n) => n !== "experimental_decide")) {
        add(`the ai SDK import must be exactly { experimental_decide }; found ${names.join(", ") || "a namespace, default or dynamic import"}`);
      }
      const calls = [...s.code.matchAll(/experimental_decide\s*\(/g)].length;
      const decided = [...s.code.matchAll(/experimental_decide\(\s*\{\s*model:\s*decisionModel\(/g)].length;
      if (calls !== decided) add(`experimental_decide must take its model from decisionModel(); ${calls - decided} call(s) do not`);
    }
  }
  if (s.path !== DECISION_FILE && /\bexperimental_decide\b/.test(s.code)) {
    add("mentions experimental_decide outside src/enforcers.ts");
  }

  for (const rule of RULES) {
    for (const m of s.code.matchAll(rule.re)) add(`${rule.name}: ${m[0]}`);
  }
  for (const m of s.code.matchAll(/\b(?:import|require)\s*\(\s*(?!["'])/g)) {
    add(`${m[0].trim()} with a computed name; the target can't be checked`);
  }
  return out;
}

const scanned = existsSync(SRC) ? sourceFiles(SRC).sort().map(scan) : [];
const found = scanned.flatMap((s) => (isAllowed(s.path) ? [] : violations(s)));

describe("within src/, only src/agents/ and src/models.ts reach a coding agent or model provider", () => {
  test("no other file in src/ does", () => {
    if (found.length > 0) {
      throw new Error(`${found.length} route(s) outside src/agents/ and src/models.ts:\n${found.join("\n")}`);
    }
  });

  test("the scan reads the files it should", () => {
    const paths = scanned.map((s) => s.path);
    expect(paths).toContain("src/agent.ts");
    expect(paths).toContain("src/enforcers.ts");
    expect(paths).toContain("src/models.ts");
    expect(paths).toContain("src/agents/claude-code.ts");
  });

  test("the scanner sees the sanctioned routes", () => {
    const byPath = new Map(scanned.map((s) => [s.path, s]));
    expect(byPath.get("src/agents/claude-code.ts")!.imports.map((i) => i.path)).toContain("@anthropic-ai/claude-agent-sdk");
    expect(byPath.get("src/agents/codex.ts")!.code).toMatch(/which\(\s*"codex"/);
    expect(byPath.get("src/models.ts")!.imports.map((i) => i.path)).toContain("@ai-sdk/typesafe-ai");
    expect(byPath.get("src/enforcers.ts")!.code).toMatch(/experimental_decide\(\s*\{\s*model:\s*decisionModel\(/);
    // The scanner's own rules fire on a known-bad snippet.
    const bad = scan("src/agent.ts");
    expect(bad.imports.some((i) => i.path.startsWith("./agents/"))).toBe(true);
  });

  test("the rules flag known-bad snippets", () => {
    const tr = new Bun.Transpiler({ loader: "ts" });
    const code = tr.transformSync(`Bun.spawn(["claude", "-p"]); fetch("x"); generateText({});`);
    const hits = RULES.filter((r) => [...code.matchAll(r.re)].length > 0).map((r) => r.name);
    expect(hits).toContain("agent CLI spawned by literal name");
    expect(hits).toContain("network call");
    expect(hits).toContain("SDK call outside src/agents/ and src/models.ts");
  });
});
