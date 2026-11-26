import { Bars } from "../../shared/Bars";
import { ordered } from "../../shared/designs";
import type { Results } from "../../shared/types";

export function Faults({ data }: { data: Results }) {
  const rows = ordered(data);
  return (
    <section aria-labelledby="faults-title">
      <h2 id="faults-title" className="section-title">
        What goes wrong between the cloud and the floor
      </h2>
      <p className="section-lede">
        Same year, same orders, same link cuts, breakdowns and ERP hiccups for every design. Duplicates come from re-sent orders and commands
        that nobody de-duplicates, and from work handed to a second robot while the first one, cut off from the cloud, was still doing it.
      </p>
      <div className="small-multiples">
        <Bars rows={rows} metric="duplicateExecutions" unit="tasks" title="Physical tasks executed twice, per year" />
        <Bars rows={rows} metric="manualResets" unit="resets" title="Tasks a supervisor had to reset" />
        <Bars rows={rows} metric="erpDoubleBookings" unit="bookings" title="ERP confirmations booked twice" />
      </div>
    </section>
  );
}
