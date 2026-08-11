/**
 * Planning-level cost estimation for a generated utility network. Turns raw
 * quantities (main length, junction count, service count) into a dollar
 * estimate using per-utility-type unit costs — a default template of
 * generic, order-of-magnitude averages, always overridable since real unit
 * costs vary enormously by region, contractor, and site conditions. This is
 * a budgetary planning tool, not a quote: see the caveat on
 * {@link DEFAULT_UNIT_COSTS}.
 */

/** Per-utility-type unit costs, in the caller's chosen currency. */
export interface UnitCosts {
  /** Cost per linear meter of main/cable, installed. */
  mainCostPerMeter: number;
  /** Cost per junction structure (valve, manhole, catch basin, vault, handhole). */
  junctionCost: number;
  /** Cost per service connection (main-to-building lateral). */
  serviceCost: number;
}

/**
 * Default unit-cost template: generic North American planning-level
 * averages for installed underground utility work, gathered from typical
 * municipal engineering cost-estimating references. These are **rough
 * order-of-magnitude defaults for a starting template, not a quote** — real
 * costs vary by region, soil/rock conditions, traffic control, pipe
 * material/diameter, and market conditions by a factor of 2-3x or more.
 * Always meant to be reviewed and overridden per project (see
 * `cost-rate-overrides.ts` in the desktop app for how user edits persist).
 */
export const DEFAULT_UNIT_COSTS: Record<string, UnitCosts> = {
  water: { mainCostPerMeter: 300, junctionCost: 4500, serviceCost: 2200 },
  sewer: { mainCostPerMeter: 380, junctionCost: 5500, serviceCost: 2800 },
  stormwater: { mainCostPerMeter: 340, junctionCost: 4000, serviceCost: 2000 },
  electric: { mainCostPerMeter: 220, junctionCost: 6000, serviceCost: 1800 },
  fiber: { mainCostPerMeter: 90, junctionCost: 1200, serviceCost: 600 },
};

/** Fallback used for a utility type with no entry in the cost table. */
const FALLBACK_UNIT_COSTS: UnitCosts = {
  mainCostPerMeter: 300,
  junctionCost: 4000,
  serviceCost: 2000,
};

/** Default contingency applied on top of the raw quantity-times-rate subtotal. */
export const DEFAULT_CONTINGENCY_PERCENT = 10;

/** Raw quantities takeoff for one utility type's generated network, as read
 * off a {@link GeneratedNetwork} (or several runs of the same utility type
 * summed together). */
export interface NetworkQuantities {
  utilityType: string;
  mainLengthMeters: number;
  junctionCount: number;
  serviceCount: number;
}

export type CostComponent = "main" | "junctions" | "services";

export interface CostLineItem {
  utilityType: string;
  component: CostComponent;
  quantity: number;
  unit: "m" | "each";
  unitCost: number;
  total: number;
}

export interface CostEstimate {
  lineItems: CostLineItem[];
  subtotal: number;
  contingencyPercent: number;
  contingencyAmount: number;
  total: number;
}

function unitCostsFor(
  utilityType: string,
  unitCosts: Record<string, UnitCosts>,
): UnitCosts {
  return unitCosts[utilityType] ?? FALLBACK_UNIT_COSTS;
}

/**
 * Aggregates quantities across one or more utility-type networks into a full
 * cost estimate: one line item per (utility type, component) with a nonzero
 * quantity, a subtotal, a contingency amount, and a grand total.
 */
export function estimateNetworkCost(
  quantities: NetworkQuantities[],
  unitCosts: Record<string, UnitCosts> = DEFAULT_UNIT_COSTS,
  contingencyPercent: number = DEFAULT_CONTINGENCY_PERCENT,
): CostEstimate {
  const lineItems: CostLineItem[] = [];

  for (const q of quantities) {
    const rates = unitCostsFor(q.utilityType, unitCosts);
    if (q.mainLengthMeters > 0) {
      lineItems.push({
        utilityType: q.utilityType,
        component: "main",
        quantity: q.mainLengthMeters,
        unit: "m",
        unitCost: rates.mainCostPerMeter,
        total: q.mainLengthMeters * rates.mainCostPerMeter,
      });
    }
    if (q.junctionCount > 0) {
      lineItems.push({
        utilityType: q.utilityType,
        component: "junctions",
        quantity: q.junctionCount,
        unit: "each",
        unitCost: rates.junctionCost,
        total: q.junctionCount * rates.junctionCost,
      });
    }
    if (q.serviceCount > 0) {
      lineItems.push({
        utilityType: q.utilityType,
        component: "services",
        quantity: q.serviceCount,
        unit: "each",
        unitCost: rates.serviceCost,
        total: q.serviceCount * rates.serviceCost,
      });
    }
  }

  const subtotal = lineItems.reduce((sum, item) => sum + item.total, 0);
  const contingencyAmount = subtotal * (contingencyPercent / 100);

  return {
    lineItems,
    subtotal,
    contingencyPercent,
    contingencyAmount,
    total: subtotal + contingencyAmount,
  };
}
