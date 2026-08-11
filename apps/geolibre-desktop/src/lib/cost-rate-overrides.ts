import type { UnitCosts } from "@geolibre/utility-network";

/**
 * Persists the user's edits to the Cost panel's default unit-cost template
 * (see `DEFAULT_UNIT_COSTS` in `@geolibre/utility-network`) across sessions,
 * the same try/catch-guarded localStorage pattern as
 * `osm-road-fetch-consent.ts`. Only utility types the user actually edited
 * are stored — CostPanel merges this on top of the defaults, so a fresh
 * utility type not yet touched still gets a sensible starting value.
 */
const COST_RATE_OVERRIDES_KEY = "geolibre:cost-unit-rate-overrides";
const CONTINGENCY_PERCENT_KEY = "geolibre:cost-contingency-percent";

interface StoredCostRateOverrides {
  unitCosts: Record<string, UnitCosts>;
}

function isUnitCosts(value: unknown): value is UnitCosts {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.mainCostPerMeter === "number" &&
    typeof v.junctionCost === "number" &&
    typeof v.serviceCost === "number"
  );
}

/** Every utility type the user has customized rates for, or `{}` if none
 * (first run, private browsing, or corrupted storage). */
export function loadCostRateOverrides(): Record<string, UnitCosts> {
  try {
    const raw = localStorage.getItem(COST_RATE_OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredCostRateOverrides;
    if (typeof parsed !== "object" || parsed === null || !parsed.unitCosts) {
      return {};
    }
    const result: Record<string, UnitCosts> = {};
    for (const [utilityType, costs] of Object.entries(parsed.unitCosts)) {
      if (isUnitCosts(costs)) result[utilityType] = costs;
    }
    return result;
  } catch {
    return {};
  }
}

export function saveCostRateOverrides(
  unitCosts: Record<string, UnitCosts>,
): void {
  try {
    const payload: StoredCostRateOverrides = { unitCosts };
    localStorage.setItem(COST_RATE_OVERRIDES_KEY, JSON.stringify(payload));
  } catch {
    // Ignore: edits just won't survive a reload this time.
  }
}

export function resetCostRateOverrides(): void {
  try {
    localStorage.removeItem(COST_RATE_OVERRIDES_KEY);
  } catch {
    // Nothing to do — storage unavailable means there was nothing stored.
  }
}

/** `null` when the user hasn't overridden the contingency percentage. */
export function loadContingencyPercentOverride(): number | null {
  try {
    const raw = localStorage.getItem(CONTINGENCY_PERCENT_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveContingencyPercentOverride(percent: number): void {
  try {
    localStorage.setItem(CONTINGENCY_PERCENT_KEY, String(percent));
  } catch {
    // Ignore: edits just won't survive a reload this time.
  }
}

/** Clears every persisted cost customization (unit-cost overrides and the
 * contingency percentage), restoring the built-in default template. */
export function resetAllCostSettings(): void {
  resetCostRateOverrides();
  try {
    localStorage.removeItem(CONTINGENCY_PERCENT_KEY);
  } catch {
    // Nothing to do — storage unavailable means there was nothing stored.
  }
}
