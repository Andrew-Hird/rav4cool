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
