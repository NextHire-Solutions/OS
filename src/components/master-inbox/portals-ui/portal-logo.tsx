import Image from "next/image";

// The BrokerStaffer wordmark + house mark, used across the client
// portal surfaces. 160x55 (≈2.9:1 aspect). Callers must pass a
// HEIGHT-based class (h-7, h-10, etc.) plus w-auto — using a square
// `size-N` will distort the aspect.
//
// PATH: the tool serves this from /portal/brokerstafferlogo.webp, which is a
// route the OS does not have — /portal/* is deliberately excluded from this
// workspace so only the live service writes to the portal tables. The asset
// 404'd here, and the Client Portals header rendered a broken image with its
// alt text showing. The OS ships the identical 160x55 file at
// /brokerstaffer-logo.webp (the same one the rail's brand mark imports), so
// that is what this points at.
export function PortalLogo({ className }: { className?: string }) {
  return (
    <Image
      src="/brokerstaffer-logo.webp"
      alt="BrokerStaffer"
      // Intrinsic size — the className overrides the visual height.
      // Next.js Image needs both width + height so the layout
      // shift is zero before the image is decoded.
      width={160}
      height={55}
      // Eager-load so the header isn't a flash-of-no-logo on the
      // first paint of every portal page.
      priority
      className={className}
    />
  );
}
