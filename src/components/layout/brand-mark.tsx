import Image from "next/image";
import logo from "../../../public/brokerstaffer-logo.webp";

/**
 * The only logo call site in the app.
 *
 * The asset is 160x55 (~2.9:1). Callers must size by HEIGHT plus `w-auto` — a
 * square `size-N` distorts the lockup. Same rule the Master Inbox portal
 * component documents, carried over because it is the kind of thing that gets
 * broken once and then lives broken.
 */
export function BrandMark({ className = "h-7 w-auto" }: { className?: string }) {
  return (
    <Image
      src={logo}
      alt="BrokerStaffer"
      className={className}
      priority
      sizes="160px"
    />
  );
}
