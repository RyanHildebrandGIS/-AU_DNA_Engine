import { Calculator } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@geolibre/core";

/**
 * Placeholder for the Cost nav destination — no estimation logic yet, just
 * reserves the UI slot. Same non-modal side-panel shell as
 * UtilityDesignDialog, so it docks beside the always-visible map exactly the
 * same way.
 */
export function CostPanel(): ReactElement | null {
  const { t } = useTranslation();
  const active = useAppStore((s) => s.ui.activeView === "cost");

  if (!active) return null;

  // `bottom-16` (not `bottom-0`) leaves room for PrimaryNav's h-16 bottom tab
  // bar on narrow viewports, so this bottom sheet doesn't cover it.
  return (
    <aside
      aria-label={t("cost.title")}
      className="relative flex max-h-[min(28rem,50vh)] w-full shrink-0 flex-col items-center justify-center gap-3 border-t bg-card p-6 text-center max-md:fixed max-md:inset-x-0 max-md:bottom-16 max-md:z-30 max-md:shadow-xl md:max-h-none md:w-96 md:border-l md:border-t-0"
    >
      <Calculator className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{t("cost.comingSoon")}</p>
    </aside>
  );
}
