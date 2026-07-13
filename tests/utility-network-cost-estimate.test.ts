import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_CONTINGENCY_PERCENT,
  DEFAULT_UNIT_COSTS,
  estimateNetworkCost,
  type NetworkQuantities,
  type UnitCosts,
} from "@geolibre/utility-network";

describe("estimateNetworkCost", () => {
  it("prices a single utility type's quantities against the default template", () => {
    const quantities: NetworkQuantities[] = [
      { utilityType: "water", mainLengthMeters: 1000, junctionCount: 5, serviceCount: 10 },
    ];
    const estimate = estimateNetworkCost(quantities);
    const rates = DEFAULT_UNIT_COSTS.water;

    assert.equal(estimate.lineItems.length, 3);
    const main = estimate.lineItems.find((i) => i.component === "main");
    const junctions = estimate.lineItems.find((i) => i.component === "junctions");
    const services = estimate.lineItems.find((i) => i.component === "services");
    assert.equal(main?.total, 1000 * rates.mainCostPerMeter);
    assert.equal(junctions?.total, 5 * rates.junctionCost);
    assert.equal(services?.total, 10 * rates.serviceCost);

    const expectedSubtotal =
      1000 * rates.mainCostPerMeter + 5 * rates.junctionCost + 10 * rates.serviceCost;
    assert.equal(estimate.subtotal, expectedSubtotal);
    assert.equal(estimate.contingencyPercent, DEFAULT_CONTINGENCY_PERCENT);
    assert.equal(
      estimate.contingencyAmount,
      expectedSubtotal * (DEFAULT_CONTINGENCY_PERCENT / 100),
    );
    assert.equal(estimate.total, estimate.subtotal + estimate.contingencyAmount);
  });

  it("omits a line item entirely when its quantity is zero", () => {
    const quantities: NetworkQuantities[] = [
      { utilityType: "sewer", mainLengthMeters: 500, junctionCount: 0, serviceCount: 0 },
    ];
    const estimate = estimateNetworkCost(quantities);
    assert.equal(estimate.lineItems.length, 1);
    assert.equal(estimate.lineItems[0].component, "main");
  });

  it("aggregates multiple utility types into separate line items", () => {
    const quantities: NetworkQuantities[] = [
      { utilityType: "water", mainLengthMeters: 200, junctionCount: 2, serviceCount: 4 },
      { utilityType: "fiber", mainLengthMeters: 300, junctionCount: 1, serviceCount: 4 },
    ];
    const estimate = estimateNetworkCost(quantities);
    // 3 line items per utility type (main/junctions/services), two types.
    assert.equal(estimate.lineItems.length, 6);
    const waterItems = estimate.lineItems.filter((i) => i.utilityType === "water");
    const fiberItems = estimate.lineItems.filter((i) => i.utilityType === "fiber");
    assert.equal(waterItems.length, 3);
    assert.equal(fiberItems.length, 3);
  });

  it("uses caller-supplied unit-cost overrides instead of the defaults", () => {
    const quantities: NetworkQuantities[] = [
      { utilityType: "water", mainLengthMeters: 100, junctionCount: 1, serviceCount: 1 },
    ];
    const overrideRates: UnitCosts = {
      mainCostPerMeter: 999,
      junctionCost: 111,
      serviceCost: 222,
    };
    const estimate = estimateNetworkCost(quantities, { water: overrideRates });
    const main = estimate.lineItems.find((i) => i.component === "main");
    const junctions = estimate.lineItems.find((i) => i.component === "junctions");
    const services = estimate.lineItems.find((i) => i.component === "services");
    assert.equal(main?.total, 100 * 999);
    assert.equal(junctions?.total, 1 * 111);
    assert.equal(services?.total, 1 * 222);
  });

  it("falls back to a generic rate for a utility type absent from the cost table", () => {
    const quantities: NetworkQuantities[] = [
      { utilityType: "gas", mainLengthMeters: 100, junctionCount: 1, serviceCount: 0 },
    ];
    // No "gas" entry in DEFAULT_UNIT_COSTS or in this override table either.
    const estimate = estimateNetworkCost(quantities, {});
    assert.equal(estimate.lineItems.length, 2);
    // Falls back to a positive, finite rate rather than throwing or pricing at 0.
    for (const item of estimate.lineItems) {
      assert.ok(item.unitCost > 0);
      assert.ok(Number.isFinite(item.total));
    }
  });

  it("applies a custom contingency percentage", () => {
    const quantities: NetworkQuantities[] = [
      { utilityType: "water", mainLengthMeters: 100, junctionCount: 0, serviceCount: 0 },
    ];
    const estimate = estimateNetworkCost(quantities, DEFAULT_UNIT_COSTS, 25);
    assert.equal(estimate.contingencyPercent, 25);
    assert.equal(estimate.contingencyAmount, estimate.subtotal * 0.25);
    assert.equal(estimate.total, estimate.subtotal * 1.25);
  });

  it("returns an all-zero estimate for no quantities at all", () => {
    const estimate = estimateNetworkCost([]);
    assert.deepEqual(estimate.lineItems, []);
    assert.equal(estimate.subtotal, 0);
    assert.equal(estimate.contingencyAmount, 0);
    assert.equal(estimate.total, 0);
  });
});
