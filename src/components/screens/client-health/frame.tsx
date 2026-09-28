"use client";

import { useClientHealth } from "./load";
import { SyncScheduler } from "./sync-scheduler";
import type { ClientHealthWeeklyData } from "@/lib/tools/client-health/weekly";

/*
 * The loading and failure states for Client Health's three screens.
 *
 * Kept in one place so all three behave identically. A screen that is still
 * loading must not render an empty table: a table with no rows and no
 * explanation reads as "you have no clients", which is a far worse thing to
 * say than "one moment".
 *
 * The skeleton matches the real layout's shape — cards above, table below — so
 * arriving data does not shove the page around.
 *
 * The sync schedule's ticker is mounted here too, because "a Client Health
 * screen is open" is exactly the condition under which the schedule should be
 * kept — see sync-scheduler.tsx. It renders nothing and dedupes itself across
 * the three screens.
 */
export function ClientHealthFrame({
  initial,
  children,
}: {
  initial: ClientHealthWeeklyData | null;
  children: (data: ClientHealthWeeklyData) => React.ReactNode;
}) {
  const { data, error } = useClientHealth(initial);

  let body: React.ReactNode;
  if (error) {
    body = (
      <div className="wrap">
        <div className="anno">
          <b>Client Health could not be read.</b> {error}. Nothing is wrong with the
          data itself — this is the workspace&rsquo;s connection to its database.
        </div>
      </div>
    );
  } else if (!data) {
    body = <Skeleton />;
  } else {
    body = children(data);
  }

  return (
    <>
      <SyncScheduler />
      {body}
    </>
  );
}

function Skeleton() {
  return (
    <div className="ds-page" aria-busy="true" aria-label="Loading Client Health">
      <div className="ds-head"><div><Bar w={160} h={22} /><div style={{ marginTop: 8 }}><Bar w={320} /></div></div></div>
      <div className="ds-stats" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        {Array.from({ length: 6 }, (_, i) => (
          <div className="ds-stat" key={i}>
            <Bar w={62} />
            <Bar w={48} h={26} />
            <Bar w={86} />
          </div>
        ))}
      </div>
      <section className="ds-panel">
        <div className="ds-panel-head"><div><Bar w={128} h={16} /><div style={{ marginTop: 6 }}><Bar w={240} /></div></div></div>
        <div style={{ padding: "8px 18px 18px" }}>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} style={{ padding: "13px 0", borderTop: i ? "1px solid var(--ds-border)" : undefined }}>
              <Bar w={`${52 + ((i * 7) % 28)}%`} h={13} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/*
 * A placeholder bar. Deliberately still — an animated shimmer on a screen that
 * usually resolves in well under a second reads as slower than it is.
 */
function Bar({ w, h = 11 }: { w: number | string; h?: number }) {
  return (
    <span
      style={{
        display: "block",
        width: typeof w === "number" ? w : w,
        height: h,
        borderRadius: 5,
        background: "var(--ds-sunken)",
      }}
    />
  );
}
