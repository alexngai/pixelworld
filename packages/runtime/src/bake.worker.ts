import { BakeHost } from "./bakeHost";
import type { FromWorker, ToWorker } from "./protocol";
import { bakeWorkerLoop } from "./workerLoop";

/** The parts of DedicatedWorkerGlobalScope we use (the webworker lib clashes with DOM). */
interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
}
const scope = self as unknown as WorkerScope;
const post = (msg: FromWorker, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

let host: BakeHost | null = null;
try {
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext("webgl2", { antialias: false, depth: false, alpha: false });
  if (!gl) throw new Error("WebGL2 unavailable in worker");
  host = new BakeHost(gl, post);
} catch (e) {
  post({ type: "error", message: `worker-init: ${String(e)}` });
}

// plugins (loadPlugins) are imported before anything else is handled
const handle = bakeWorkerLoop(host, post);
scope.onmessage = (ev: MessageEvent<ToWorker>) => handle(ev.data);
