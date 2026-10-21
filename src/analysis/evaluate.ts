import type { Settings } from "../config/types.ts";
import type { Stats } from "./stats.ts";

export type BreakReason = "error-rate" | "p95";

export interface BreakCheck {
  broke: boolean;
  reasons: BreakReason[];
  /** Too few non-throttled requests to judge. */
  insufficient: boolean;
}

export function checkBreak(stats: Stats, rules: Settings["break"]): BreakCheck {
  const effective = stats.n - stats.throttled;
  if (effective < rules.minRequests) {
    // Even with few samples, a service where most calls fail is clearly broken.
    const broke = effective >= 3 && stats.errors / effective >= 0.5;
    return { broke, reasons: broke ? ["error-rate"] : [], insufficient: !broke };
  }
  const reasons: BreakReason[] = [];
  if (stats.errorRate > rules.errorRate) reasons.push("error-rate");
  if (stats.p95 > rules.p95Ms) reasons.push("p95");
  return { broke: reasons.length > 0, reasons, insufficient: false };
}

export type ServiceStatus = "climbing" | "capped" | "broken";

export interface ServiceState {
  name: string;
  status: ServiceStatus;
  /** Rate (req/s) at the last step where the service was healthy. */
  lastHealthyRate?: number;
  lastHealthyStep?: number;
  brokeAtStep?: number;
  brokeAtRate?: number;
  reasons: BreakReason[];
  /** Rate the service is held at after breaking (0 = removed from load). */
  heldRate?: number;
}

export interface StepServiceOutcome {
  name: string;
  rate: number;
  capped: boolean;
  held: boolean;
  stats: Stats;
}

/**
 * Applies one step's results to the service states. A service that breaks is held at its last healthy rate
 * from the next step on; one that is healthy at its cap is marked capped.
 */
export function advanceStates(
  states: Map<string, ServiceState>,
  stepIndex: number,
  outcomes: StepServiceOutcome[],
  rules: Settings["break"]
): { newlyBroken: string[] } {
  const newlyBroken: string[] = [];
  for (const o of outcomes) {
    const st = states.get(o.name) ?? { name: o.name, status: "climbing" as ServiceStatus, reasons: [] };
    states.set(o.name, st);
    if (o.held || st.status === "broken" || o.rate <= 0) continue;
    const check = checkBreak(o.stats, rules);
    if (check.broke) {
      st.status = "broken";
      st.brokeAtStep = stepIndex;
      st.brokeAtRate = o.rate;
      st.reasons = check.reasons;
      st.heldRate = st.lastHealthyRate ?? 0;
      newlyBroken.push(o.name);
      continue;
    }
    if (!check.insufficient) {
      st.lastHealthyRate = o.rate;
      st.lastHealthyStep = stepIndex;
    }
    if (o.capped) st.status = "capped";
  }
  return { newlyBroken };
}

/** The run can stop once no service can be pushed harder. */
export function nothingLeftToClimb(states: Map<string, ServiceState>): boolean {
  if (states.size === 0) return true;
  return [...states.values()].every((s) => s.status !== "climbing");
}

export function emergencyReason(all: Stats, rules: Settings["emergency"]): string | undefined {
  const effective = all.n - all.throttled;
  if (effective >= 20 && all.errorRate > rules.errorRate) {
    return `overall error rate ${(all.errorRate * 100).toFixed(1)}% exceeded ${(rules.errorRate * 100).toFixed(0)}%`;
  }
  return undefined;
}
