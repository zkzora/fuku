import type { CSSProperties, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * CSS-only fade-up reveal. No JavaScript is needed for the content to appear, so the landing
 * page is readable before hydration and in environments where animations do not run.
 */
export function Reveal({ delay = 0, className, style, children, ...rest }: HTMLAttributes<HTMLDivElement> & { delay?: number }) {
  return (
    <div
      className={cn("animate-fade-up", className)}
      style={{ animationDelay: `${delay}s`, ...(style as CSSProperties) }}
      {...rest}
    >
      {children}
    </div>
  );
}
