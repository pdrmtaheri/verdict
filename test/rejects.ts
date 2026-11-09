import { expect } from "bun:test";

// `expect(p).rejects.toThrow()` is typed `void` by bun's types but returns a promise that must be awaited.
export async function rejectsWith(p: Promise<unknown>, message?: string): Promise<void> {
  await (expect(p).rejects.toThrow(message) as unknown as Promise<void>);
}
