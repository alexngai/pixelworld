#!/usr/bin/env node
/**
 * Runs the benchmark page (apps/web/bench.html) in Chromium without a window
 * and writes its report. By default Chromium renders in software
 * (SwiftShader), as the e2e tests do: the numbers are a software baseline.
 * With --gpu it asks for the machine's GPU instead (whether a headless
 * Chromium gets one depends on the system; the report's GPU line says which
 * renderer ran). For desktop GPU numbers, `pnpm bench` and the page in your
 * own browser are the surest way.
 *
 *   node tools/bench.mjs                              all cases, software rendering
 *   node tools/bench.mjs --gpu --headed               a visible window on the system GPU
 *   options: --cases sw-drive,sf-walk  --size 1280x720  --out report.json  --url <running dev server>
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SWIFTSHADER = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const GPU = ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--enable-zero-copy"];

export function args(argv) {
  const out = { gpu: false, headed: false, cases: null, size: "1280x720", out: null, url: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--gpu") out.gpu = true;
    else if (a === "--headed") out.headed = true;
    else if (a === "--cases") out.cases = argv[++i];
    else if (a === "--size") out.size = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!/^\d+x\d+$/.test(out.size)) throw new Error(`--size must be WxH, not ${out.size}`);
  return out;
}

/** The bench page's address for these options. */
export function benchUrl(base, opt) {
  const [w, h] = opt.size.split("x");
  const q = new URLSearchParams({ auto: "1", w, h });
  if (opt.cases) q.set("cases", opt.cases);
  return `${base}/bench.html?${q}`;
}

async function devServer(url) {
  if (url) return { url, stop: () => {} };
  const port = 5196;
  const child = spawn("pnpm", ["--filter", "@pixelworld/web", "exec", "vite", "--port", String(port), "--strictPort"], {
    cwd: REPO,
    stdio: "ignore",
    detached: true,
  });
  const base = `http://localhost:${port}`;
  for (let t = 0; t < 120; t++) {
    try {
      if ((await fetch(base)).ok) return { url: base, stop: () => process.kill(-child.pid) };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  process.kill(-child.pid);
  throw new Error("dev server did not start");
}

async function main() {
  const opt = args(process.argv.slice(2));
  const [w, h] = opt.size.split("x").map(Number);
  const server = await devServer(opt.url);
  const browser = await chromium.launch({ headless: !opt.headed, args: opt.gpu ? GPU : SWIFTSHADER });
  try {
    const page = await browser.newPage({ viewport: { width: w + 64, height: h + 400 } });
    page.on("pageerror", (e) => console.error("page error:", String(e)));
    await page.goto(benchUrl(server.url, opt));
    let last = "";
    for (;;) {
      const s = await page.evaluate(() => window.__bench && { status: window.__bench.status, done: !!window.__bench.report, error: window.__bench.error });
      if (s && s.status !== last) {
        console.error(s.status);
        last = s.status;
      }
      if (s?.error) throw new Error(s.error);
      if (s?.done) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const report = await page.evaluate(() => window.__bench.report);
    const text = await page.evaluate(() => document.getElementById("text").textContent);
    if (opt.out) {
      writeFileSync(opt.out, JSON.stringify(report, null, 1) + "\n");
      writeFileSync(opt.out.replace(/\.json$/, "") + ".txt", text + "\n");
    }
    console.log(text);
    return report.cases.some((c) => c.error) ? 1 : 0;
  } finally {
    await browser.close();
    server.stop();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
