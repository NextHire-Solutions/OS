import { initials } from "@/lib/crm-preview/model";

/* Which client's data to preview the redesign on. Plain links: picking one reloads the page with it. */
export function ClientPicker({ portals, missing = false }: { portals: Array<{ id: string; name: string }>; missing?: boolean }) {
  return (
    <>
      <div className="cpv-bar" role="note">
        <span className="cpv-tag">PREVIEW</span>
        <b>New client portal design</b>
        <span className="cpv-note">Read-only · private: not visible to clients or the team · the live portals are unchanged</span>
        <span className="cpv-right"><a href="/">Back to the OS</a></span>
      </div>
      <main className="cpv-pick">
        <h1>Pick a client to preview</h1>
        <p>
          The redesign the client sent, drawn on that client&apos;s real pipeline, agents, DNC list and team. Nothing here
          can change anything, and the client&apos;s own portal stays exactly as it is.
        </p>
        {missing ? <div className="cpv-warn" role="status">That client has no portal. Pick another.</div> : null}
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
    </>
  );
}
