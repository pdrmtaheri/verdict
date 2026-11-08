// VERDICT.md: one top-level bullet is one law. Indented lines continue it.
// Anything else (headings, prose) is ignored.

export interface Law {
  text: string; // whitespace-normalised
  hash: string;
}

const BULLET = /^[-*+]\s+(.*)$/;

export function parseLaws(markdown: string): Law[] {
  const laws: string[][] = [];
  let current: string[] | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const bullet = BULLET.exec(line);
    if (bullet) {
      current = [bullet[1]!];
      laws.push(current);
    } else if (current && /^\s+\S/.test(line)) {
      current.push(line);
    } else if (line.trim() !== "") {
      current = null; // a non-indented, non-bullet line ends the law
    }
  }
  return laws.map((lines) => {
    const text = normalise(lines.join(" "));
    return { text, hash: hashLaw(text) };
  });
}

export function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function hashLaw(text: string): string {
  return new Bun.CryptoHasher("sha256").update(normalise(text)).digest("hex").slice(0, 8);
}
