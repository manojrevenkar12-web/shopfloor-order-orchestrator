import { motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { color, short } from "./designs";
import { fmtNum } from "./format";
import type { DesignResult, MetricKey } from "./types";
import { duration, ease, stagger } from "../theme/motion";

/** Horizontal bars, one per design, with ± 1 sd whiskers, direct labels and a hover/focus readout. */
export function Bars({ rows, metric, unit, digits = 0, title }: { rows: DesignResult[]; metric: MetricKey; unit: string; digits?: number; title: string }) {
  const reduce = useReducedMotion();
  const [hover, setHover] = useState<DesignResult | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.metrics[metric].mean + r.metrics[metric].sd)) * 1.12;
  const pct = (x: number) => `${Math.max(0, (100 * x) / max)}%`;
  return (
    <figure className="bars" onMouseLeave={() => setHover(null)}>
      <figcaption className="bars-title">{title}</figcaption>
      {rows.map((r, i) => {
        const s = r.metrics[metric];
        return (
          <div className="bar-row" key={r.design} tabIndex={0} onMouseEnter={() => setHover(r)} onFocus={() => setHover(r)}>
            <span className="bar-label">{short[r.design]}</span>
            <div className="bar-track">
              {s.mean > 0 ? (
                <motion.div
                  className="bar"
                  style={{ width: pct(s.mean), background: color[r.design], transformOrigin: "left" }}
                  initial={reduce ? { opacity: 0 } : { scaleX: 0 }}
                  animate={reduce ? { opacity: 1 } : { scaleX: 1 }}
                  transition={{ duration: duration.emphasis, ease: ease.enter, delay: i * stagger }}
                />
              ) : (
                <span className="bar-zero" style={{ background: color[r.design] }} aria-hidden />
              )}
              {s.sd > 0 && <span className="whisker" style={{ left: pct(s.mean - s.sd), width: pct(2 * s.sd) }} aria-hidden />}
              <span className="bar-value" style={{ left: pct(s.mean + s.sd) }}>
                {fmtNum(s.mean, digits)} {unit}
              </span>
            </div>
          </div>
        );
      })}
      <p className="readout" aria-live="polite">
        {hover ? (
          <>
            <strong>{hover.label}</strong> · {fmtNum(hover.metrics[metric].mean, digits)} ± {fmtNum(hover.metrics[metric].sd, digits)} {unit} · seeds {hover.seeds.join(", ")}
          </>
        ) : (
          <span className="muted">Hover or focus a bar for the spread across seeds.</span>
        )}
      </p>
    </figure>
  );
}
