/**
 * Fuku Trust Score. Deterministic, explainable, bounded 0..100.
 *
 *   baseline                    40
 *   owner is a verified human  +20
 *   active permission passport  +5
 *   successful actions         +2.5 each, capped at +35
 *   permission violations       -4 each, capped at -40
 *   security events            -10 each
 */
export interface ReputationInputs {
  humanVerified: boolean;
  hasActivePolicy: boolean;
  successes: number;
  violations: number;
  securityEvents: number;
}

export interface ScoreBreakdownLine {
  key: string;
  label: string;
  points: number;
  detail: string;
}

export type SecurityLevel = "High" | "Medium" | "Low";

export interface ScoreResult {
  score: number;
  level: SecurityLevel;
  breakdown: ScoreBreakdownLine[];
}

export function computeScore(i: ReputationInputs): ScoreResult {
  const successPts = Math.min(35, Math.round(i.successes * 2.5 * 10) / 10);
  const violationPts = -Math.min(40, i.violations * 4);
  const securityPts = -i.securityEvents * 10;
  const breakdown: ScoreBreakdownLine[] = [
    { key: "base", label: "Baseline", points: 40, detail: "Every registered agent starts here." },
    {
      key: "human",
      label: "Verified human owner",
      points: i.humanVerified ? 20 : 0,
      detail: i.humanVerified
        ? "Owner passed passkey (WebAuthn) verification."
        : "Owner has not verified as human.",
    },
    {
      key: "policy",
      label: "Permission passport",
      points: i.hasActivePolicy ? 5 : 0,
      detail: i.hasActivePolicy
        ? "An active passport constrains what the agent can do."
        : "No active passport attached.",
    },
    {
      key: "success",
      label: "Successful actions",
      points: successPts,
      detail: `${i.successes} allowed actions executed (+2.5 each, max +35).`,
    },
    {
      key: "violations",
      label: "Permission violations",
      points: violationPts,
      detail: `${i.violations} blocked attempts (−4 each, max −40).`,
    },
    {
      key: "security",
      label: "Security events",
      points: securityPts,
      detail: `${i.securityEvents} security events (−10 each).`,
    },
  ];
  const raw = breakdown.reduce((s, l) => s + l.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return { score, level: levelFor(score), breakdown };
}

export function levelFor(score: number): SecurityLevel {
  return score >= 85 ? "High" : score >= 60 ? "Medium" : "Low";
}
