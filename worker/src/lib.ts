// Pure helpers for the RAV4 processing pipeline.
//
// Nothing in this file may touch the network, R2, or the Images binding —
// side effects live in process.ts and index.ts. That keeps this file testable
// with plain `bun test` and free of Workers-only globals.

export interface GalleryEntry {
	file: string;
	date: string | null;
	/**
	 * Intrinsic pixel size, used by the frontend to reserve layout space and
	 * stop the grid reflowing as images load. Optional, and per-image rather
	 * than a constant: most of the migrated photos are original camera output
	 * at assorted sizes, and only images processed by the Worker are square.
	 */
	width?: number;
	height?: number;
}

export interface Gallery {
	images: GalleryEntry[];
}

export interface PlateBox {
	xmin: number;
	ymin: number;
	xmax: number;
	ymax: number;
}

export interface TrimRegion {
	top: number;
	left: number;
	width: number;
	height: number;
}

/** Pixels of slack added around a detected plate before blurring. */
export const PLATE_PADDING = 10;

/** Guard against an `exists` predicate that never returns false. */
const MAX_FILENAME_ATTEMPTS = 100;

// No word boundaries: the frontend has always used a bare /\d{8}/, so names
// like "20240804roosubmission.jpg" must still yield their date, as must camera
// names like "IMG_20260828_1030.jpg". The `20` prefix plus a calendar check
// keeps this from matching arbitrary 8-digit runs the way /\d{8}/ would.
const DATE_PATTERN = /20\d{6}/g;

// HEIC/HEIF matter: iPhones shoot HEIC by default, so it is the most likely
// format to arrive. Cloudflare Images decodes it and we always output JPEG.
const IMAGE_EXTENSIONS = [
	".jpg",
	".jpeg",
	".png",
	".webp",
	".gif",
	".avif",
	".heic",
	".heif",
];

/** Strip any prefix, e.g. "upload/IMG_1234.jpg" -> "IMG_1234.jpg". */
export function basename(key: string): string {
	return key.slice(key.lastIndexOf("/") + 1);
}

function isRealDate(stamp: string): boolean {
	const year = Number(stamp.slice(0, 4));
	const month = Number(stamp.slice(4, 6));
	const day = Number(stamp.slice(6, 8));
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Pull a YYYYMMDD stamp out of a name, or null if there isn't one.
 * Deliberately returns null rather than a fallback so the migration can
 * reproduce today's behaviour, where `old_rav.jpeg` gets no date overlay.
 */
export function dateFromName(name: string | null | undefined): string | null {
	for (const match of (name ?? "").matchAll(DATE_PATTERN)) {
		if (isRealDate(match[0])) return match[0];
	}
	return null;
}

/**
 * Workers run in UTC, but the RAVs are spotted in New Zealand — so a photo
 * uploaded on a NZ morning would otherwise be stamped with yesterday's date
 * for roughly half of every day. Format in the local zone instead.
 */
export const SITE_TIME_ZONE = "Pacific/Auckland";

export function todayStamp(
	now: Date,
	timeZone: string = SITE_TIME_ZONE,
): string {
	// en-CA gives YYYY-MM-DD, which is YYYYMMDD once the dashes come out.
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	})
		.format(now)
		.replaceAll("-", "");
}

/** As dateFromName, but falls back to today — used for incoming uploads. */
export function getDate(
	name: string | null | undefined,
	now: Date = new Date(),
): string {
	return dateFromName(name) ?? todayStamp(now);
}

export function isImageKey(key: string): boolean {
	const lower = basename(key).toLowerCase();
	return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * First free `YYYYMMDD.jpg` / `YYYYMMDD_2.jpg` / ... for the given date.
 * `exists` is injected so this stays pure — callers back it with an R2 head().
 */
export async function getUniqueFilename(
	date: string,
	exists: (filename: string) => Promise<boolean>,
): Promise<string> {
	let filename = `${date}.jpg`;
	let suffix = 2;
	while (await exists(filename)) {
		if (suffix > MAX_FILENAME_ATTEMPTS) {
			throw new Error(`No free filename for ${date} after ${suffix} tries`);
		}
		filename = `${date}_${suffix}.jpg`;
		suffix++;
	}
	return filename;
}

/** Prepend an entry. Must not mutate its input. */
export function updateGallery(gallery: Gallery, entry: GalleryEntry): Gallery {
	return { images: [entry, ...gallery.images] };
}

/**
 * Parse and validate the manifest. Throws rather than returning a default:
 * a missing or malformed gallery.json must fail the queue message, because
 * silently starting a fresh one-entry manifest would wipe the gallery.
 */
export function parseGallery(text: string): Gallery {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new Error(`gallery.json is not valid JSON: ${err}`);
	}
	const images = (raw as { images?: unknown })?.images;
	if (!Array.isArray(images)) {
		throw new Error("gallery.json: expected an `images` array");
	}
	return {
		images: images.map((entry, i) => {
			const file = (entry as { file?: unknown })?.file;
			if (typeof file !== "string" || file === "") {
				throw new Error(`gallery.json: images[${i}].file must be a string`);
			}
			const date = (entry as { date?: unknown })?.date;
			const width = (entry as { width?: unknown })?.width;
			const height = (entry as { height?: unknown })?.height;
			return {
				file,
				date: typeof date === "string" ? date : null,
				...(typeof width === "number" ? { width } : {}),
				...(typeof height === "number" ? { height } : {}),
			};
		}),
	};
}

export function serializeGallery(gallery: Gallery): string {
	return `${JSON.stringify(gallery, null, "\t")}\n`;
}

/**
 * Convert a Plate Recognizer bounding box into a padded, clamped crop region.
 * Mirrors the arithmetic the sharp pipeline used before the move to Workers.
 * Returns null for a degenerate box that lands fully outside the image.
 */
export function plateBoxToTrim(
	box: PlateBox,
	imgWidth: number,
	imgHeight: number,
	padding: number = PLATE_PADDING,
): TrimRegion | null {
	const left = Math.max(0, Math.round(box.xmin - padding));
	const top = Math.max(0, Math.round(box.ymin - padding));
	if (left >= imgWidth || top >= imgHeight) return null;

	const width = Math.min(
		imgWidth - left,
		Math.round(box.xmax - box.xmin + padding * 2),
	);
	const height = Math.min(
		imgHeight - top,
		Math.round(box.ymax - box.ymin + padding * 2),
	);
	if (width <= 0 || height <= 0) return null;

	return { top, left, width, height };
}

/**
 * Identify an image by its magic bytes, or null if the signature is unknown.
 *
 * The Images binding's `info()` reports the format too, but it has to decode
 * the image to do it, so it is exactly the call that fails on an input the
 * binding dislikes — which is no use when the point of asking is to decide how
 * to hand that input to the binding. Signatures are cheap, pure, and testable,
 * and they beat the file extension: iOS names its HEIC-to-JPEG conversions
 * `.jpeg` but not every `.jpeg` off a phone actually is one.
 */
export function sniffFormat(bytes: Uint8Array): string | null {
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		return "image/png";
	}
	if (hasAscii(bytes, 0, "GIF87a") || hasAscii(bytes, 0, "GIF89a")) {
		return "image/gif";
	}
	if (hasAscii(bytes, 0, "RIFF") && hasAscii(bytes, 8, "WEBP")) {
		return "image/webp";
	}
	// ISO base media container: a length, then "ftyp", then the brand. HEIC and
	// AVIF are both this, and both are things an iPhone can produce.
	if (hasAscii(bytes, 4, "ftyp")) {
		const brand = ascii(bytes, 8, 4);
		if (brand === "avif" || brand === "avis") return "image/avif";
		if (brand.startsWith("hev") || brand.startsWith("hei")) return "image/heic";
		if (brand === "mif1" || brand === "msf1") return "image/heif";
	}
	return null;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
	if (bytes.length < signature.length) return false;
	return signature.every((byte, i) => bytes[i] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	let out = "";
	for (let i = offset; i < offset + length && i < bytes.length; i++) {
		out += String.fromCharCode(bytes[i] as number);
	}
	return out;
}

function hasAscii(
	bytes: Uint8Array,
	offset: number,
	expected: string,
): boolean {
	return ascii(bytes, offset, expected.length) === expected;
}

/**
 * Render an unknown thrown value as something worth putting in a log line or
 * in the `reason` metadata of a quarantined upload.
 *
 * `String(err)` is not enough: the Images binding throws errors whose `message`
 * is empty and whose only detail is the stack, so a failed upload was recorded
 * as the bare word "Error" and the log showed a stack with no reason attached.
 */
export function describeError(err: unknown, depth = 0): string {
	if (!(err instanceof Error)) return String(err);

	const parts: string[] = [];
	const code = (err as { code?: unknown }).code;
	if (code !== undefined && code !== null) parts.push(`code ${String(code)}`);
	if (err.message) parts.push(err.message);
	if (parts.length === 0) {
		const frame = (err.stack ?? "")
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.startsWith("at "));
		parts.push(frame ? `no message, thrown ${frame}` : "no message");
	}

	let described = `${err.name}: ${parts.join(" — ")}`;
	const cause = (err as { cause?: unknown }).cause;
	if (cause !== undefined && cause !== null && depth < 2) {
		described += ` (cause: ${describeError(cause, depth + 1)})`;
	}
	return described;
}

/**
 * A one-line description of a blob of bytes, for a log line or the `reason` on
 * a quarantined upload.
 *
 * When the signature is not one we know, the hex and text previews are the
 * point: Cloudflare's 9412 is "the requested file is not an image" and nothing
 * more, so the bytes themselves have to say whether this is a truncated photo,
 * an HTML error page saved with a `.jpeg` name, or a format we should support.
 */
export function describeInput(bytes: Uint8Array): string {
	if (bytes.byteLength === 0) return "empty file";

	const size = `${bytes.byteLength} bytes`;
	const format = sniffFormat(bytes);
	if (format) return `${format}, ${size}`;

	const hex = [...bytes.subarray(0, 16)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join(" ");
	const text = printablePrefix(bytes, 48);
	const preview =
		text === null ? "" : `, starts with text ${JSON.stringify(text)}`;
	return `unrecognised signature, ${size}, first bytes ${hex}${preview}`;
}

/** The leading run of printable ASCII, or null if these are not text bytes. */
function printablePrefix(bytes: Uint8Array, limit: number): string | null {
	let out = "";
	for (let i = 0; i < limit && i < bytes.length; i++) {
		const byte = bytes[i] as number;
		const printable =
			byte === 0x09 ||
			byte === 0x0a ||
			byte === 0x0d ||
			(byte >= 0x20 && byte <= 0x7e);
		if (!printable) break;
		out += String.fromCharCode(byte);
	}
	// A stray printable byte or two at the head of a binary file means nothing.
	// Only call it text if there is a run long enough to read.
	return out.length >= 8 ? out : null;
}

/**
 * Whether an Images-binding error is a verdict on the bytes rather than a
 * transient failure. Retrying one of these three is guaranteed to fail again,
 * so the upload should go straight to `failed/` instead of burning the queue's
 * attempts first.
 *
 * The numeric `code` is real: it is what produced the "code 9412" in
 * `IMAGES_TRANSFORM_ERROR 9412: Could not resize the image: The requested file
 * is not an image" that quarantined upload/IMG_0741.jpeg.
 */
export function isUndecodableImageError(err: unknown): boolean {
	const code = Number((err as { code?: unknown })?.code);
	return (
		code === 9412 || // not an image at all
		code === 9413 || // over the 100 megapixel area limit
		code === 9520 // a real image, in a format Images cannot read
	);
}
