import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  cancelGeoEditorDraw,
  isGeoEditorAvailableForImport,
  SKETCHES_SOURCE_KIND,
  startGeoEditorDrawMode,
} from "@geolibre/plugins";
import { generateNetwork, type NetworkSide } from "@geolibre/utility-network";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
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
import {
  hasOsmRoadFetchConsent,
  recordOsmRoadFetchConsent,
} from "../../lib/osm-road-fetch-consent";

const DEFAULT_OFFSET_METERS = 3;
const NETWORK_SIDES: NetworkSide[] = ["left", "right", "both"];

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
 * A guided, checklist-style panel for the automated utility-design feature:
 * draw a project area, pick a source point, choose a utility type and
 * spacing, then generate a junction/line network via
 * {@link generateNetwork} directly (no LLM, no API key). The AI assistant's
 * `generate_utility_network` tool (lib/assistant/tools.ts) covers the same
 * capability conversationally; this panel is the discoverable, one-click
 * front door to it.
 *
 * Rendered as a non-modal side panel (docked beside the map, same shell as
 * StylePanel) rather than a dialog, so the map stays visible and clickable
 * the whole time — steps 1 and 3 both require interacting with the live map
 * while these instructions are showing.
 */
export function UtilityDesignDialog({
  mapControllerRef,
}: UtilityDesignDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const active = useAppStore((s) => s.ui.activeView === "design");
  const sketchesLayer = useAppStore((s) =>
    s.layers.find((layer) => layer.metadata.sourceKind === SKETCHES_SOURCE_KIND),
  );
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const removeLayer = useAppStore((s) => s.removeLayer);

  const [utilityType, setUtilityType] = useState<UtilityType>("water");
  const [spacingKm, setSpacingKm] = useState(DEFAULT_SPACING_KM);
  const [side, setSide] = useState<NetworkSide>("right");
  const [offsetMeters, setOffsetMeters] = useState(DEFAULT_OFFSET_METERS);
  const [source, setSource] = useState<{ lon: number; lat: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const [drawingArea, setDrawingArea] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [consentNoticeOpen, setConsentNoticeOpen] = useState(false);
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

  // One click: ensure the editor is active, then jump straight into polygon
  // draw mode — the user never has to find the right tool among the
  // editor's general-purpose toolbar (draw/edit/file modes).
  const handleDrawArea = useCallback(() => {
    const enterDrawMode = () => {
      startGeoEditorDrawMode("polygon");
      setDrawingArea(true);
    };
    const manager = getPluginManager();
    if (isGeoEditorAvailableForImport() || manager.isActive(GEO_EDITOR_PLUGIN_ID)) {
      enterDrawMode();
      return;
    }
    const activate = () => {
      manager.activate(GEO_EDITOR_PLUGIN_ID, createAppAPI(mapControllerRef));
      enterDrawMode();
    };
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

  const handleCancelDrawArea = useCallback(() => {
    cancelGeoEditorDraw();
    setDrawingArea(false);
  }, []);

  // The draw finishes when the polygon lands in the Sketches store layer
  // (reactive, same as the rest of this component's step-1 detection) —
  // no need to listen for the editor's own mode-change event.
  useEffect(() => {
    if (drawingArea && areaFeature) setDrawingArea(false);
  }, [drawingArea, areaFeature]);

  // Escape cancels the in-progress draw, mirroring the point-pick flow below.
  useEffect(() => {
    if (!drawingArea) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      handleCancelDrawArea();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [drawingArea, handleCancelDrawArea]);

  // The panel is non-modal (docked beside the map, never an overlay), so the
  // map underneath is already clickable — no need to hide anything while
  // picking, unlike FieldCollectionDialog's modal point-pick flow.
  const handlePickSource = useCallback(() => {
    setPicking(true);
  }, []);

  useEffect(() => {
    if (!picking) return;
    const map = getMap();
    if (!map) {
      setPicking(false);
      return;
    }
    const prevCursor = map.getCanvas().style.cursor;
    map.getCanvas().style.cursor = "crosshair";
    const handleClick = (e: maplibregl.MapMouseEvent) => {
      setSource({ lon: e.lngLat.lng, lat: e.lngLat.lat });
      setPicking(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPicking(false);
    };
    map.once("click", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      map.off("click", handleClick);
      window.removeEventListener("keydown", handleKey);
      map.getCanvas().style.cursor = prevCursor;
    };
  }, [picking, getMap]);

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

  const canGenerate = Boolean(areaFeature) && Boolean(source) && !generating;

  // Fetches real road data and generates the network — a genuine network
  // round-trip now (unlike the old grid layout), hence `generating`.
  const runGenerate = useCallback(async () => {
    if (!areaFeature || !source) return;
    setError(null);
    setGenerating(true);
    try {
      const sourceFeature: Feature<Point> = {
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [source.lon, source.lat] },
      };
      const generated = await generateNetwork(areaFeature, sourceFeature, {
        utilityType,
        spacingKm,
        offsetMeters,
        side,
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
    } finally {
      setGenerating(false);
    }
  }, [
    areaFeature,
    source,
    utilityType,
    spacingKm,
    offsetMeters,
    side,
    result,
    addGeoJsonLayer,
    removeLayer,
  ]);

  // Generating sends the drawn area's coordinates to the public Overpass API,
  // so the first click shows a one-time consent notice (mirrors the network
  // routing/Valhalla consent gate elsewhere in the app).
  const handleGenerateClick = useCallback(() => {
    if (!hasOsmRoadFetchConsent()) {
      setConsentNoticeOpen(true);
      return;
    }
    void runGenerate();
  }, [runGenerate]);

  const confirmConsentAndGenerate = useCallback(() => {
    recordOsmRoadFetchConsent();
    setConsentNoticeOpen(false);
    void runGenerate();
  }, [runGenerate]);

  if (!active) return null;

  // `bottom-16` (not `bottom-0`) leaves room for PrimaryNav's h-16 bottom tab
  // bar on narrow viewports, so this bottom sheet doesn't cover it.
  return (
    <>
      {drawingArea ? (
        <div
          role="status"
          className="pointer-events-none fixed left-1/2 top-4 z-40 -translate-x-1/2 rounded-full border bg-background px-4 py-2 text-sm shadow-lg"
        >
          {t("utilityDesign.step1Drawing")}
        </div>
      ) : null}
      <aside
        aria-label={t("utilityDesign.title")}
        className="relative flex h-[min(34rem,75vh)] supports-[max-height:1dvh]:h-[min(34rem,75dvh)] w-full shrink-0 flex-col overflow-hidden border-t bg-card max-md:fixed max-md:inset-x-0 max-md:bottom-16 max-md:z-30 max-md:shadow-xl md:h-auto md:w-96 md:border-l md:border-t-0"
      >
      <div className="border-b p-4">
        <h2 className="text-lg font-semibold leading-none tracking-tight">
          {t("utilityDesign.title")}
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {t("utilityDesign.description")}
        </p>
      </div>

      {/* Plain native scroll (not the Radix ScrollArea used elsewhere in the
          app) — its custom-scrollbar viewport fights percentage-height
          resolution in a fixed-position mobile sheet, and native
          overflow-y-auto is the most reliable option for touch scrolling on
          iOS Safari. */}
      <div
        className="h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
        style={{ touchAction: "pan-y" }}
      >
        <div className="flex flex-col gap-4 p-4 text-sm">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 font-medium">
              <StepBadge done={Boolean(areaFeature)} n={1} />
              {t("utilityDesign.step1Title")}
            </div>
            {areaFeature ? (
              <p className="pl-7 text-xs text-muted-foreground">
                {t("utilityDesign.step1Done", { count: vertexCount })}
              </p>
            ) : drawingArea ? (
              <div className="flex flex-col gap-1.5 pl-7">
                <p className="text-xs text-muted-foreground">
                  {t("utilityDesign.step1Drawing")}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  onClick={handleCancelDrawArea}
                >
                  {t("utilityDesign.step1Cancel")}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 pl-7">
                <p className="text-xs text-muted-foreground">
                  {t("utilityDesign.step1Instructions")}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  className="w-fit"
                  onClick={handleDrawArea}
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

          <div className="flex flex-col gap-1.5">
            <Label className="font-medium">{t("utilityDesign.sideTitle")}</Label>
            <div className="flex flex-col gap-2 pl-0">
              <Select
                value={side}
                onChange={(e) => setSide(e.target.value as NetworkSide)}
                className="max-w-[220px]"
              >
                {NETWORK_SIDES.map((s) => (
                  <option key={s} value={s}>
                    {t(`utilityDesign.side.${s}`)}
                  </option>
                ))}
              </Select>
              <div className="flex items-center gap-2">
                <Label htmlFor="utility-offset-meters" className="text-xs font-normal text-muted-foreground">
                  {t("utilityDesign.offsetLabel")}
                </Label>
                <Input
                  id="utility-offset-meters"
                  type="number"
                  min={0}
                  step={0.5}
                  value={offsetMeters}
                  onChange={(e) => setOffsetMeters(Number(e.target.value))}
                  className="h-8 w-20"
                />
                <span className="text-xs text-muted-foreground">m</span>
              </div>
            </div>
          </div>

          <Separator />

          <div className="flex flex-col gap-2">
            <Button
              disabled={!canGenerate}
              onClick={handleGenerateClick}
              className="gap-1.5"
            >
              <Waypoints className="h-4 w-4" />
              {generating
                ? t("utilityDesign.generating")
                : result
                  ? t("utilityDesign.regenerate")
                  : t("utilityDesign.generate")}
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
      </div>
      </aside>
      <Dialog open={consentNoticeOpen} onOpenChange={setConsentNoticeOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("utilityDesign.roadNoticeTitle")}</DialogTitle>
            <DialogDescription>
              {t("utilityDesign.roadNoticeDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConsentNoticeOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={confirmConsentAndGenerate}>
              {t("toolbar.item.continue")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
