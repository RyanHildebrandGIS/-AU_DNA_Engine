import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { isGeoEditorAvailableForImport, SKETCHES_SOURCE_KIND } from "@geolibre/plugins";
import { generateNetwork } from "@geolibre/utility-network";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  Separator,
  Slider,
} from "@geolibre/ui";
import type { Feature, MultiPolygon, Point, Polygon, FeatureCollection } from "geojson";
import { Crosshair, Waypoints } from "lucide-react";
import maplibregl from "maplibre-gl";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { createAppAPI, getPluginManager } from "../../hooks/usePlugins";

const GEO_EDITOR_PLUGIN_ID = "maplibre-gl-geo-editor";
const DEFAULT_SPACING_KM = 0.2;

type UtilityType = "water" | "sewer" | "stormwater" | "electric" | "fiber";

const UTILITY_TYPES: UtilityType[] = [
  "water",
  "sewer",
  "stormwater",
  "electric",
  "fiber",
];

interface GeneratedResult {
  junctionsLayerId: string;
  linesLayerId: string;
  junctionCount: number;
  lineCount: number;
  totalKm: number;
  truncated: boolean;
}

interface UtilityDesignDialogProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

/** First Polygon/MultiPolygon feature in a layer, or null. */
function findAreaFeature(
  layer: GeoLibreLayer | undefined,
): Feature<Polygon | MultiPolygon> | null {
  const feature = layer?.geojson?.features?.find(
    (f) => f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon",
  );
  return (feature as Feature<Polygon | MultiPolygon> | undefined) ?? null;
}

/** Total vertex count across all rings of a Polygon/MultiPolygon (last ring point excluded). */
function countVertices(feature: Feature<Polygon | MultiPolygon>): number {
  const rings =
    feature.geometry.type === "Polygon"
      ? feature.geometry.coordinates
      : feature.geometry.coordinates.flat();
  return rings.reduce((sum, ring) => sum + Math.max(0, ring.length - 1), 0);
}

function StepBadge({ done, n }: { done: boolean; n: number }): ReactElement {
  return (
    <span
      className={
        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] " +
        (done
          ? "bg-primary text-primary-foreground"
          : "border border-muted-foreground/40 text-muted-foreground")
      }
      aria-hidden="true"
    >
      {done ? "✓" : n}
    </span>
  );
}

/**
 * A guided, checklist-style wizard for the automated utility-design feature:
 * draw a project area, pick a source point, choose a utility type and
 * spacing, then generate a junction/line network via
 * {@link generateNetwork} directly (no LLM, no API key). The AI assistant's
 * `generate_utility_network` tool (lib/assistant/tools.ts) covers the same
 * capability conversationally; this dialog is the discoverable, one-click
 * front door to it.
 */
export function UtilityDesignDialog({
  mapControllerRef,
}: UtilityDesignDialogProps): ReactElement {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.utilityDesignOpen);
  const setOpen = useAppStore((s) => s.setUtilityDesignOpen);
  const sketchesLayer = useAppStore((s) =>
    s.layers.find((layer) => layer.metadata.sourceKind === SKETCHES_SOURCE_KIND),
  );
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const removeLayer = useAppStore((s) => s.removeLayer);

  const [utilityType, setUtilityType] = useState<UtilityType>("water");
  const [spacingKm, setSpacingKm] = useState(DEFAULT_SPACING_KM);
  const [source, setSource] = useState<{ lon: number; lat: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const [result, setResult] = useState<GeneratedResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const markerRef = useRef<maplibregl.Marker | null>(null);

  const areaFeature = useMemo(() => findAreaFeature(sketchesLayer), [sketchesLayer]);
  const vertexCount = useMemo(
    () => (areaFeature ? countVertices(areaFeature) : 0),
    [areaFeature],
  );

  const getMap = useCallback(
    () => mapControllerRef.current?.getMap() ?? null,
    [mapControllerRef],
  );

  const handleActivateEditor = useCallback(() => {
    if (isGeoEditorAvailableForImport()) return;
    const manager = getPluginManager();
    if (manager.isActive(GEO_EDITOR_PLUGIN_ID)) return;
    const activate = () =>
      manager.activate(GEO_EDITOR_PLUGIN_ID, createAppAPI(mapControllerRef));
    // The editor reads the live map style to derive its drawing styles; if a
    // basemap style is still loading (e.g. right after app start), activating
    // immediately throws inside the plugin. Defer to the map's `load` event
    // in that case instead of activating against a half-initialized style.
    const map = getMap();
    if (!map || map.isStyleLoaded()) {
      activate();
    } else {
      map.once("load", activate);
    }
  }, [mapControllerRef, getMap]);

  // Close the dialog while picking so the map underneath is clickable, then
  // reopen once a point is captured or the pick is cancelled — same pattern
  // as FieldCollectionDialog's point-pick flow.
  const handlePickSource = useCallback(() => {
    setPicking(true);
    setOpen(false);
  }, [setOpen]);

  useEffect(() => {
    if (!picking) return;
    const map = getMap();
    if (!map) {
      setPicking(false);
      setOpen(true);
      return;
    }
    const prevCursor = map.getCanvas().style.cursor;
    map.getCanvas().style.cursor = "crosshair";
    const handleClick = (e: maplibregl.MapMouseEvent) => {
      setSource({ lon: e.lngLat.lng, lat: e.lngLat.lat });
      setPicking(false);
      setOpen(true);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPicking(false);
      setOpen(true);
    };
    map.once("click", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      map.off("click", handleClick);
      window.removeEventListener("keydown", handleKey);
      map.getCanvas().style.cursor = prevCursor;
    };
  }, [picking, getMap, setOpen]);

  // Show a temporary marker for the picked source point (not a saved layer).
  useEffect(() => {
    const map = getMap();
    if (!map || !source) return;
    const marker = new maplibregl.Marker({ color: "#c0392b" })
      .setLngLat([source.lon, source.lat])
      .addTo(map);
    markerRef.current = marker;
    return () => {
      marker.remove();
      if (markerRef.current === marker) markerRef.current = null;
    };
  }, [source, getMap]);

  const canGenerate = Boolean(areaFeature) && Boolean(source);

  const handleGenerate = useCallback(() => {
    if (!areaFeature || !source) return;
    setError(null);
    try {
      const sourceFeature: Feature<Point> = {
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [source.lon, source.lat] },
      };
      const generated = generateNetwork(areaFeature, sourceFeature, {
        utilityType,
        spacingKm,
      });
      if (result) {
        removeLayer(result.junctionsLayerId);
        removeLayer(result.linesLayerId);
      }
      const label = utilityType.charAt(0).toUpperCase() + utilityType.slice(1);
      const junctionsLayerId = addGeoJsonLayer(
        `${label} junctions`,
        generated.junctions as unknown as FeatureCollection,
      );
      const linesLayerId = addGeoJsonLayer(
        `${label} network lines`,
        generated.lines as unknown as FeatureCollection,
      );
      const totalKm = generated.lines.features.reduce(
        (sum, feature) => sum + feature.properties.length_km,
        0,
      );
      setResult({
        junctionsLayerId,
        linesLayerId,
        junctionCount: generated.junctions.features.length,
        lineCount: generated.lines.features.length,
        totalKm,
        truncated: generated.truncated,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [areaFeature, source, utilityType, spacingKm, result, addGeoJsonLayer, removeLayer]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) setOpen(false);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("utilityDesign.title")}</DialogTitle>
          <DialogDescription>{t("utilityDesign.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-sm">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 font-medium">
              <StepBadge done={Boolean(areaFeature)} n={1} />
              {t("utilityDesign.step1Title")}
            </div>
            {areaFeature ? (
              <p className="pl-7 text-xs text-muted-foreground">
                {t("utilityDesign.step1Done", { count: vertexCount })}
              </p>
            ) : (
              <div className="flex flex-col gap-1.5 pl-7">
                <p className="text-xs text-muted-foreground">
                  {t("utilityDesign.step1Instructions")}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  className="w-fit"
                  onClick={handleActivateEditor}
                >
                  {t("utilityDesign.step1Button")}
                </Button>
              </div>
            )}
          </div>

          <Separator />

          <div className="flex flex-col gap-1.5">
            <Label className="flex items-center gap-2 font-medium">
              <StepBadge done n={2} />
              {t("utilityDesign.step2Title")}
            </Label>
            <div className="pl-7">
              <Select
                value={utilityType}
                onChange={(e) => setUtilityType(e.target.value as UtilityType)}
                className="max-w-[220px]"
              >
                {UTILITY_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`utilityDesign.type.${type}`)}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <Separator />

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 font-medium">
              <StepBadge done={Boolean(source)} n={3} />
              {t("utilityDesign.step3Title")}
            </div>
            <div className="flex flex-col gap-1.5 pl-7">
              <p className="text-xs text-muted-foreground">
                {source
                  ? t("utilityDesign.step3Done", {
                      lon: source.lon.toFixed(5),
                      lat: source.lat.toFixed(5),
                    })
                  : t("utilityDesign.step3Instructions")}
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="w-fit gap-1.5"
                onClick={handlePickSource}
              >
                <Crosshair className="h-3.5 w-3.5" />
                {t("utilityDesign.step3Button")}
              </Button>
            </div>
          </div>

          <Separator />

          <div className="flex flex-col gap-1.5">
            <Label className="flex items-center gap-2 font-medium">
              <StepBadge done n={4} />
              {t("utilityDesign.step4Title")}
            </Label>
            <div className="flex flex-col gap-1 pl-7">
              <div className="flex items-center gap-3">
                <Slider
                  value={[spacingKm]}
                  onValueChange={(values: number[]) => setSpacingKm(values[0])}
                  min={0.05}
                  max={2}
                  step={0.05}
                  aria-label={t("utilityDesign.step4Title")}
                  className="max-w-[200px]"
                />
                <span className="font-mono text-xs tabular-nums">
                  {spacingKm.toFixed(2)} km
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("utilityDesign.step4Helper")}
              </p>
            </div>
          </div>

          <Separator />

          <div className="flex flex-col gap-2">
            <Button disabled={!canGenerate} onClick={handleGenerate} className="gap-1.5">
              <Waypoints className="h-4 w-4" />
              {result ? t("utilityDesign.regenerate") : t("utilityDesign.generate")}
            </Button>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {result ? (
              <p className="text-xs text-muted-foreground">
                {t("utilityDesign.resultSummary", {
                  junctions: result.junctionCount,
                  lines: result.lineCount,
                  km: result.totalKm.toFixed(2),
                })}
                {result.truncated ? ` ${t("utilityDesign.resultTruncated")}` : ""}
              </p>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
