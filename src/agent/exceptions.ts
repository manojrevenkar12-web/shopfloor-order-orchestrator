import type { Millis } from "../domain/types.js";
import type { Orchestrator } from "../sync/cloud.js";

/** Facts about one order, built by code from the orchestrator's state. The agent may use nothing else. */
export interface OrderFacts {
  orderId: string;
  state: string;
  source: string;
  product: string;
  quantity: number;
  ageMin: number;
  dueInMin: number;
  tasks: Array<{ taskId: string; state: string; assignee: string | null; edge: string | null; edgeOnline: boolean | null; silentMin: number; attempts: number; epoch: number }>;
  findings: string[];
}

/** Why an order is not moving, decided by rules, not by the model. */
export function factsFor(orc: Orchestrator, orderId: string, now: Millis, edgeOf: (resourceId: string) => string | undefined): OrderFacts | undefined {
  const rec = orc.orders.get(orderId);
  if (!rec) return undefined;
  const findings: string[] = [];
  const tasks = rec.taskIds.map((id) => {
    const t = orc.tasks.get(id)!;
    const edge = t.assignee ? (edgeOf(t.assignee) ?? null) : null;
    const er = edge ? orc.edges.get(edge) : undefined;
    const silentMin = Math.round((now - (t.assignedAt ?? rec.order.receivedAt)) / 60_000);
    if (t.state === "READY" && t.kind === "process" && !t.reservedFor) findings.push(`${t.taskId} waits for a cell with skills ${t.skills.join("+")}`);
    if (t.state === "READY" && t.kind === "transport" && (!t.from || !t.to)) findings.push(`${t.taskId} waits for its process step to get a cell`);
    if (t.state === "READY" && t.from && t.to) findings.push(`${t.taskId} is ready and waits for a free mobile resource`);
    if (er && !er.online && (t.state === "ACCEPTED" || t.state === "RUNNING")) findings.push(`${t.taskId} is held by edge ${edge}, offline for ${Math.round((now - er.lastHeardAt) / 60_000)} min; it stays pinned there until the edge reports`);
    if (t.state === "ASSIGNED" && er?.online) findings.push(`${t.taskId} was sent to ${t.assignee} and not yet accepted`);
    if (er && !er.online && t.state === "ASSIGNED") findings.push(`${t.taskId} was sent to ${t.assignee} just before edge ${edge} went offline; the cloud checks with the edge when it is back before giving it to anyone else`);
    if (t.attempts > 0) findings.push(`${t.taskId} failed ${t.attempts} time(s)`);
    return { taskId: t.taskId, state: t.state, assignee: t.assignee ?? null, edge, edgeOnline: er ? er.online : null, silentMin, attempts: t.attempts, epoch: t.epoch };
  });
  if (rec.state === "COMPLETED") findings.push("finished on the shopfloor; the ERP confirmation is still pending in the outbox");
  if (rec.state === "ON_HOLD") findings.push("on hold after three failed attempts; needs a supervisor");
  return {
    orderId,
    state: rec.state,
    source: rec.order.source,
    product: rec.order.product,
    quantity: rec.order.quantity,
    ageMin: Math.round((now - rec.order.receivedAt) / 60_000),
    dueInMin: Math.round((rec.order.dueAt - now) / 60_000),
    tasks,
    findings,
  };
}

/** Orders a shift lead should look at: past due, on hold, or with a task silent for too long. */
export function stuckOrders(orc: Orchestrator, now: Millis, silentMin = 30): string[] {
  const out: string[] = [];
  for (const [id, rec] of orc.orders) {
    if (rec.state === "CONFIRMED" || rec.state === "FAILED") continue;
    const late = rec.order.dueAt < now && rec.state !== "COMPLETED";
    const silent = rec.taskIds.some((tid) => {
      const t = orc.tasks.get(tid)!;
      return (t.state === "ASSIGNED" || t.state === "ACCEPTED") && now - (t.assignedAt ?? now) > silentMin * 60_000;
    });
    if (late || silent || rec.state === "ON_HOLD") out.push(id);
  }
  return out;
}

export interface Explanation {
  text: string;
  source: string;
  rejectedDraft?: string;
}

export function templateExplanation(f: OrderFacts): Explanation {
  const due = f.dueInMin >= 0 ? `due in ${f.dueInMin} min` : `${-f.dueInMin} min past due`;
  const head = `${f.orderId} (${f.source}, ${f.quantity} x ${f.product}) is ${f.state.toLowerCase().replace("_", " ")}, ${f.ageMin} min old, ${due}.`;
  const body = f.findings.length ? ` ${f.findings.map((x) => x[0]!.toUpperCase() + x.slice(1)).join(". ")}.` : " All tasks are moving; nothing needs a decision.";
  return { text: head + body, source: "template" };
}

const NUMBER = /(?<![\w.])-?\d+(?:\.\d+)?/g;
const ID = /\b(?:MES|EWM)-[A-Z0-9-]+(?:\/\d)?\b|\b(?:amr|nova|C)[-\w]*\d\b/g;

/** Every number and every order, task, resource or edge id in a draft must be in the facts. */
export function groundingProblems(draft: string, f: OrderFacts): string[] {
  const corpus = JSON.stringify(f);
  const nums = new Set((corpus.match(NUMBER) ?? []).map((n) => n.replace(/^-/, "")));
  const problems: string[] = [];
  for (const n of draft.match(NUMBER) ?? []) if (!nums.has(n.replace(/^-/, ""))) problems.push(`number ${n} is not in the facts`);
  for (const id of draft.match(ID) ?? []) if (!corpus.includes(id)) problems.push(`id ${id} is not in the facts`);
  return problems;
}

export type Complete = (prompt: string) => Promise<string>;

/**
 * The shift-lead assistant. Read-only: it gets facts and returns text. With a model, the draft is
 * checked against the facts; a draft that adds a number or an id falls back to the template.
 */
export async function explain(f: OrderFacts, complete?: Complete): Promise<Explanation> {
  const template = templateExplanation(f);
  if (!complete) return template;
  const prompt = [
    "You help a shift lead on a robot shopfloor. Explain in at most three sentences why this order is where it is and what, if anything, needs a decision.",
    "Use only these facts; do not add numbers or ids that are not in them.",
    JSON.stringify(f),
  ].join("\n");
  let draft: string;
  try {
    draft = (await complete(prompt)).trim();
  } catch (e) {
    return { ...template, source: `template (model unavailable: ${(e as Error).message})` };
  }
  const problems = groundingProblems(draft, f);
  return problems.length ? { ...template, source: `template (draft rejected: ${problems[0]})`, rejectedDraft: draft } : { text: draft, source: "model" };
}

/** Claude Messages API call for `explain`; reads ANTHROPIC_API_KEY. */
export function claude(apiKey: string, model = "claude-sonnet-5-5"): Complete {
  return async (prompt) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = body.content?.find((c) => c.type === "text")?.text;
    if (!text) throw new Error("no text in response");
    return text;
  };
}
