import { color, ordered, short } from "../../shared/designs";
import { fmtNum } from "../../shared/format";
import type { MetricKey, Results } from "../../shared/types";

const ROWS: Array<{ key: MetricKey; label: string; digits: number }> = [
  { key: "duplicateExecutions", label: "Duplicate physical executions", digits: 0 },
  { key: "manualResets", label: "Manual task resets", digits: 0 },
  { key: "erpDoubleBookings", label: "ERP double bookings", digits: 0 },
  { key: "erpMissing", label: "Finished, never booked", digits: 0 },
  { key: "leadP50Min", label: "Lead time p50 (min)", digits: 1 },
  { key: "leadP95Min", label: "Lead time p95 (min)", digits: 0 },
  { key: "partitionLeadP95Min", label: "Lead time p95, edge cut off (min)", digits: 0 },
  { key: "latePct", label: "Late orders (%)", digits: 1 },
  { key: "kbPerDay", label: "Cloud-edge traffic (KB/day)", digits: 0 },
];

export function ResultsTable({ data }: { data: Results }) {
  const rows = ordered(data);
  return (
    <section aria-labelledby="table-title">
      <h2 id="table-title" className="section-title">
        Every number
      </h2>
      <div className="table-wrap">
        <table className="results">
          <caption className="sr-only">Mean and standard deviation per design across held-out seeds</caption>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              {rows.map((d) => (
                <th scope="col" key={d.design}>
                  <span className="swatch" style={{ background: color[d.design] }} aria-hidden />
                  {short[d.design]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.label}</th>
                {rows.map((d) => (
                  <td key={d.design}>
                    {fmtNum(d.metrics[r.key].mean, r.digits)} <span className="muted">± {fmtNum(d.metrics[r.key].sd, r.digits)}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
