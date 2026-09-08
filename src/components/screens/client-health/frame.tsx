"use client";

import { useClientHealth } from "./load";
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
 */
export function ClientHealthFrame({
  initial,
  children,
}: {
  initial: ClientHealthWeeklyData | null;
  children: (data: ClientHealthWeeklyData) => React.ReactNode;
}) {
  const { data, error } = useClientHealth(initial);

  if (error) {
    return (
      <div className="wrap">
        <div className="anno">
          <b>Client Health could not be read.</b> {error}. Nothing is wrong with the
          tool&rsquo;s own dashboard — this is the workspace&rsquo;s connection to it.
        </div>
      </div>
    );
  }

  if (!data) return <Skeleton />;

  return <>{children(data)}</>;
}

function Skeleton() {
  return (
    <div className="wrap" aria-busy="true" aria-label="Loading Client Health">
      <div className="cards" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
        {Array.from({ length: 6 }, (_, i) => (
          <div className="card" key={i}>
            <div className="card-l"><Bar w={62} /></div>
            <div className="card-n"><Bar w={48} h={26} /></div>
            <div className="card-s"><Bar w={86} /></div>
          </div>
        ))}
      </div>
      <div className="tbl-wrap">
        <div className="tbl-head">
          <div>
            <div className="tbl-title"><Bar w={128} h={16} /></div>
            <div className="tbl-sub" style={{ marginTop: 6 }}><Bar w={240} /></div>
          </div>
        </div>
        <div style={{ padding: "8px 22px 22px" }}>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} style={{ padding: "13px 0", borderTop: i ? "1px solid var(--line-soft)" : undefined }}>
              <Bar w={`${52 + ((i * 7) % 28)}%`} h={13} />
            </div>
          ))}
        </div>
      </div>
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
        background: "var(--inset-2)",
      }}
    />
  );
}
