import { PortalLogo } from "@/components/master-inbox/portals-ui/portal-logo";

// Placeholder shown on the Client Portals routes while the feature is
// flagged off (lib/portals/flag.ts).
export function PortalsComingSoon() {
  return (
    <div className="flex-1 overflow-y-auto bg-[#f4f7fb]">
      <div className="max-w-md mx-auto px-8 py-24 text-center">
        <div className="inline-flex rounded-2xl bg-white border border-[#e3e8ef] p-3 shadow-sm">
          <PortalLogo className="h-10 w-auto" />
        </div>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-[#15181e]">
          Client Portals
        </h1>
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-[#E3F0FF] text-[#1565C0] px-3 py-1 text-xs font-semibold">
          Coming soon
        </div>
        <p className="mt-4 text-sm text-[#5b6370] leading-relaxed">
          Private, login-free dashboards where each client sees their own
          introduction leads in real time. We&apos;re putting the finishing
          touches on it — it&apos;ll light up here shortly.
        </p>
      </div>
    </div>
  );
}
