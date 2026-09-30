"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * TrustScore ring. Violet is reserved for trust; the arc length is the score.
 */
export function TrustScore({
  score,
  size = 112,
  stroke = 8,
  label,
  className,
}: {
  score: number | null;
  size?: number;
  stroke?: number;
  label?: string;
  className?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  return (
    <div className={cn("relative inline-grid place-items-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--violet)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - pct) }}
          transition={{ type: "spring", stiffness: 60, damping: 18 }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="font-semibold leading-none text-ink" style={{ fontSize: size * 0.3 }}>
            {score ?? "—"}
          </div>
          {label && <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">{label}</div>}
        </div>
      </div>
    </div>
  );
}
