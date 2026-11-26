import { motion, useReducedMotion } from "framer-motion";
import { byName } from "../../shared/designs";
import { change, fmtInt, fmtPct } from "../../shared/format";
import type { Results } from "../../shared/types";
import { duration, ease, stagger } from "../../theme/motion";

export function Headline({ data }: { data: Results }) {
  const reduce = useReducedMotion();
  const base = byName(data, "point-to-point");
  const orc = byName(data, "orchestrator");
  if (!base || !orc) return null;
  const m = (d: typeof orc, k: keyof typeof orc.metrics) => d.metrics[k].mean;
  const tiles = [
    { label: "Tasks the shopfloor did twice", value: fmtInt(m(orc, "duplicateExecutions")), detail: `a year, vs ${fmtInt(m(base, "duplicateExecutions"))} with point-to-point integration` },
    { label: "Goods movements booked twice in the ERP", value: fmtInt(m(orc, "erpDoubleBookings")), detail: `vs ${fmtInt(m(base, "erpDoubleBookings"))}; retries carry an idempotency key` },
    { label: "Tasks a supervisor had to reset", value: fmtInt(m(orc, "manualResets")), detail: `vs ${fmtInt(m(base, "manualResets"))}; edges keep and resend their events` },
    { label: "Order lead time, p95", value: fmtPct(change(m(orc, "leadP95Min"), m(base, "leadP95Min"))), detail: `${fmtInt(m(orc, "leadP95Min"))} vs ${fmtInt(m(base, "leadP95Min"))} min; skills-based allocation` },
  ];
  return (
    <section className="headline" aria-label="Headline results">
      {tiles.map((t, i) => (
        <motion.div
          key={t.label}
          className="tile"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: duration.standard, ease: ease.enter, delay: i * stagger }}
        >
          <p className="tile-label">{t.label}</p>
          <p className={`tile-value${t.value === "0" ? " is-zero" : ""}`}>{t.value}</p>
          <p className="tile-detail">{t.detail}</p>
        </motion.div>
      ))}
    </section>
  );
}
