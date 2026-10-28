import { initials } from "@/lib/crm-preview/model";

/*
 * Which client's portal to open. Plain links: picking one reloads the page with
 * it. Staff (the reviewers) see every portal and, since 29 Oct, act on them; a
 * client (27 Oct) with more than one portal open to them picks theirs: no bar,
 * nothing about other clients.
 */
export function ClientPicker({ portals, missing = false, audience = "staff" }: { portals: Array<{ id: string; name: string; note?: string }>; missing?: boolean; audience?: "staff" | "client" }) {
  if (audience === "client") {
    return (
      <main className="cpv-pick">
        <h1>Choose your portal</h1>
        <p>You can open each of these portals.</p>
        <ul>
          {portals.map((p) => (
            <li key={p.id}>
              <a href={`/crm-preview?client=${encodeURIComponent(p.id)}`}>
                <span className="cpv-av" aria-hidden="true">{initials(p.name)}</span>
                <span>{p.name}</span>
              </a>
            </li>
          ))}
        </ul>
      </main>
    );
  }
  return (
    <>
      <div className="cpv-bar" role="note">
        <span className="cpv-tag">STAFF</span>
        <b>New client portal</b>
        <span className="cpv-note">Every client&apos;s portal, as they see it · their current portal stays on its own address, unchanged</span>
        <span className="cpv-right"><a href="/">Back to the OS</a></span>
      </div>
      <main className="cpv-pick">
        <h1>Open a client&apos;s portal</h1>
        <p>
          Each client&apos;s new portal, on their real pipeline, agents, DNC list and team. What you change on a client&apos;s
          portal is real: it is saved to that client&apos;s portal as if they made it, and their current portal shows it too.
          The Demo Portal is for practice.
        </p>
        {missing ? <div className="cpv-warn" role="status">That client has no portal. Pick another.</div> : null}
        <ul>
          {portals.map((p) => (
            <li key={p.id}>
              <a href={`/crm-preview?client=${encodeURIComponent(p.id)}`}>
                <span className="cpv-av" aria-hidden="true">{initials(p.name)}</span>
                {p.note ? (
                  <span className="cpv-pick-txt">
                    <span>{p.name}</span>
                    <span className="cpv-pick-note">{p.note}</span>
                  </span>
                ) : (
                  <span>{p.name}</span>
                )}
              </a>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}
