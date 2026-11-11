// scope: public/app.js (with public/controller.js) run in a vm with a fake DOM and a fake clock, sampled at the middle of
// every phase over 2 cycles (12 samples/cycle, default 10x speed). Checks the #state readout text names, in words
// (red/yellow/green), the same state that each of the 4 lamp heads paints in color, for both axes, and that the
// readout element exists in index.html and is not hidden. Not covered: visual contrast/size of the text, screen-reader
// behaviour, and the clock-speed buttons (no DOM events fired).
import { test, expect } from 'bun:test';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(process.env.VERDICT_TARGET ?? path.join(__dirname, '..'), 'public');
const controllerSrc = fs.readFileSync(path.join(root, 'controller.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const FILL_TO_WORD: Record<string, string> = { '#FF5666': 'red', '#FFC24B': 'yellow', '#2FD184': 'green' };
const WORDS = ['red', 'yellow', 'green'];

function makeEl(tag: string) {
  const e: any = { tag, attrs: {} as Record<string, any>, textContent: '' };
  e.setAttribute = (k: string, v: any) => { e.attrs[k] = v; };
  e.getAttribute = (k: string) => e.attrs[k];
  e.appendChild = (c: any) => c;
  e.addEventListener = () => {};
  return e;
}

function boot() {
  const circles: any[] = [];
  const byId: Record<string, any> = { scene: makeEl('svg'), clock: makeEl('span'), state: makeEl('span') };
  const doc = {
    getElementById: (id: string) => byId[id],
    createElementNS: (_ns: string, tag: string) => { const e = makeEl(tag); if (tag === 'circle') circles.push(e); return e; },
    querySelectorAll: () => [],
  };
  let realNow = 1_000_000;
  let raf: any = null;
  const ctx: any = vm.createContext({
    document: doc,
    Date: { now: () => realNow },
    requestAnimationFrame: (cb: any) => { raf = cb; },
  });
  ctx.globalThis = ctx;
  vm.runInContext(controllerSrc, ctx, { filename: 'controller.js' });
  vm.runInContext(appSrc, ctx, { filename: 'app.js' });
  const CYCLE = ctx.TrafficController.CYCLE_MS;
  return {
    circles, state: byId.state, CYCLE,
    advanceRealMs(ms: number) { realNow += ms; const cb = raf; raf = null; cb(); },
  };
}

test('readout element is present in the page and not hidden', () => {
  expect(html).toMatch(/id="state"/);
  expect(html).not.toMatch(/id="state"[^>]*(hidden|display\s*:\s*none|aria-hidden)/);
  expect(html).not.toMatch(/\.state\s*\{[^}]*(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0)/);
});

test('readout names every lit lamp state in words, for both axes, at every phase', () => {
  const page = boot();
  expect(page.circles.length).toBe(12);
  // 6 phases from controller: 10000,3000,2000,10000,3000,2000 ms (virtual). Sample each phase midpoint.
  const phases = [10000, 3000, 2000, 10000, 3000, 2000];
  const seen = new Set<string>();
  let virtual = 0;
  let start = 0;
  const SPEED = 10;
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const len of phases) {
      const target = cycle * page.CYCLE + start + len / 2;
      page.advanceRealMs((target - virtual) / SPEED);
      virtual = target;
      start += len;
      if (start >= page.CYCLE) start -= page.CYCLE;

      const text: string = page.state.textContent;
      const m = /NS\W+(\w+)\W+EW\W+(\w+)/i.exec(text);
      expect(m, `readout "${text}" must say NS and EW states`).not.toBeNull();
      const [nsWord, ewWord] = [m![1].toLowerCase(), m![2].toLowerCase()];
      expect(WORDS).toContain(nsWord);
      expect(WORDS).toContain(ewWord);

      // lamps: circles 0-5 are the two NS heads, 6-11 the two EW heads; each head is red, yellow, green
      const lit = (head: number) => {
        const lamps = page.circles.slice(head * 3, head * 3 + 3).map((c: any) => FILL_TO_WORD[c.attrs.fill]);
        const on = lamps.filter(Boolean);
        expect(on.length).toBe(1);
        return on[0];
      };
      expect(lit(0)).toBe(nsWord);
      expect(lit(1)).toBe(nsWord);
      expect(lit(2)).toBe(ewWord);
      expect(lit(3)).toBe(ewWord);
      seen.add(`${nsWord}/${ewWord}`);
    }
  }
  // Some states were seen at all; which ones depends on the controller, and other laws judge the schedule.
  expect(seen.size).toBeGreaterThan(1);
});
