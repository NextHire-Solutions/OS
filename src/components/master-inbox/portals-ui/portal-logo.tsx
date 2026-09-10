import Image from "next/image";

// The BrokerStaffer wordmark + house mark, used across the client
// portal surfaces. Source file is /public/portal/brokerstafferlogo.webp
// at 160x55 (≈2.9:1 aspect). Callers must pass a HEIGHT-based class
// (h-7, h-10, etc.) plus w-auto — using a square `size-N` will
// distort the aspect.
export function PortalLogo({ className }: { className?: string }) {
  return (
    <Image
      src="/portal/brokerstafferlogo.webp"
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
