import * as assert from "assert";
import { isBridgeableImageData } from "../tokenizer/imageUtils";

/**
 * Build a PNG header with the given dimensions. The vision bridge only
 * parses the PNG signature + IHDR width/height, so no full valid PNG file
 * is required for these tests.
 */
function pngBytes(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(24);
	// PNG signature
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	// IHDR chunk length (13)
	bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
	// "IHDR"
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	// width (big-endian)
	bytes[16] = (width >> 24) & 0xff;
	bytes[17] = (width >> 16) & 0xff;
	bytes[18] = (width >> 8) & 0xff;
	bytes[19] = width & 0xff;
	// height (big-endian)
	bytes[20] = (height >> 24) & 0xff;
	bytes[21] = (height >> 16) & 0xff;
	bytes[22] = (height >> 8) & 0xff;
	bytes[23] = height & 0xff;
	return bytes;
}

suite("vision bridge image validation", () => {
	test("accepts normal-sized PNG images", () => {
		assert.strictEqual(isBridgeableImageData(pngBytes(800, 600), "image/png"), true);
		assert.strictEqual(isBridgeableImageData(pngBytes(1024, 768), "image/png"), true);
	});

	test("rejects host-injected tiny placeholder images below the minimum dimension", () => {
		// A 7x27 placeholder must not be routed through the vision bridge.
		assert.strictEqual(isBridgeableImageData(pngBytes(7, 27), "image/png"), false);
		// Exactly at the boundary is still too small on one axis.
		assert.strictEqual(isBridgeableImageData(pngBytes(14, 13), "image/png"), false);
	});

	test("accepts images exactly at the minimum dimension", () => {
		assert.strictEqual(isBridgeableImageData(pngBytes(14, 14), "image/png"), true);
	});

	test("rejects non-image mime types even with valid image bytes", () => {
		assert.strictEqual(isBridgeableImageData(pngBytes(800, 600), "image/svg+xml"), false);
		assert.strictEqual(isBridgeableImageData(pngBytes(800, 600), "application/octet-stream"), false);
	});

	test("rejects unparseable image data", () => {
		assert.strictEqual(isBridgeableImageData(new Uint8Array([1, 2, 3]), "image/png"), false);
		assert.strictEqual(isBridgeableImageData(new Uint8Array(), "image/jpeg"), false);
	});

	test("rejects empty data", () => {
		assert.strictEqual(isBridgeableImageData(new Uint8Array(0), "image/png"), false);
	});
});
