import { expect, test } from "bun:test";
import { parseLaws } from "../src/laws.ts";

const md = `# Laws

Some prose that isn't a law.

- Money is never a float; amounts are integer cents.
- No order is charged twice, even if the payment
  provider times out or the user retries.
  Retries reuse the original idempotency key.
* Error messages tell the user what to do next.
`;

test("one top-level bullet is one law; indented lines continue it", () => {
  expect(parseLaws(md).map((l) => l.text)).toEqual([
    "Money is never a float; amounts are integer cents.",
    "No order is charged twice, even if the payment provider times out or the user retries. Retries reuse the original idempotency key.",
    "Error messages tell the user what to do next.",
  ]);
});

test("re-wrapping a law keeps its hash; editing its words changes it", () => {
  const [a] = parseLaws("- No order is charged\n  twice.");
  const [b] = parseLaws("- No order is   charged twice.");
  const [c] = parseLaws("- No order is ever charged twice.");
  expect(a!.hash).toBe(b!.hash);
  expect(a!.hash).not.toBe(c!.hash);
});

test("a non-indented line ends a law", () => {
  expect(parseLaws("- one\nnot part of it\n  nor this").map((l) => l.text)).toEqual(["one"]);
});
