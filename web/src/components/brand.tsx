import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

/** Fuku wordmark (pixel-art "Fuku", 202x71 source in /public/fuku-logo.png). */
const LOGO = { src: "/fuku-logo.png", width: 202, height: 71 } as const;

export function FukuWordmark({ className, height = 26 }: { className?: string; height?: number }) {
  return (
    <Image
      src={LOGO.src}
      alt="Fuku"
      width={LOGO.width}
      height={LOGO.height}
      priority
      className={cn("select-none", className)}
      style={{ height, width: "auto" }}
    />
  );
}

/**
 * Header logo. The wordmark already reads "Fuku", so `wordmark={false}` (compact headers) only
 * renders it smaller.
 */
export function Logo({ href = "/", className, wordmark = true }: { href?: string; className?: string; wordmark?: boolean }) {
  return (
    <Link href={href} aria-label="Fuku home" className={cn("inline-flex items-center", className)}>
      <FukuWordmark height={wordmark ? 26 : 20} />
    </Link>
  );
}
