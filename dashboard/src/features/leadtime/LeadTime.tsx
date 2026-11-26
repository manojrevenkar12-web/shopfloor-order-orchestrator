import { Bars } from "../../shared/Bars";
import { ordered } from "../../shared/designs";
import type { Results } from "../../shared/types";

export function LeadTime({ data }: { data: Results }) {
  const rows = ordered(data);
  return (
    <section aria-labelledby="lead-title">
      <h2 id="lead-title" className="section-title">
        How long orders take
      </h2>
      <p className="section-lede">
        From the ERP release to the last task done on the floor. Choosing cells and robots by skills and backlog shortens the overall tail.
        Orders on an edge that was cut off wait for that edge instead of being run twice; fixed routes recover them a little faster.
      </p>
      <div className="small-multiples two">
        <Bars rows={rows} metric="leadP95Min" unit="min" title="Lead time p95, all orders" />
        <Bars rows={rows} metric="partitionLeadP95Min" unit="min" title="Lead time p95, orders on an edge that was cut off" />
      </div>
    </section>
  );
}
