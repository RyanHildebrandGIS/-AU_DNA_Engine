import { Calculator, RotateCcw } from "lucide-react";
import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@geolibre/core";
import {
  DEFAULT_CONTINGENCY_PERCENT,
  DEFAULT_UNIT_COSTS,
  estimateNetworkCost,
  type UnitCosts,
} from "@geolibre/utility-network";
import {
  Button,
  Input,
  Label,
  Separator,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@geolibre/ui";
import {
  loadContingencyPercentOverride,
  loadCostRateOverrides,
  resetAllCostSettings,
  saveContingencyPercentOverride,
  saveCostRateOverrides,
} from "../../lib/cost-rate-overrides";
import { deriveNetworkQuantities } from "../../lib/utility-network-layers";
import { UTILITY_TYPES } from "../../lib/utility-types";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function formatCurrency(value: number): string {
  return currencyFormatter.format(value);
}

interface RateInputProps {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}

function RateInput({ id, label, value, onChange }: RateInputProps): ReactElement {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={0}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-7 w-20 text-xs"
      />
    </div>
  );
}

/**
 * Planning-level cost estimate for every utility network currently in the
 * project (read straight off the map layers `UtilityDesignDialog` tags via
 * `deriveNetworkQuantities` — not a separate parallel record, so it can
 * never drift from what's actually on the map), priced against an editable
 * unit-cost template. The template ships with generic default averages
 * (`DEFAULT_UNIT_COSTS`) and is always visible/editable here regardless of
 * whether anything's been generated yet, so a user can review and adjust
 * costs to their own project up front. Edits persist across sessions via
 * `cost-rate-overrides.ts` (localStorage), not yet part of the saved project
 * file itself — see that module's doc comment.
 */
export function CostPanel(): ReactElement | null {
  const { t } = useTranslation();
  const active = useAppStore((s) => s.ui.activeView === "cost");
  const layers = useAppStore((s) => s.layers);

  const [unitCostOverrides, setUnitCostOverrides] = useState<
    Record<string, UnitCosts>
  >(() => loadCostRateOverrides());
  const [contingencyPercent, setContingencyPercent] = useState<number>(
    () => loadContingencyPercentOverride() ?? DEFAULT_CONTINGENCY_PERCENT,
  );

  const mergedUnitCosts = useMemo<Record<string, UnitCosts>>(
    () => ({ ...DEFAULT_UNIT_COSTS, ...unitCostOverrides }),
    [unitCostOverrides],
  );

  const quantities = useMemo(() => deriveNetworkQuantities(layers), [layers]);
  const estimate = useMemo(
    () => estimateNetworkCost(quantities, mergedUnitCosts, contingencyPercent),
    [quantities, mergedUnitCosts, contingencyPercent],
  );

  if (!active) return null;

  const handleRateChange = (
    utilityType: string,
    field: keyof UnitCosts,
    value: number,
  ): void => {
    if (!Number.isFinite(value) || value < 0) return;
    const next: Record<string, UnitCosts> = {
      ...unitCostOverrides,
      [utilityType]: { ...mergedUnitCosts[utilityType], [field]: value },
    };
    setUnitCostOverrides(next);
    saveCostRateOverrides(next);
  };

  const handleContingencyChange = (value: number): void => {
    if (!Number.isFinite(value) || value < 0) return;
    setContingencyPercent(value);
    saveContingencyPercentOverride(value);
  };

  const handleReset = (): void => {
    resetAllCostSettings();
    setUnitCostOverrides({});
    setContingencyPercent(DEFAULT_CONTINGENCY_PERCENT);
  };

  // `bottom-16` (not `bottom-0`) leaves room for PrimaryNav's h-16 bottom tab
  // bar on narrow viewports, matching the Design panel's mobile sheet.
  return (
    <aside
      aria-label={t("cost.title")}
      className="relative flex h-[min(34rem,75vh)] supports-[max-height:1dvh]:h-[min(34rem,75dvh)] w-full shrink-0 flex-col overflow-hidden border-t bg-card max-md:fixed max-md:inset-x-0 max-md:bottom-16 max-md:z-30 max-md:shadow-xl md:h-auto md:w-96 md:border-l md:border-t-0"
    >
      <div className="flex items-center gap-2 border-b p-4">
        <Calculator className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div>
          <h2 className="text-lg font-semibold leading-none tracking-tight">
            {t("cost.title")}
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t("cost.description")}
          </p>
        </div>
      </div>

      <div
        className="h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
        style={{ touchAction: "pan-y" }}
      >
        <div className="flex flex-col gap-4 p-4 text-sm">
          {quantities.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("cost.emptyState")}</p>
          ) : (
            <>
              <div className="flex flex-col gap-1 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t("cost.subtotal")}</span>
                  <span className="font-mono tabular-nums">
                    {formatCurrency(estimate.subtotal)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {t("cost.contingency", { percent: estimate.contingencyPercent })}
                  </span>
                  <span className="font-mono tabular-nums">
                    {formatCurrency(estimate.contingencyAmount)}
                  </span>
                </div>
                <Separator className="my-1" />
                <div className="flex items-center justify-between text-base font-semibold">
                  <span>{t("cost.total")}</span>
                  <span className="font-mono tabular-nums">
                    {formatCurrency(estimate.total)}
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label className="font-medium">{t("cost.lineItemsTitle")}</Label>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("cost.columnUtility")}</TableHead>
                      <TableHead>{t("cost.columnComponent")}</TableHead>
                      <TableHead className="text-right">
                        {t("cost.columnQuantity")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("cost.columnTotal")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {estimate.lineItems.map((item) => (
                      <TableRow key={`${item.utilityType}-${item.component}`}>
                        <TableCell>
                          {t(`utilityDesign.type.${item.utilityType}`, {
                            defaultValue: item.utilityType,
                          })}
                        </TableCell>
                        <TableCell>{t(`cost.component.${item.component}`)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {item.unit === "m"
                            ? `${item.quantity.toFixed(0)} m`
                            : item.quantity}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {formatCurrency(item.total)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}

          <Separator />

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label className="font-medium">{t("cost.rateTemplateTitle")}</Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                onClick={handleReset}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("cost.resetDefaults")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("cost.rateTemplateHelper")}
            </p>

            <div className="flex items-center gap-1.5">
              <Label
                htmlFor="cost-contingency"
                className="text-xs font-normal text-muted-foreground"
              >
                {t("cost.contingencyLabel")}
              </Label>
              <Input
                id="cost-contingency"
                type="number"
                min={0}
                step={1}
                value={contingencyPercent}
                onChange={(e) => handleContingencyChange(Number(e.target.value))}
                className="h-7 w-20 text-xs"
              />
              <span className="text-xs text-muted-foreground">%</span>
            </div>

            {UTILITY_TYPES.map((utilityType) => {
              const rates = mergedUnitCosts[utilityType];
              return (
                <div
                  key={utilityType}
                  className="flex flex-col gap-1.5 rounded-md border p-2"
                >
                  <span className="text-xs font-medium">
                    {t(`utilityDesign.type.${utilityType}`)}
                  </span>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <RateInput
                      id={`cost-${utilityType}-main`}
                      label={t("cost.mainCostLabel")}
                      value={rates.mainCostPerMeter}
                      onChange={(v) =>
                        handleRateChange(utilityType, "mainCostPerMeter", v)
                      }
                    />
                    <RateInput
                      id={`cost-${utilityType}-junction`}
                      label={t("cost.junctionCostLabel")}
                      value={rates.junctionCost}
                      onChange={(v) =>
                        handleRateChange(utilityType, "junctionCost", v)
                      }
                    />
                    <RateInput
                      id={`cost-${utilityType}-service`}
                      label={t("cost.serviceCostLabel")}
                      value={rates.serviceCost}
                      onChange={(v) =>
                        handleRateChange(utilityType, "serviceCost", v)
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
}
