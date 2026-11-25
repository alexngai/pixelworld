import { generatePuzzle, solveFight, solveTurn, type Action, type Arena, type Combat, type PuzzleOptions } from "@pixelworlds/tactics";

/**
 * The game's solver worker (D-153): puzzles made, a fight's outlook and hints
 * worked out here, off the page, so it never stalls (a check can take a
 * second or two).
 */

export type Request =
  | { id: number; t: "generate"; arena: Arena; opts: PuzzleOptions }
  | { id: number; t: "outlook"; combat: Combat; rounds: number; acted: number[] }
  | { id: number; t: "hint"; combat: Combat; rounds: number; acted: number[] };

/** Can the fight still be held: to its end, only this round, or not even this round (or the search ran out)? */
export type Outlook = "fight" | "round" | "lost" | "unknown";

export interface Hint {
  plan: Action[];
  /** What it holds: the whole fight, this round only, or nothing (the least bad). */
  holds: "fight" | "round" | "best";
}

export type Response = { id: number; t: "progress"; tried: number; best: number | null } | { id: number; t: "done"; result: unknown };

const post = (r: Response) => (self as unknown as Worker).postMessage(r);

self.onmessage = async (e: MessageEvent<Request>) => {
  const q = e.data;
  if (q.t === "generate") {
    const puzzle = await generatePuzzle(q.arena, { ...q.opts, onProgress: (tried, best) => post({ id: q.id, t: "progress", tried, best }) });
    return post({ id: q.id, t: "done", result: puzzle });
  }
  const f = solveFight(q.combat, { rounds: q.rounds, acted: q.acted, maxNodes: q.t === "hint" ? 300_000 : 150_000 });
  const turn = f.winnable ? null : solveTurn(q.combat, { acted: q.acted, keep: 1, maxNodes: 100_000 });
  if (q.t === "outlook") {
    const outlook: Outlook = f.winnable ? (q.rounds > 1 ? "fight" : "round") : !f.complete ? "unknown" : turn!.perfect.length ? "round" : "lost";
    return post({ id: q.id, t: "done", result: outlook });
  }
  const hint: Hint | null = f.winnable
    ? { plan: f.line[0]!, holds: "fight" }
    : turn!.perfect[0]
      ? { plan: turn!.perfect[0].plan, holds: "round" }
      : (() => {
          const best = solveTurn(q.combat, { acted: q.acted, mode: "best", maxNodes: 100_000 }).best;
          return best ? { plan: best.plan, holds: "best" as const } : null;
        })();
  post({ id: q.id, t: "done", result: hint });
};
