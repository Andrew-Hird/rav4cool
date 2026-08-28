// Image processing for incoming RAV4 photos: blur any license plates, then
// crop to a square. Replaces the sharp pipeline that ran in GitHub Actions —
// sharp is a native module and cannot run in a Worker.

import {
	describeError,
	type PlateBox,
	plateBoxToTrim,
	sniffFormat,
	type TrimRegion,
} from "./lib";

interface PlateResult {
	box: PlateBox;
	plate: string;
}

interface PlateRecognizerResponse {
	results?: PlateResult[];
}

const PLATE_API = "https://api.platerecognizer.com/v1/plate-reader/";

export const OUTPUT_SIZE = 1200;
const OUTPUT_QUALITY = 82;

/**
 * Cloudflare's blur scale is 0-250 and is not the same as sharp's `.blur(20)`
 * sigma, so this is tuned by eye rather than ported. Erring high: an
 * over-blurred plate is fine, a legible one defeats the point.
 */
const BLUR_STRENGTH = 100;

/**
 * Quality for the intermediate JPEG we hand to Plate Recognizer when the
 * upload is not already JPEG. High, because this is an interim artefact that
 * gets re-encoded at OUTPUT_QUALITY afterwards.
 */
const TRANSCODE_QUALITY = 95;

function toStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new Blob([bytes]).stream() as ReadableStream<Uint8Array>;
}

async function toBytes(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Ask Plate Recognizer where the plates are.
 *
 * Fails open in every direction — no API key, network error, bad status, or
 * unparseable body all yield an empty list, so the upload still goes through
 * unblurred rather than being dropped. This matches the behaviour of the
 * sharp implementation it replaces.
 */
async function detectPlates(
	original: Uint8Array,
	apiKey: string | undefined,
): Promise<PlateBox[]> {
	if (!apiKey) {
		console.log("PLATE_RECOGNIZER_API_KEY not set, skipping plate blur");
		return [];
	}

	const form = new FormData();
	form.append(
		"upload",
		new Blob([original], { type: "image/jpeg" }),
		"image.jpg",
	);

	let response: Response;
	try {
		response = await fetch(PLATE_API, {
			method: "POST",
			headers: { Authorization: `Token ${apiKey}` },
			body: form,
		});
	} catch (err) {
		console.warn("Plate Recognizer request failed, skipping blur:", err);
		return [];
	}

	if (!response.ok) {
		console.warn(
			`Plate Recognizer API error: ${response.status}, skipping blur`,
		);
		return [];
	}

	try {
		const data = (await response.json()) as PlateRecognizerResponse;
		const boxes = (data.results ?? []).map((r) => r.box);
		if (boxes.length === 0) console.log("No plates detected");
		return boxes;
	} catch (err) {
		console.warn("Plate Recognizer returned an unreadable body:", err);
		return [];
	}
}

/** Re-encode anything the binding can decode as a plain JPEG. */
async function toJpeg(
	images: ImagesBinding,
	bytes: Uint8Array,
): Promise<Uint8Array> {
	const jpeg = await images
		.input(toStream(bytes))
		.output({ format: "image/jpeg", quality: TRANSCODE_QUALITY });
	return toBytes(jpeg.image());
}

/**
 * The image's intrinsic size, or null if the binding will not tell us.
 *
 * Fails soft on purpose. Dimensions only decide where the blur patches go, and
 * the caller already handles not having them, so an info() that throws should
 * cost the blur at worst — never the upload.
 */
async function readDimensions(
	images: ImagesBinding,
	bytes: Uint8Array,
): Promise<{ w: number; h: number } | null> {
	try {
		const info = await images.info(toStream(bytes));
		return "width" in info ? { w: info.width, h: info.height } : null;
	} catch (err) {
		console.warn(`Images info() failed: ${describeError(err)}`);
		return null;
	}
}

/**
 * Blur each plate region, then crop to a square, in a single transform chain.
 *
 * Each blurred patch is derived from the *original* image rather than from the
 * progressively-patched one. That means one encode for the whole operation
 * instead of one per plate, and no compounding JPEG loss.
 *
 * Blur-then-trim (rather than trim-then-blur) is deliberate: blurring first
 * lets the patch pull in surrounding pixels, so its edges blend instead of
 * showing a hard seam against the unblurred image.
 *
 * `trim: {top, left, width, height}` means "crop TO this rect", not "cut this
 * much off each side" — the types permit both readings and the docs are thin,
 * so this was verified against the live binding before being relied on.
 */
export async function processImage(
	images: ImagesBinding,
	original: Uint8Array,
	apiKey: string | undefined,
): Promise<Uint8Array> {
	// Sniffed rather than asked of info(): the format decision has to be made
	// before the binding has been handed anything, and an upload the binding
	// cannot read must not take the whole pipeline down with it.
	const format = sniffFormat(original);
	console.log(
		`Input: ${format ?? "unrecognised signature"}, ${original.byteLength} bytes`,
	);

	// Plate Recognizer rejects HEIC with a 400, and iPhones shoot HEIC by
	// default — so most uploads would silently publish unblurred. Transcode to
	// JPEG first so detection and blurring share one coordinate space.
	// Cloudflare Images decodes HEIC happily; only the plate API does not.
	// An unrecognised signature is transcoded too: whatever it is, the plate
	// API is likelier to read a JPEG re-encode of it than the original.
	let working = original;
	if (format !== "image/jpeg") {
		console.log(`Transcoding ${format ?? "unknown input"} to JPEG`);
		working = await toJpeg(images, original);
	}

	// Dimensions are needed only to place the blur patches. They come last and
	// they fail soft, because info() is the call that has actually broken
	// uploads in the wild — an iPhone .jpeg it refused to read cost three
	// retries and a quarantined photo before anything had even been attempted.
	let dims = await readDimensions(images, working);
	if (!dims && working === original) {
		// Re-encoding normalises whatever the binding disliked about the file as
		// uploaded. If that fails too the binding genuinely cannot read it, and
		// the transform below will say so.
		console.warn(
			"Re-encoding through the Images binding to recover dimensions",
		);
		working = await toJpeg(images, original);
		dims = await readDimensions(images, working);
	}
	if (dims) console.log(`Dimensions: ${dims.w}x${dims.h}`);

	const boxes = await detectPlates(working, apiKey);

	let trims: TrimRegion[] = [];
	if (boxes.length > 0 && dims) {
		const { w, h } = dims;
		trims = boxes
			.map((box) => plateBoxToTrim(box, w, h))
			.filter((t): t is TrimRegion => t !== null);
		console.log(
			`Detected ${boxes.length} plate(s), blurring ${trims.length}: ` +
				trims.map((t) => `${t.width}x${t.height}@${t.left},${t.top}`).join(" "),
		);
	} else if (boxes.length > 0) {
		console.warn("Plates detected but image dimensions unknown, skipping blur");
	}

	let transformer = images.input(toStream(working));
	for (const trim of trims) {
		const patch = images
			.input(toStream(working))
			.transform({ blur: BLUR_STRENGTH })
			.transform({ trim });
		transformer = transformer.draw(patch, { top: trim.top, left: trim.left });
	}

	const result = await transformer
		.transform({
			width: OUTPUT_SIZE,
			height: OUTPUT_SIZE,
			fit: "cover",
			gravity: "entropy",
		})
		.output({ format: "image/jpeg", quality: OUTPUT_QUALITY });

	return toBytes(result.image());
}
