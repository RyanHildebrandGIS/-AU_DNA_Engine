import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";
import { GeoTiffReader } from "geolibre-wasm";
import {
  convertGeoTiffToCog,
  initCogWasm,
  isTiledGeoTiff,
  readGeoTiffInfo,
} from "../packages/processing/src/cog-convert";

// A tiny 32x32 Int16 GeoTIFF written striped (not tiled) by rasterio, the kind
// of file desktop GIS tools export and that the raster panel cannot render
// until it is converted to a tiled COG. See opengeos/GeoLibre#789.
const stripedTiff = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL("./fixtures/striped.tif", import.meta.url)),
  ),
);

// In the browser wasm-bindgen fetches the bundled asset; under node:test we feed
// it the wasm bytes directly so the same converter code runs headless.
const wasmBytes = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL(
        "../node_modules/geolibre-wasm/geolibre_wasm_bg.wasm",
        import.meta.url,
      ),
    ),
  ),
);

describe("convertGeoTiffToCog", () => {
  before(async () => {
    await initCogWasm(wasmBytes);
  });

  it("reads header-only metadata and reports the striped source as non-tiled", async () => {
    const info = await readGeoTiffInfo(stripedTiff);
    assert.equal(info.tiled, false);
    assert.equal(info.width, 32);
    assert.equal(info.height, 32);
    assert.equal(info.bands, 1);
    assert.equal(info.epsg, 4326);
    assert.equal(info.nodata, 0);
    assert.equal(await isTiledGeoTiff(stripedTiff), false);
  });

  it("re-encodes a striped GeoTIFF as a tiled COG, preserving georeferencing", async () => {
    const cog = await convertGeoTiffToCog(stripedTiff);
    const out = await readGeoTiffInfo(cog);
    // The whole point: the output is internally tiled, so the panel can stream it.
    assert.equal(out.tiled, true);
    assert.equal(await isTiledGeoTiff(cog), true);
    // Dimensions, band count, CRS, and nodata survive the round-trip.
    assert.equal(out.width, 32);
    assert.equal(out.height, 32);
    assert.equal(out.bands, 1);
    assert.equal(out.epsg, 4326);
    assert.equal(out.nodata, 0);

    // Pixel values survive (the fixture is row-major `(i % 500) - 11`).
    // read_band_f32 is used here to verify the written COG; the converter itself
    // decodes with read_all_f64 so it handles any source dtype.
    const reader = new GeoTiffReader(cog);
    try {
      const band = reader.read_band_f32(0);
      assert.equal(band.length, 32 * 32);
      assert.equal(band[0], -11);
      assert.equal(band[20], 9);
    } finally {
      reader.free();
    }
  });
});
