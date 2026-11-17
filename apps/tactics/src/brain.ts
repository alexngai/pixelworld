import type { Arena, Combat, Puzzle, PuzzleOptions } from "@pixelworlds/tactics";
import type { Hint, Outlook, Request, Response } from "./worker";

type Ask = Request extends infer R ? (R extends Request ? Omit<R, "id"> : never) : never;

/** The page's side of the solver worker: each request a promise; a newer outlook makes an older one moot. */
export class Brain {
  private readonly worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private next = 1;
  private readonly pending = new Map<number, { done: (r: unknown) => void; progress?: (tried: number, best: number | null) => void }>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<Response>) => {
      const r = e.data;
      const p = this.pending.get(r.id);
      if (!p) return;
      if (r.t === "progress") return p.progress?.(r.tried, r.best);
      this.pending.delete(r.id);
      p.done(r.result);
    };
  }

  private ask<T>(q: Ask, progress?: (tried: number, best: number | null) => void): Promise<T> {
    const id = this.next++;
    return new Promise<T>((done) => {
      this.pending.set(id, { done: done as (r: unknown) => void, ...(progress ? { progress } : {}) });
      this.worker.postMessage({ ...q, id } as Request);
    });
  }

  generate(arena: Arena, opts: PuzzleOptions, progress?: (tried: number, best: number | null) => void): Promise<Puzzle | null> {
    return this.ask({ t: "generate", arena, opts }, progress);
  }

  outlook(combat: Combat, rounds: number, acted: number[]): Promise<Outlook> {
    return this.ask({ t: "outlook", combat, rounds, acted });
  }

  hint(combat: Combat, rounds: number, acted: number[]): Promise<Hint | null> {
    return this.ask({ t: "hint", combat, rounds, acted });
  }
}
