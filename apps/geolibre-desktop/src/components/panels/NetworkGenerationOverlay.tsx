import type { GenerateNetworkStage, RoadSourceFallbackEvent } from "@geolibre/utility-network";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

export interface NetworkGenerationRetryInfo {
  attempt: number;
  maxAttempts: number;
  status: number;
}

interface NetworkGenerationOverlayProps {
  /** Current stage, or null when nothing is generating (renders nothing). */
  stage: GenerateNetworkStage | null;
  /** Present while a transient Overpass error (429/502/503/504) is being retried. */
  retry: NetworkGenerationRetryInfo | null;
  /** Present once a country-specific road source failed and generation fell
   * back to OpenStreetMap — see `road-source.ts`. Sticky for the rest of
   * generation (unlike `retry`, this isn't a per-attempt event). */
  roadSourceFallback: RoadSourceFallbackEvent | null;
}

const STEPS: {
  stage: GenerateNetworkStage;
  labelKey: "utilityDesign.progress.fetching" | "utilityDesign.progress.building";
}[] = [
  { stage: "fetching", labelKey: "utilityDesign.progress.fetching" },
  { stage: "building", labelKey: "utilityDesign.progress.building" },
];

function stageIndex(stage: GenerateNetworkStage | null): number {
  return STEPS.findIndex((step) => step.stage === stage);
}

/**
 * Full-screen loading overlay shown while {@link generateNetwork} runs, in
 * place of a bare spinner — real stage checkpoints (not a fabricated percent)
 * plus a small animated network-forming graphic. Deliberately covers the map
 * rather than staying out of the way: generation is a short, focused wait,
 * and a prominent "this is what's happening" screen reads as considered
 * rather than the app just being unresponsive — especially once a retry
 * notice explains an otherwise-mysterious few extra seconds.
 */
export function NetworkGenerationOverlay({
  stage,
  retry,
  roadSourceFallback,
}: NetworkGenerationOverlayProps): ReactElement | null {
  const { t } = useTranslation();
  if (!stage) return null;

  const currentIndex = stageIndex(stage);

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
    >
      <div className="flex w-[min(22rem,90vw)] flex-col items-center gap-5 rounded-2xl border bg-card p-8 text-center shadow-2xl">
        <svg viewBox="0 0 120 100" className="h-20 w-24" aria-hidden="true">
          <line
            x1="20"
            y1="80"
            x2="60"
            y2="20"
            stroke="hsl(var(--primary))"
            strokeWidth="3"
            strokeLinecap="round"
            className="geolibre-gen-line"
            style={{ animationDelay: "0s" }}
          />
          <line
            x1="60"
            y1="20"
            x2="100"
            y2="80"
            stroke="hsl(var(--primary))"
            strokeWidth="3"
            strokeLinecap="round"
            className="geolibre-gen-line"
            style={{ animationDelay: "0.3s" }}
          />
          <line
            x1="100"
            y1="80"
            x2="20"
            y2="80"
            stroke="hsl(var(--primary))"
            strokeWidth="3"
            strokeLinecap="round"
            className="geolibre-gen-line"
            style={{ animationDelay: "0.6s" }}
          />
          <circle
            cx="20"
            cy="80"
            r="6"
            fill="hsl(var(--primary))"
            className="geolibre-gen-node"
            style={{ animationDelay: "0s" }}
          />
          <circle
            cx="60"
            cy="20"
            r="6"
            fill="hsl(var(--primary))"
            className="geolibre-gen-node"
            style={{ animationDelay: "0.3s" }}
          />
          <circle
            cx="100"
            cy="80"
            r="6"
            fill="hsl(var(--primary))"
            className="geolibre-gen-node"
            style={{ animationDelay: "0.6s" }}
          />
        </svg>

        <div className="space-y-1">
          <h2 className="text-base font-semibold">
            {t("utilityDesign.progress.title")}
          </h2>
          <p className="text-sm text-muted-foreground" role={retry ? "alert" : undefined}>
            {retry
              ? t("utilityDesign.progress.retrying", {
                  attempt: retry.attempt,
                  maxAttempts: retry.maxAttempts,
                })
              : stage === "done"
                ? t("utilityDesign.progress.done")
                : t(STEPS[Math.max(currentIndex, 0)]?.labelKey ?? STEPS[0].labelKey)}
          </p>
          {roadSourceFallback ? (
            <p className="text-xs text-muted-foreground" role="status">
              {t("utilityDesign.roadSourceFallback", {
                source: t(`utilityDesign.roadSource.${roadSourceFallback.attemptedSource}`),
              })}
            </p>
          ) : null}
        </div>

        <ol className="flex w-full flex-col gap-2 text-left text-xs">
          {STEPS.map((step, i) => {
            const isDone = currentIndex > i || stage === "done";
            const isActive = currentIndex === i && !isDone;
            return (
              <li key={step.stage} className="flex items-center gap-2">
                <span
                  className={
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] transition-colors " +
                    (isDone
                      ? "border-primary bg-primary text-primary-foreground"
                      : isActive
                        ? "border-primary text-primary"
                        : "border-muted-foreground/30 text-muted-foreground/50")
                  }
                  aria-hidden="true"
                >
                  {isDone ? "✓" : ""}
                </span>
                <span
                  className={
                    isDone || isActive
                      ? "text-foreground"
                      : "text-muted-foreground/60"
                  }
                >
                  {t(step.labelKey)}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
