import { useAppStore } from "@geolibre/core";
import { Button, cn } from "@geolibre/ui";
import { Calculator, Map, Menu, Waypoints } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useIsMobileViewport } from "../../hooks/useIsMobileViewport";

type ActiveView = "map" | "design" | "cost";

interface PrimaryNavProps {
  /** Mirrors `layoutOptions.toolbarVisible` — hidden in map-only/embed contexts. */
  visible: boolean;
}

interface NavItem {
  key: ActiveView | "more";
  label: string;
  icon: ReactElement;
  active: boolean;
  onClick: () => void;
}

/**
 * The app's primary navigation: Design / Map / Cost / More. Renders as a
 * left sidebar on wide viewports and a bottom tab bar on narrow ones,
 * mirroring the codebase's existing `md` (768px) breakpoint convention.
 * The map workspace itself is always mounted (see DesktopShell) — this nav
 * only switches which side panel, if any, docks beside it.
 */
export function PrimaryNav({ visible }: PrimaryNavProps): ReactElement | null {
  const { t } = useTranslation();
  const isMobile = useIsMobileViewport();
  const activeView = useAppStore((s) => s.ui.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const moreDrawerOpen = useAppStore((s) => s.ui.moreDrawerOpen);
  const setMoreDrawerOpen = useAppStore((s) => s.setMoreDrawerOpen);

  if (!visible) return null;

  const selectView = (view: ActiveView) => {
    setMoreDrawerOpen(false);
    setActiveView(view);
  };

  const items: NavItem[] = [
    {
      key: "design",
      label: t("nav.design"),
      icon: <Waypoints className="h-5 w-5" aria-hidden="true" />,
      active: !moreDrawerOpen && activeView === "design",
      onClick: () => selectView("design"),
    },
    {
      key: "map",
      label: t("nav.map"),
      icon: <Map className="h-5 w-5" aria-hidden="true" />,
      active: !moreDrawerOpen && activeView === "map",
      onClick: () => selectView("map"),
    },
    {
      key: "cost",
      label: t("nav.cost"),
      icon: <Calculator className="h-5 w-5" aria-hidden="true" />,
      active: !moreDrawerOpen && activeView === "cost",
      onClick: () => selectView("cost"),
    },
    {
      key: "more",
      label: t("nav.more"),
      icon: <Menu className="h-5 w-5" aria-hidden="true" />,
      active: moreDrawerOpen,
      onClick: () => setMoreDrawerOpen(!moreDrawerOpen),
    },
  ];

  return (
    <nav
      aria-label={t("nav.label")}
      className={cn(
        "shrink-0 border-border bg-background",
        isMobile
          ? "order-last flex h-16 w-full items-stretch border-t"
          : "flex w-20 flex-col items-stretch gap-1 border-r p-2",
      )}
    >
      {items.map((item) => (
        <Button
          key={item.key}
          type="button"
          variant="ghost"
          aria-current={item.active ? "page" : undefined}
          onClick={item.onClick}
          className={cn(
            "h-auto flex-1 flex-col gap-1 rounded-lg py-2 text-[11px] font-medium",
            item.active
              ? "text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {item.icon}
          {item.label}
        </Button>
      ))}
    </nav>
  );
}
