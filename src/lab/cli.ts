import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { DESIGNS, design } from "./designs.js";
import { BEGIN, END, markdown, sha256, summarise } from "./report.js";
import { runDesign, type RunResult } from "./run.js";
import { DEFAULT_WORLD } from "./world.js";

interface LabConfig {
  days: number;
  devSeeds: number[];
  heldoutSeeds: number[];
  smokeDays: number;
  threads: number;
}

const root = process.env.LAB_ROOT ?? process.cwd();
const config: LabConfig = JSON.parse(readFileSync(join(root, "config/lab.json"), "utf8"));

/** Runs every (design, seed) pair, spread over worker threads. */
async function runAll(seeds: number[], days: number): Promise<RunResult[]> {
  const jobs = seeds.flatMap((seed) => DESIGNS.map((d) => ({ design: d.name, seed })));
  const results: RunResult[] = [];
  const worker = fileURLToPath(new URL("./worker.js", import.meta.url));
  let next = 0;
  const lane = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const r = await new Promise<RunResult>((resolve, reject) => {
        const w = new Worker(worker, { workerData: { ...job, days } });
        w.once("message", resolve);
        w.once("error", reject);
      });
      console.log(`${r.design} seed ${r.seed}: ${r.orders} orders, duplicates ${r.duplicateExecutions}, manual resets ${r.manualResets}, lead p95 ${r.leadP95Min.toFixed(0)} min`);
      results.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.threads, jobs.length) }, lane));
  return results.sort((a, b) => a.seed - b.seed || DESIGNS.findIndex((d) => d.name === a.design) - DESIGNS.findIndex((d) => d.name === b.design));
}

function write(split: string, runs: RunResult[]): string {
  const dir = join(root, "reports");
  mkdirSync(dir, { recursive: true });
  const summary = summarise(split, runs);
  const json = JSON.stringify({ ...summary, runs }, null, 2) + "\n";
  writeFileSync(join(dir, `${split}.json`), json);
  writeFileSync(join(dir, `${split}.md`), markdown(summary));
  console.log(markdown(summary));
  return json;
}

function readmeBlock(md: string): void {
  const path = join(root, "README.md");
  const text = readFileSync(path, "utf8");
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a < 0 || b < a) throw new Error("README has no lab markers");
  writeFileSync(path, text.slice(0, a + BEGIN.length) + "\n" + md + text.slice(b));
}

export function check(dir: string): string[] {
  const problems: string[] = [];
  const json = join(dir, "reports/heldout.json");
  const md = join(dir, "reports/heldout.md");
  const lock = join(dir, "lab/heldout.lock");
  if (![json, md, lock].every(existsSync)) return ["held-out reports or lock missing"];
  const body = readFileSync(json, "utf8");
  if (!readFileSync(lock, "utf8").includes(`sha256 ${sha256(body)}`)) problems.push("reports/heldout.json does not match the hash in lab/heldout.lock");
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  const a = readme.indexOf(BEGIN);
  const b = readme.indexOf(END);
  if (a < 0 || b < a || readme.slice(a + BEGIN.length, b).trim() !== readFileSync(md, "utf8").trim()) problems.push("README results block differs from reports/heldout.md");
  const dash = join(dir, "dashboard/public/data/results.json");
  if (!existsSync(dash) || readFileSync(dash, "utf8") !== body) problems.push("dashboard/public/data/results.json differs from reports/heldout.json");
  return problems;
}

async function main() {
  const [cmd = "dev", ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "dev":
      write("dev", await runAll(config.devSeeds, config.days));
      return;
    case "heldout": {
      const lock = join(root, "lab/heldout.lock");
      const reason = rest.find((a) => a.startsWith("--reason="))?.slice(9);
      if (existsSync(lock) && !(rest.includes("--force") && reason)) {
        console.error(`held-out seeds already ran (${readFileSync(lock, "utf8").split("\n")[0]}). Tune on dev seeds; a re-run needs --force --reason=<ADR>.`);
        process.exit(2);
      }
      const previous = existsSync(lock) ? readFileSync(lock, "utf8").split("\n").filter((l) => l.startsWith("run ")).map((l) => `previous ${l}`) : [];
      const json = write("heldout", await runAll(config.heldoutSeeds, config.days));
      mkdirSync(join(root, "lab"), { recursive: true });
      writeFileSync(lock, [`run ${new Date().toISOString()}`, `sha256 ${sha256(json)}`, `seeds ${config.heldoutSeeds.join(",")}`, `days ${config.days}`, ...(reason ? [`rerun because ${reason}`] : []), ...previous].join("\n") + "\n");
      readmeBlock(readFileSync(join(root, "reports/heldout.md"), "utf8"));
      mkdirSync(join(root, "dashboard/public/data"), { recursive: true });
      writeFileSync(join(root, "dashboard/public/data/results.json"), json);
      return;
    }
    case "smoke": {
      const runs = DESIGNS.map((d) => runDesign(d, 7, { ...DEFAULT_WORLD, days: config.smokeDays }));
      const by = (n: string) => runs.find((r) => r.design === n)!;
      const orch = by("orchestrator");
      const p2p = by("point-to-point");
      console.log(runs.map((r) => `${r.design}: duplicates ${r.duplicateExecutions}, resets ${r.manualResets}, double bookings ${r.erpDoubleBookings}`).join("\n"));
      const fail = (m: string) => {
        console.error(`smoke failed: ${m}`);
        process.exit(1);
      };
      if (orch.duplicateExecutions !== 0) fail(`orchestrator executed ${orch.duplicateExecutions} tasks twice`);
      if (orch.erpDoubleBookings !== 0) fail(`orchestrator double-booked ${orch.erpDoubleBookings} orders`);
      if (orch.manualResets !== 0) fail(`orchestrator needed ${orch.manualResets} manual resets`);
      if (p2p.duplicateExecutions === 0) fail("the status quo shows no duplicates: the fault model is not biting");
      void design;
      console.log("smoke ok");
      return;
    }
    case "check": {
      const problems = check(root);
      problems.forEach((p) => console.error(p));
      if (problems.length) process.exit(1);
      console.log("lab check ok");
      return;
    }
    default:
      console.error("usage: lab dev|heldout|smoke|check");
      process.exit(64);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
