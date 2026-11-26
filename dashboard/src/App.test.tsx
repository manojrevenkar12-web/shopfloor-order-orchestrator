import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { DesignResult, MetricKey, Results } from "./shared/types";

const KEYS: MetricKey[] = ["duplicateExecutions", "manualResets", "erpDoubleBookings", "leadP95Min", "partitionLeadP95Min", "latePct", "leadP50Min", "erpMissing", "kbPerDay"];
const design = (name: string, v: Partial<Record<MetricKey, number>>): DesignResult => ({
  design: name,
  label: name,
  seeds: [1001, 1002],
  orders: { mean: 85800, sd: 0 },
  metrics: Object.fromEntries(KEYS.map((k) => [k, { mean: v[k] ?? 0, sd: 0 }])) as DesignResult["metrics"],
});
const results: Results = {
  split: "heldout",
  days: 364,
  generatedBy: "npm run lab -- heldout",
  designs: [
    design("point-to-point", { duplicateExecutions: 3300, manualResets: 600, erpDoubleBookings: 2100, leadP95Min: 200 }),
    design("cloud-only", { duplicateExecutions: 1200, manualResets: 1100, leadP95Min: 170 }),
    design("orchestrator", { leadP95Min: 170 }),
    design("orchestrator-static", { leadP95Min: 180 }),
  ],
};

const ok = () => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(results))));
afterEach(() => vi.unstubAllGlobals());

describe("dashboard", () => {
  it("shows a loading state, then the headline numbers", async () => {
    ok();
    render(<App />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    const head = await screen.findByRole("region", { name: "Headline results" });
    expect(within(head).getByText("-15 %")).toBeInTheDocument();
    expect(within(head).getByText(/vs 3,300 with point-to-point/)).toBeInTheDocument();
    expect(screen.getByText(/Held-out seeds 1001, 1002/)).toBeInTheDocument();
  });

  it("puts every design in the table, in fixed order", async () => {
    ok();
    render(<App />);
    const table = await screen.findByRole("table");
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Metric", "Point-to-point (status quo)", "Cloud-only orchestrator", "Orchestrator, fixed routes", "Orchestrator"]);
  });

  it("shows the spread for a bar on hover", async () => {
    ok();
    render(<App />);
    const rows = await screen.findAllByText("Cloud-only orchestrator");
    await userEvent.hover(rows[0]!);
    expect((await screen.findAllByText(/± 0 tasks · seeds 1001, 1002/)).length).toBe(1);
  });

  it("offers a retry after an error", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (++n === 1 ? new Response("x", { status: 503 }) : new Response(JSON.stringify(results)))));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 503");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("shows the empty state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...results, designs: [] }))));
    render(<App />);
    expect(await screen.findByText("No results yet.")).toBeInTheDocument();
  });
});
