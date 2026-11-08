// A small in-memory activity log with subscribers, for the UI's live feed.
export interface Activity {
  id: number;
  at: string;
  source: "agent" | "ui" | "server";
  tool: string;
  summary: string;
  isError: boolean;
}

export class Events {
  private items: Activity[] = [];
  private subs = new Set<(a: Activity) => void>();
  private next = 1;

  add(source: Activity["source"], tool: string, summary: string, isError = false): Activity {
    const a: Activity = { id: this.next++, at: new Date().toISOString(), source, tool, summary: summary.slice(0, 500), isError };
    this.items.push(a);
    if (this.items.length > 500) this.items.shift();
    for (const s of this.subs) s(a);
    return a;
  }
  recent(): Activity[] {
    return this.items.slice(-100);
  }
  subscribe(fn: (a: Activity) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}
