import { loadPlugin } from "@pixelworld/generators";
import type { FromWorker, LoadPluginsMessage, ToWorker } from "./protocol";

/** What bakes (BakeHost), as the loop sees it. */
export interface BakeHandler {
  handle(msg: ToWorker): void;
}

export interface WorkerLoopOptions {
  /** Imports a plugin's module (default `import()`); tests give their own. */
  importPlugin?: (url: string) => Promise<unknown>;
}

/**
 * The bake worker's message handler (bake.worker.ts). `loadPlugins` imports
 * each plugin's module in order and registers it in this worker's generator
 * registry (D-071); every message that arrives meanwhile waits for it, so no
 * bake runs without the generators it needs. Everything else goes to the host,
 * or, with no host (no WebGL2 here), gets an error back.
 */
export function bakeWorkerLoop(
  host: BakeHandler | null,
  post: (msg: FromWorker, transfer?: Transferable[]) => void,
  opts: WorkerLoopOptions = {},
): (msg: ToWorker) => void {
  let loading = false;
  const waiting: ToWorker[] = [];

  const run = (msg: ToWorker): void => {
    if (msg.type === "loadPlugins") {
      loading = true;
      void loadAll(msg).finally(() => {
        loading = false;
        while (!loading && waiting.length) run(waiting.shift()!);
      });
      return;
    }
    if (!host) {
      post({ type: "error", id: "id" in msg ? msg.id : undefined, message: "worker has no WebGL2" });
      return;
    }
    host.handle(msg);
  };

  const loadAll = async (msg: LoadPluginsMessage): Promise<void> => {
    try {
      const plugins = [];
      for (const ref of msg.plugins) plugins.push(await loadPlugin(ref, opts.importPlugin));
      post({ type: "pluginsLoaded", id: msg.id, plugins });
    } catch (e) {
      post({ type: "error", id: msg.id, message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (msg) => {
    if (loading) waiting.push(msg);
    else run(msg);
  };
}
