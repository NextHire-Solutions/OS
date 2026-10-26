import { removalGroups, removalLine, type CampaignOutcome, type RemovalStatus } from "@/lib/clients/campaign-lists/rules";

/*
 * What happened to one My Agents / DNC entry, under its status chip: each
 * group ("Would come off 5 campaigns · Practice mode is on.") with its
 * campaigns one per line — at most three, the rest counted; the whole of it
 * on hover. Used by Settings → Campaign clean-up and the client record.
 */
const SHOWN = 3;

export function RemovalDetail({ entry }: { entry: { status: RemovalStatus; reason: string | null; campaigns: readonly CampaignOutcome[]; error?: string | null } }) {
  const groups = removalGroups(entry);
  if (!groups.length) return null;
  return (
    <div className="cl-detail" title={removalLine(entry)}>
      {groups.map((g) => (
        <div key={g.label} className="cl-detail-g">
          <span className="cl-detail-l">
            {g.label}
            {g.note ? <span className="cl-detail-note"> · {g.note}</span> : null}
          </span>
          {g.names.length ? (
            <ul className="cl-detail-n">
              {g.names.slice(0, SHOWN).map((n) => (
                <li key={n}>{n}</li>
              ))}
              {g.names.length > SHOWN ? <li className="cl-detail-more">and {g.names.length - SHOWN} more</li> : null}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}
