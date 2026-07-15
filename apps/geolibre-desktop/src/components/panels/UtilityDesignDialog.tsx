import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  cancelGeoEditorDraw,
  isGeoEditorAvailableForImport,
  SKETCHES_SOURCE_KIND,
  startGeoEditorDrawMode,
} from "@geolibre/plugins";
import {
  generateNetwork,
  MIN_OFFSET_METERS,
  DEFAULT_MAX_DEAD_END_KM,
  DEFAULT_HYDRANT_SPACING_KM,
  type GenerateNetworkStage,
  type NetworkCoverage,
  type NetworkSide,
  type RoadSourceFallbackEvent,
  type RoadSourceId,
} from "@geolibre/utility-network";
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
import { Crosshair, Loader2, Waypoints } from "lucide-react";
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
import { useIsMobileViewport } from "../../hooks/useIsMobileViewport";
import {
  hasOsmRoadFetchConsent,
  recordOsmRoadFetchConsent,
} from "../../lib/osm-road-fetch-consent";
import { utilityNetworkLayerMetadata } from "../../lib/utility-network-layers";
import { UTILITY_TYPES, type UtilityType } from "../../lib/utility-types";
import {
  NetworkGenerationOverlay,
  type NetworkGenerationRetryInfo,
} from "./NetworkGenerationOverlay";

const DEFAULT_OFFSET_METERS = 3;
const NETWORK_SIDES: NetworkSide[] = ["left", "right", "both"];
const NETWORK_COVERAGES: NetworkCoverage[] = ["mainline", "mainlineAndServices"];
const ROAD_SOURCES: RoadSourceId[] = ["auto", "osm", "tigerweb", "nrn"];

const GEO_EDITOR_PLUGIN_ID = "maplibre-gl-geo-editor";
const DEFAULT_SPACING_KM = 0.2;

interface GeneratedResult {
  junctionsLayerId: string;
  linesLayerId: string;
  servicesLayerId: string | null;
  hydrantsLayerId: string | null;
  junctionCount: number;
  lineCount: number;
  serviceCount: number;
  hydrantCount: number;
  totalKm: number;
  truncated: boolean;
  servicesTruncated: boolean;
  servicesBlocked: boolean;
  servicesBlockedCount: number;
  deadEndsExceedingMaxLength: number;
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
  const setActiveView = useAppStore((s) => s.setActiveView);
  const isMobile = useIsMobileViewport();
  const sketchesLayer = useAppStore((s) =>
    s.layers.find((layer) => layer.metadata.sourceKind === SKETCHES_SOURCE_KIND),
  );
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const removeLayer = useAppStore((s) => s.removeLayer);

  // On a narrow viewport, Design and Map are separate tabs (bottom bar) and
  // this panel becomes a bottom sheet covering most of the screen — so a
  // map-drawing/picking action needs to switch to the Map tab first, or the
  // user can't see (or reach) the map to actually do it. On a wide viewport
  // the map is already fully visible beside this panel, so switching away
  // would just hide the panel for no reason.
  const switchToMapForAction = useCallback(() => {
    if (isMobile) setActiveView("map");
  }, [isMobile, setActiveView]);
  const switchBackFromMapAction = useCallback(() => {
    if (isMobile) setActiveView("design");
  }, [isMobile, setActiveView]);

  const [utilityType, setUtilityType] = useState<UtilityType>("water");
  const [spacingKm, setSpacingKm] = useState(DEFAULT_SPACING_KM);
  const [side, setSide] = useState<NetworkSide>("right");
  const [offsetMeters, setOffsetMeters] = useState(DEFAULT_OFFSET_METERS);
  const [coverage, setCoverage] = useState<NetworkCoverage>("mainline");
  const [junctionsAtServiceTaps, setJunctionsAtServiceTaps] = useState(false);
  const [excludePrivateAccess, setExcludePrivateAccess] = useState(false);
  const [maxDeadEndKm, setMaxDeadEndKm] = useState(DEFAULT_MAX_DEAD_END_KM);
  const [includeHydrants, setIncludeHydrants] = useState(false);
  const [hydrantSpacingKm, setHydrantSpacingKm] = useState(DEFAULT_HYDRANT_SPACING_KM);
  const [roadSource, setRoadSource] = useState<RoadSourceId>("auto");
  const [source, setSource] = useState<{ lon: number; lat: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const [drawingArea, setDrawingArea] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progressStage, setProgressStage] = useState<GenerateNetworkStage | null>(null);
  const [progressRetry, setProgressRetry] = useState<NetworkGenerationRetryInfo | null>(null);
  const [progressRoadSourceFallback, setProgressRoadSourceFallback] =
    useState<RoadSourceFallbackEvent | null>(null);
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
    switchToMapForAction();
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
    // immediately throws inside the plugin. `load` only ever fires once for a
    // map instance's *first* style, so if it already fired before this runs
    // (the common case — the user took at least a moment to click after the
    // app opened), `map.once("load", activate)` would wait forever and this
    // button would silently do nothing on that click. Poll via `styledata`
    // (which fires repeatedly while a style loads) and re-check
    // `isStyleLoaded()` each time instead, so this works regardless of
    // whether the load event already passed. If the map controller itself
    // isn't attached yet (very first paint), retry shortly rather than
    // activating against a nonexistent map, which would silently skip the
    // editor's map-dependent setup.
    const waitForMapReady = () => {
      const map = getMap();
      if (!map) {
        window.setTimeout(waitForMapReady, 50);
        return;
      }
      if (map.isStyleLoaded()) {
        activate();
        return;
      }
      const onStyleData = () => {
        if (!map.isStyleLoaded()) return;
        map.off("styledata", onStyleData);
        activate();
      };
      map.on("styledata", onStyleData);
    };
    waitForMapReady();
  }, [getMap, switchToMapForAction, mapControllerRef]);

  const handleCancelDrawArea = useCallback(() => {
    cancelGeoEditorDraw();
    setDrawingArea(false);
    switchBackFromMapAction();
  }, [switchBackFromMapAction]);

  // The draw finishes when the polygon lands in the Sketches store layer
  // (reactive, same as the rest of this component's step-1 detection) —
  // no need to listen for the editor's own mode-change event.
  useEffect(() => {
    if (drawingArea && areaFeature) {
      setDrawingArea(false);
      switchBackFromMapAction();
    }
  }, [drawingArea, areaFeature, switchBackFromMapAction]);

  // Escape cancels the in-progress draw, mirroring the point-pick flow below.
  // Capture phase: the GeoEditor plugin has its own Escape handling for the
  // draw tool itself, and if it runs first and stops the event, our state
  // (and the map-tab switch-back) would never reset. A capture-phase
  // listener on window always runs before any bubble-phase listener.
  useEffect(() => {
    if (!drawingArea) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      handleCancelDrawArea();
    };
    window.addEventListener("keydown", handleKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleKey, { capture: true });
  }, [drawingArea, handleCancelDrawArea]);

  // The panel is non-modal (docked beside the map, never an overlay), so the
  // map underneath is already clickable — no need to hide anything while
  // picking, unlike FieldCollectionDialog's modal point-pick flow.
  const handlePickSource = useCallback(() => {
    switchToMapForAction();
    setPicking(true);
  }, [switchToMapForAction]);

  useEffect(() => {
    if (!picking) return;
    const map = getMap();
    if (!map) {
      setPicking(false);
      switchBackFromMapAction();
      return;
    }
    const prevCursor = map.getCanvas().style.cursor;
    map.getCanvas().style.cursor = "crosshair";
    const handleClick = (e: maplibregl.MapMouseEvent) => {
      setSource({ lon: e.lngLat.lng, lat: e.lngLat.lat });
      setPicking(false);
      switchBackFromMapAction();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPicking(false);
      switchBackFromMapAction();
    };
    map.once("click", handleClick);
    // Capture phase for the same reason as the draw-cancel listener above —
    // runs before any other Escape handling that might stop the event.
    window.addEventListener("keydown", handleKey, { capture: true });
    return () => {
      map.off("click", handleClick);
      window.removeEventListener("keydown", handleKey, { capture: true });
      map.getCanvas().style.cursor = prevCursor;
    };
  }, [picking, getMap, switchBackFromMapAction]);

  // Show a temporary marker for the picked source point (not a saved layer).
  // A native title tooltip on hover clarifies what the pin represents, since
  // otherwise it's an unlabeled red dot on the map.
  useEffect(() => {
    const map = getMap();
    if (!map || !source) return;
    const marker = new maplibregl.Marker({ color: "#c0392b" })
      .setLngLat([source.lon, source.lat])
      .addTo(map);
    marker.getElement().title = t("utilityDesign.sourceMarkerTooltip");
    markerRef.current = marker;
    return () => {
      marker.remove();
      if (markerRef.current === marker) markerRef.current = null;
    };
  }, [source, getMap, t]);

  const canGenerate = Boolean(areaFeature) && Boolean(source) && !generating;

  // Fetches real road data and generates the network — a genuine network
  // round-trip now (unlike the old grid layout), hence `generating`. Switches
  // to the Map tab on mobile for the duration, same as draw/pick, so the
  // user can watch the network appear rather than stare at the Design sheet.
  const runGenerate = useCallback(async () => {
    if (!areaFeature || !source) return;
    setError(null);
    setGenerating(true);
    setProgressStage("fetching");
    setProgressRetry(null);
    setProgressRoadSourceFallback(null);
    switchToMapForAction();
    try {
      const sourceFeature: Feature<Point> = {
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [source.lon, source.lat] },
      };
      const generated = await generateNetwork(
        areaFeature,
        sourceFeature,
        {
          utilityType,
          spacingKm,
          offsetMeters,
          side,
          mode: coverage,
          junctionsAtServiceTaps:
            coverage === "mainlineAndServices" ? junctionsAtServiceTaps : undefined,
          excludePrivateAccess,
          maxDeadEndKm,
          includeHydrants: utilityType === "water" ? includeHydrants : false,
          hydrantSpacingKm,
          roadSource,
        },
        undefined,
        (event) => {
          setProgressStage(event.stage);
          setProgressRetry(event.retry ?? null);
          if (event.roadSourceFallback) {
            setProgressRoadSourceFallback(event.roadSourceFallback);
          }
        },
      );
      if (result) {
        removeLayer(result.junctionsLayerId);
        removeLayer(result.linesLayerId);
        if (result.servicesLayerId) removeLayer(result.servicesLayerId);
        if (result.hydrantsLayerId) removeLayer(result.hydrantsLayerId);
      }
      const label = utilityType.charAt(0).toUpperCase() + utilityType.slice(1);
      const junctionsLayerId = addGeoJsonLayer(
        `${label} junctions`,
        generated.junctions as unknown as FeatureCollection,
        undefined,
        null,
        utilityNetworkLayerMetadata("junctions", utilityType),
      );
      const linesLayerId = addGeoJsonLayer(
        `${label} network lines`,
        generated.lines as unknown as FeatureCollection,
        undefined,
        null,
        utilityNetworkLayerMetadata("lines", utilityType),
      );
      const servicesLayerId =
        generated.services.features.length > 0
          ? addGeoJsonLayer(
              `${label} services`,
              generated.services as unknown as FeatureCollection,
              undefined,
              null,
              utilityNetworkLayerMetadata("services", utilityType),
            )
          : null;
      const hydrantsLayerId =
        generated.hydrants.features.length > 0
          ? addGeoJsonLayer(
              `${label} hydrants`,
              generated.hydrants as unknown as FeatureCollection,
              undefined,
              null,
              utilityNetworkLayerMetadata("hydrants", utilityType),
            )
          : null;
      const totalKm = generated.lines.features.reduce(
        (sum, feature) => sum + feature.properties.length_km,
        0,
      );
      setResult({
        junctionsLayerId,
        linesLayerId,
        servicesLayerId,
        hydrantsLayerId,
        junctionCount: generated.junctions.features.length,
        lineCount: generated.lines.features.length,
        serviceCount: generated.services.features.length,
        hydrantCount: generated.hydrants.features.length,
        totalKm,
        truncated: generated.truncated,
        servicesTruncated: generated.servicesTruncated,
        servicesBlocked: generated.servicesBlocked,
        servicesBlockedCount: generated.servicesBlockedCount,
        deadEndsExceedingMaxLength: generated.deadEndsExceedingMaxLength,
      });
      // Let the overlay's "Done!" checkmark state linger for a beat instead
      // of disappearing the instant the last progress event fires.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
      setProgressStage(null);
      setProgressRetry(null);
      switchBackFromMapAction();
    }
  }, [
    areaFeature,
    source,
    utilityType,
    spacingKm,
    offsetMeters,
    side,
    coverage,
    junctionsAtServiceTaps,
    excludePrivateAccess,
    maxDeadEndKm,
    includeHydrants,
    hydrantSpacingKm,
    roadSource,
    result,
    addGeoJsonLayer,
    removeLayer,
    switchToMapForAction,
    switchBackFromMapAction,
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

  // On mobile, this bottom sheet gets shown/hidden a lot now (draw, pick,
  // generate all bounce over to Map and back) — an animated slide+fade
  // instead of an instant mount/unmount makes those bounces read as a
  // deliberate transition rather than a jarring flash. Desktop keeps the
  // original instant show/hide: the panel there is a flex column sibling of
  // the map, and a lingering, still-full-width invisible copy during a fade
  // would visibly steal layout space, so the delay only applies on mobile.
  const [mounted, setMounted] = useState(active);
  const [entered, setEntered] = useState(active);
  useEffect(() => {
    if (active) {
      setMounted(true);
      if (!isMobile) {
        setEntered(true);
        return;
      }
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    if (!isMobile) {
      setMounted(false);
      return;
    }
    const timeout = setTimeout(() => setMounted(false), 300);
    return () => clearTimeout(timeout);
  }, [active, isMobile]);

  // `bottom-16` (not `bottom-0`) leaves room for PrimaryNav's h-16 bottom tab
  // bar on narrow viewports, so this bottom sheet doesn't cover it.
  //
  // The status pill is NOT gated by `mounted`: switching to the Map tab for
  // an action is exactly when this panel unmounts (on mobile) — that's the
  // whole point of the pill, so it must keep rendering independently of the
  // panel underneath it, not disappear the moment the panel does.
  return (
    <>
      {drawingArea || picking ? (
        <div
          role="status"
          className="pointer-events-none fixed left-1/2 top-4 z-40 -translate-x-1/2 rounded-full border bg-background px-4 py-2 text-sm shadow-lg"
        >
          {drawingArea
            ? t("utilityDesign.step1Drawing")
            : t("utilityDesign.step3Picking")}
        </div>
      ) : null}
      <NetworkGenerationOverlay
        stage={progressStage}
        retry={progressRetry}
        roadSourceFallback={progressRoadSourceFallback}
      />
      {mounted ? (
      <aside
        aria-label={t("utilityDesign.title")}
        className={
          "relative flex h-[min(34rem,75vh)] supports-[max-height:1dvh]:h-[min(34rem,75dvh)] w-full shrink-0 flex-col overflow-hidden border-t bg-card max-md:fixed max-md:inset-x-0 max-md:bottom-16 max-md:z-30 max-md:shadow-xl max-md:transition-all max-md:duration-300 max-md:ease-out md:h-auto md:w-96 md:border-l md:border-t-0 " +
          (entered
            ? "max-md:translate-y-0 max-md:opacity-100"
            : "max-md:translate-y-8 max-md:opacity-0")
        }
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
                  min={MIN_OFFSET_METERS}
                  step={0.5}
                  value={offsetMeters}
                  onChange={(e) =>
                    setOffsetMeters(Math.max(Number(e.target.value), MIN_OFFSET_METERS))
                  }
                  className="h-8 w-20"
                />
                <span className="text-xs text-muted-foreground">m</span>
              </div>
            </div>
          </div>

          <Separator />

          <div className="flex flex-col gap-1.5">
            <Label className="font-medium">{t("utilityDesign.coverageTitle")}</Label>
            <div className="flex flex-col gap-2 pl-0">
              <Select
                value={coverage}
                onChange={(e) => setCoverage(e.target.value as NetworkCoverage)}
                className="max-w-[220px]"
              >
                {NETWORK_COVERAGES.map((c) => (
                  <option key={c} value={c}>
                    {t(`utilityDesign.coverage.${c}`)}
                  </option>
                ))}
              </Select>
              {coverage === "mainlineAndServices" ? (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={junctionsAtServiceTaps}
                    onChange={(e) => setJunctionsAtServiceTaps(e.target.checked)}
                  />
                  {t("utilityDesign.junctionsAtServiceTaps")}
                </label>
              ) : null}
            </div>
          </div>

          <Separator />

          <div className="flex flex-col gap-1.5">
            <Label className="font-medium">{t("utilityDesign.roadSourceTitle")}</Label>
            <div className="pl-0">
              <Select
                value={roadSource}
                onChange={(e) => setRoadSource(e.target.value as RoadSourceId)}
                className="max-w-[220px]"
              >
                {ROAD_SOURCES.map((rs) => (
                  <option key={rs} value={rs}>
                    {t(`utilityDesign.roadSource.${rs}`)}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("utilityDesign.roadSourceHelper")}
              </p>
            </div>
          </div>

          <Separator />

          <div className="flex flex-col gap-2">
            <Label className="font-medium">{t("utilityDesign.standardsTitle")}</Label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={excludePrivateAccess}
                onChange={(e) => setExcludePrivateAccess(e.target.checked)}
              />
              {t("utilityDesign.excludePrivateAccess")}
            </label>
            <div className="flex items-center gap-1.5">
              <Label
                htmlFor="utility-max-dead-end-km"
                className="text-xs font-normal text-muted-foreground"
              >
                {t("utilityDesign.maxDeadEndKmLabel")}
              </Label>
              <Input
                id="utility-max-dead-end-km"
                type="number"
                min={0}
                step={0.01}
                value={maxDeadEndKm}
                onChange={(e) => setMaxDeadEndKm(Number(e.target.value))}
                className="h-7 w-20 text-xs"
              />
              <span className="text-xs text-muted-foreground">km</span>
            </div>
            {utilityType === "water" ? (
              <>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={includeHydrants}
                    onChange={(e) => setIncludeHydrants(e.target.checked)}
                  />
                  {t("utilityDesign.includeHydrants")}
                </label>
                {includeHydrants ? (
                  <div className="flex items-center gap-1.5 pl-6">
                    <Label
                      htmlFor="utility-hydrant-spacing-km"
                      className="text-xs font-normal text-muted-foreground"
                    >
                      {t("utilityDesign.hydrantSpacingLabel")}
                    </Label>
                    <Input
                      id="utility-hydrant-spacing-km"
                      type="number"
                      min={0.01}
                      step={0.01}
                      value={hydrantSpacingKm}
                      onChange={(e) => setHydrantSpacingKm(Number(e.target.value))}
                      className="h-7 w-20 text-xs"
                    />
                    <span className="text-xs text-muted-foreground">km</span>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          <Separator />

          <div className="flex flex-col gap-2">
            <Button
              disabled={!canGenerate}
              onClick={handleGenerateClick}
              className="gap-1.5 transition-colors"
            >
              {generating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Waypoints className="h-4 w-4" />
              )}
              {generating
                ? t("utilityDesign.generating")
                : result
                  ? t("utilityDesign.regenerate")
                  : t("utilityDesign.generate")}
            </Button>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {result ? (
              <p className="text-xs text-muted-foreground">
                {result.servicesLayerId
                  ? t("utilityDesign.resultSummaryWithServices", {
                      junctions: result.junctionCount,
                      lines: result.lineCount,
                      services: result.serviceCount,
                      km: result.totalKm.toFixed(2),
                    })
                  : t("utilityDesign.resultSummary", {
                      junctions: result.junctionCount,
                      lines: result.lineCount,
                      km: result.totalKm.toFixed(2),
                    })}
                {result.truncated ? ` ${t("utilityDesign.resultTruncated")}` : ""}
                {result.servicesTruncated
                  ? ` ${t("utilityDesign.resultServicesTruncated")}`
                  : ""}
                {result.servicesBlocked
                  ? ` ${t("utilityDesign.resultServicesBlocked", {
                      count: result.servicesBlockedCount,
                    })}`
                  : ""}
                {result.hydrantsLayerId
                  ? ` ${t("utilityDesign.resultHydrants", { count: result.hydrantCount })}`
                  : ""}
                {result.deadEndsExceedingMaxLength > 0
                  ? ` ${t("utilityDesign.resultDeadEndsExceeding", {
                      count: result.deadEndsExceedingMaxLength,
                    })}`
                  : ""}
                {progressRoadSourceFallback
                  ? ` ${t("utilityDesign.roadSourceFallback", {
                      source: t(
                        `utilityDesign.roadSource.${progressRoadSourceFallback.attemptedSource}`,
                      ),
                    })}`
                  : ""}
              </p>
            ) : null}
          </div>
        </div>
      </div>
      </aside>
      ) : null}
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
