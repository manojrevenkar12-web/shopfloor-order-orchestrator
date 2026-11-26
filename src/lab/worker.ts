import { parentPort, workerData } from "node:worker_threads";
import { design } from "./designs.js";
import { runDesign } from "./run.js";
import { DEFAULT_WORLD } from "./world.js";

const { design: name, seed, days } = workerData as { design: string; seed: number; days: number };
parentPort!.postMessage(runDesign(design(name), seed, { ...DEFAULT_WORLD, days }));
