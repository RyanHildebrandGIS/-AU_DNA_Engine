import { useAppStore } from "@geolibre/core";
import { Paperclip } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

/**
 * A small floating "Clippy"-style mascot over the map — bobs gently and
 * blinks on its own, and opens the AI Assistant on click. The assistant
 * otherwise has no dedicated, always-visible entry point (it's tucked in the
 * Processing menu and the command palette), so this exists to make it more
 * discoverable, and a bit more fun, than a plain toolbar icon.
 *
 * Hidden while the assistant panel is already open — the same way the real
 * Clippy stepped aside once you were mid-conversation, rather than lingering
 * beside its own dialog.
 */
export function AssistantMascot(): ReactElement {
  const { t } = useTranslation();
  const setAssistantOpen = useAppStore((s) => s.setAssistantOpen);

  return (
    <button
      type="button"
      onClick={() => setAssistantOpen(true)}
      title={t("assistant.mascotTooltip")}
      aria-label={t("assistant.mascotTooltip")}
      className="geolibre-mascot-bob group pointer-events-auto absolute bottom-6 right-6 z-30 flex h-14 w-14 items-center justify-center rounded-full border bg-card shadow-lg transition-transform hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      {/* Face: two blinking eyes and a pair of eyebrows that lift on hover. */}
      <span className="pointer-events-none flex -translate-y-1 flex-col items-center gap-1.5">
        <span className="flex gap-2 transition-transform group-hover:-translate-y-0.5">
          <span className="h-0.5 w-2 -rotate-[20deg] rounded-full bg-foreground/70" aria-hidden="true" />
          <span className="h-0.5 w-2 rotate-[20deg] rounded-full bg-foreground/70" aria-hidden="true" />
        </span>
        <span className="flex gap-2" aria-hidden="true">
          <span className="geolibre-mascot-eye h-1.5 w-1.5 rounded-full bg-foreground" />
          <span className="geolibre-mascot-eye h-1.5 w-1.5 rounded-full bg-foreground" />
        </span>
      </span>
      {/* Paperclip badge, signaling "Clippy" without drawing the loop itself. */}
      <span
        className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground transition-transform group-hover:rotate-12"
        aria-hidden="true"
      >
        <Paperclip className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}
