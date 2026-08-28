import { expect, test } from "bun:test";
import {
	basename,
	contentTag,
	dateFromName,
	describeError,
	describeInput,
	getDate,
	getUniqueFilename,
	getUploadDate,
	isDateStamp,
	isImageKey,
	isUndecodableImageError,
	parseGallery,
	plateBoxToTrim,
	sameEtag,
	serializeGallery,
	sniffFormat,
	todayStamp,
	updateGallery,
} from "./lib";

// --- basename ---

test("basename: strips the upload/ prefix", () => {
	expect(basename("upload/IMG_1234.jpg")).toBe("IMG_1234.jpg");
});

test("basename: leaves an unprefixed key alone", () => {
	expect(basename("IMG_1234.jpg")).toBe("IMG_1234.jpg");
});

// --- dateFromName / getDate ---

test("dateFromName: extracts YYYYMMDD", () => {
	expect(dateFromName("20260315.jpg")).toBe("20260315");
});

test("dateFromName: returns null when there is no date", () => {
	expect(dateFromName("old_rav.jpeg")).toBeNull();
});

test("dateFromName: matches a date embedded in a longer name", () => {
	expect(dateFromName("20240804roosubmission.jpg")).toBe("20240804");
});

test("getDate: extracts date embedded in other text", () => {
	expect(getDate("spotted this today 20260315 near the shops")).toBe(
		"20260315",
	);
});

test("getDate: falls back to the injected today when there is no date", () => {
	expect(getDate("spotted a green one", new Date(2026, 7, 28))).toBe(
		"20260828",
	);
});

test("getDate: zero-pads month and day", () => {
	expect(getDate("", new Date(2026, 0, 5))).toBe("20260105");
});

test("getDate: handles null", () => {
	expect(getDate(null, new Date(2026, 7, 28))).toBe("20260828");
});

test("isDateStamp: accepts a real YYYYMMDD date", () => {
	expect(isDateStamp("20260829")).toBe(true);
});

test("isDateStamp: rejects malformed and impossible dates", () => {
	for (const value of ["2026-08-29", "20261301", "20260229", "today"]) {
		expect(isDateStamp(value)).toBe(false);
	}
});

test("getUploadDate: explicit date takes precedence", () => {
	expect(
		getUploadDate("IMG_20260828.jpg", "20260827", new Date(2026, 7, 29)),
	).toBe("20260827");
});

test("getUploadDate: falls back to filename then today", () => {
	expect(getUploadDate("IMG_20260828.jpg", null)).toBe("20260828");
	expect(getUploadDate("spotted.jpg", undefined, new Date(2026, 7, 29))).toBe(
		"20260829",
	);
});

// --- isImageKey ---

test("isImageKey: accepts common image extensions", () => {
	for (const key of ["a.jpg", "a.JPEG", "a.png", "a.webp", "a.avif"]) {
		expect(isImageKey(key)).toBe(true);
	}
});

test("isImageKey: accepts HEIC/HEIF, the iPhone default", () => {
	// Verified against the live Images binding: it decodes HEIC and we output
	// JPEG. Rejecting these would bounce most phone uploads to failed/.
	for (const key of ["IMG_0593.heic", "IMG_0593.HEIC", "a.heif"]) {
		expect(isImageKey(key)).toBe(true);
	}
});

test("isImageKey: rejects non-images and folder placeholders", () => {
	for (const key of ["notes.txt", "upload/", "a.jpg.zip", "notes.pdf"]) {
		expect(isImageKey(key)).toBe(false);
	}
});

// --- getUniqueFilename ---

test("getUniqueFilename: tags the date with the content", async () => {
	expect(
		await getUniqueFilename("20260320", "a1b2c3d4", async () => false),
	).toBe("20260320-a1b2c3d4.jpg");
});

test("getUniqueFilename: appends _2 when the tagged name exists", async () => {
	const exists = async (f: string) => f === "20260320-a1b2c3d4.jpg";
	expect(await getUniqueFilename("20260320", "a1b2c3d4", exists)).toBe(
		"20260320-a1b2c3d4_2.jpg",
	);
});

test("getUniqueFilename: appends _3 when base and _2 exist", async () => {
	const exists = async (f: string) =>
		f === "20260320-a1b2c3d4.jpg" || f === "20260320-a1b2c3d4_2.jpg";
	expect(await getUniqueFilename("20260320", "a1b2c3d4", exists)).toBe(
		"20260320-a1b2c3d4_3.jpg",
	);
});

test("getUniqueFilename: throws rather than looping forever", async () => {
	expect(
		getUniqueFilename("20260320", "a1b2c3d4", async () => true),
	).rejects.toThrow(/No free filename/);
});

// The point of the tag: a date whose photo was deleted must not hand its URL
// to the next upload, because ravs/* is served immutable.
test("getUniqueFilename: different content on one date gives different names", async () => {
	const free = async () => false;
	const a = await getUniqueFilename("20260320", "a1b2c3d4", free);
	const b = await getUniqueFilename("20260320", "99887766", free);
	expect(a).not.toBe(b);
});

// The published name is never re-parsed for its date, but keep it parseable.
test("getUniqueFilename: the date is still readable out of the name", async () => {
	const name = await getUniqueFilename(
		"20260320",
		"a1b2c3d4",
		async () => false,
	);
	expect(dateFromName(name)).toBe("20260320");
});

// --- contentTag ---

test("contentTag: is eight hex characters", async () => {
	expect(await contentTag(new Uint8Array([1, 2, 3]))).toMatch(/^[0-9a-f]{8}$/);
});

test("contentTag: is stable for the same bytes", async () => {
	const bytes = new Uint8Array([1, 2, 3, 4, 5]);
	expect(await contentTag(bytes)).toBe(await contentTag(new Uint8Array(bytes)));
});

test("contentTag: differs for different bytes", async () => {
	expect(await contentTag(new Uint8Array([1, 2, 3]))).not.toBe(
		await contentTag(new Uint8Array([1, 2, 4])),
	);
});

test("contentTag: handles an empty input", async () => {
	expect(await contentTag(new Uint8Array())).toMatch(/^[0-9a-f]{8}$/);
});

// --- updateGallery ---

test("updateGallery: prepends to an empty gallery", () => {
	const result = updateGallery(
		{ images: [] },
		{
			file: "20260320.jpg",
			date: "20260320",
		},
	);
	expect(result.images).toEqual([{ file: "20260320.jpg", date: "20260320" }]);
});

test("updateGallery: prepends to an existing gallery", () => {
	const gallery = { images: [{ file: "20260318.jpg", date: "20260318" }] };
	const result = updateGallery(gallery, {
		file: "20260320.jpg",
		date: "20260320",
	});
	expect(result.images.map((i) => i.file)).toEqual([
		"20260320.jpg",
		"20260318.jpg",
	]);
});

test("updateGallery: does not mutate the original gallery", () => {
	const original = { images: [{ file: "20260318.jpg", date: "20260318" }] };
	updateGallery(original, { file: "20260320.jpg", date: "20260320" });
	expect(original.images).toEqual([{ file: "20260318.jpg", date: "20260318" }]);
});

// --- parseGallery / serializeGallery ---

test("parseGallery: reads a well-formed manifest", () => {
	const text = '{"images":[{"file":"a.jpg","date":"20260320"}]}';
	expect(parseGallery(text).images).toEqual([
		{ file: "a.jpg", date: "20260320" },
	]);
});

test("parseGallery: preserves a null date", () => {
	const text = '{"images":[{"file":"old_rav.jpeg","date":null}]}';
	expect(parseGallery(text).images[0].date).toBeNull();
});

test("parseGallery: throws on invalid JSON", () => {
	expect(() => parseGallery("not json")).toThrow(/not valid JSON/);
});

test("parseGallery: throws when images is missing", () => {
	expect(() => parseGallery('{"foo":1}')).toThrow(/expected an `images` array/);
});

test("parseGallery: throws when an entry has no file", () => {
	expect(() => parseGallery('{"images":[{"date":"20260320"}]}')).toThrow(
		/images\[0\].file/,
	);
});

test("serializeGallery: round-trips through parseGallery", () => {
	const gallery = {
		images: [
			{ file: "20260320.jpg", date: "20260320" },
			{ file: "old_rav.jpeg", date: null },
		],
	};
	expect(parseGallery(serializeGallery(gallery))).toEqual(gallery);
});

// --- plateBoxToTrim ---

test("plateBoxToTrim: pads the box by 10px on every side", () => {
	const box = { xmin: 100, ymin: 200, xmax: 300, ymax: 260 };
	expect(plateBoxToTrim(box, 1000, 1000)).toEqual({
		left: 90,
		top: 190,
		width: 220,
		height: 80,
	});
});

test("plateBoxToTrim: clamps left and top at the image edge", () => {
	const box = { xmin: 2, ymin: 3, xmax: 100, ymax: 60 };
	const trim = plateBoxToTrim(box, 1000, 1000);
	expect(trim?.left).toBe(0);
	expect(trim?.top).toBe(0);
});

test("plateBoxToTrim: clamps width and height to the image bounds", () => {
	const box = { xmin: 900, ymin: 900, xmax: 1100, ymax: 1100 };
	const trim = plateBoxToTrim(box, 1000, 1000);
	expect(trim).not.toBeNull();
	if (!trim) return;
	expect(trim.left + trim.width).toBeLessThanOrEqual(1000);
	expect(trim.top + trim.height).toBeLessThanOrEqual(1000);
});

test("plateBoxToTrim: returns null for a box outside the image", () => {
	const box = { xmin: 2000, ymin: 2000, xmax: 2100, ymax: 2100 };
	expect(plateBoxToTrim(box, 1000, 1000)).toBeNull();
});

test("plateBoxToTrim: rounds fractional coordinates to whole pixels", () => {
	const box = { xmin: 100.4, ymin: 200.6, xmax: 300.2, ymax: 260.9 };
	const trim = plateBoxToTrim(box, 1000, 1000);
	expect(trim).toEqual({
		left: 90,
		top: 191,
		width: 220,
		height: 80,
	});
});

// --- dateFromName: cases the old \b(20\d{6})\b backend regex got wrong ---

test("dateFromName: matches a date fused to trailing text", () => {
	// The frontend has always shown "04 Aug 2024" for this file; the backend
	// regex did not match it. The manifest must agree with the frontend.
	expect(dateFromName("20240804roosubmission.jpg")).toBe("20240804");
});

test("dateFromName: matches a camera-style filename", () => {
	expect(dateFromName("IMG_20260828_103045.jpg")).toBe("20260828");
});

test("dateFromName: ignores 8-digit runs that are not real dates", () => {
	expect(dateFromName("20261332.jpg")).toBeNull();
	expect(dateFromName("20260231.jpg")).toBeNull();
});

test("dateFromName: skips a bad candidate and takes a valid later one", () => {
	expect(dateFromName("20269999_20260828.jpg")).toBe("20260828");
});

test("dateFromName: is not affected by the global regex lastIndex", () => {
	expect(dateFromName("20260808.jpg")).toBe("20260808");
	expect(dateFromName("20260808.jpg")).toBe("20260808");
});

// --- gallery entries carry intrinsic dimensions ---

test("parseGallery: keeps width and height when present", () => {
	const text =
		'{"images":[{"file":"a.jpg","date":null,"width":1280,"height":960}]}';
	expect(parseGallery(text).images[0]).toEqual({
		file: "a.jpg",
		date: null,
		width: 1280,
		height: 960,
	});
});

test("parseGallery: tolerates entries without dimensions", () => {
	const entry = parseGallery('{"images":[{"file":"a.jpg","date":null}]}')
		.images[0];
	expect(entry.width).toBeUndefined();
	expect(entry.height).toBeUndefined();
});

test("parseGallery: drops non-numeric dimensions", () => {
	const text = '{"images":[{"file":"a.jpg","date":null,"width":"wide"}]}';
	expect(parseGallery(text).images[0].width).toBeUndefined();
});

// --- dates are stamped in NZ time, not the Worker's UTC ---

test("todayStamp: uses the NZ date, not UTC, for a NZ morning", () => {
	// 20:00 UTC on the 27th is 08:00 on the 28th in Auckland.
	expect(todayStamp(new Date("2026-08-27T20:00:00Z"))).toBe("20260828");
});

test("todayStamp: agrees with UTC when the zones do not straddle midnight", () => {
	// 02:00 UTC on the 27th is 14:00 on the 27th in Auckland.
	expect(todayStamp(new Date("2026-08-27T02:00:00Z"))).toBe("20260827");
});

test("todayStamp: rolls the year over in NZ time", () => {
	// 11:00 UTC on Dec 31 is 00:00 on Jan 1 in Auckland (NZDT, UTC+13).
	expect(todayStamp(new Date("2026-12-31T11:00:00Z"))).toBe("20270101");
});

test("todayStamp: handles the NZDT/NZST daylight-saving boundary", () => {
	// NZDT (UTC+13) ends the first Sunday of April; 12:00 UTC on 4 Apr 2027
	// is 2027-04-05 in Auckland either way, so this must not drift.
	expect(todayStamp(new Date("2027-04-04T12:00:00Z"))).toBe("20270405");
});

test("getDate: an undated upload gets the NZ date", () => {
	expect(getDate("IMG_0593.heic", new Date("2026-08-27T20:00:00Z"))).toBe(
		"20260828",
	);
});

// --- sniffFormat ---

/** A header followed by enough filler that offset reads are in range. */
function header(...bytes: number[]): Uint8Array {
	return new Uint8Array([...bytes, ...new Array(32).fill(0)]);
}

function isoBmff(brand: string): Uint8Array {
	const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
	return header(0, 0, 0, 0x20, ...ascii("ftyp"), ...ascii(brand));
}

test("sniffFormat: recognises JPEG", () => {
	expect(sniffFormat(header(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
});

test("sniffFormat: recognises PNG", () => {
	expect(
		sniffFormat(header(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
	).toBe("image/png");
});

test("sniffFormat: recognises GIF", () => {
	const gif = new Uint8Array([..."GIF89a"].map((c) => c.charCodeAt(0)));
	expect(sniffFormat(gif)).toBe("image/gif");
});

test("sniffFormat: recognises WebP by its RIFF container", () => {
	const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
	const webp = new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]);
	expect(sniffFormat(webp)).toBe("image/webp");
});

// The reason this function exists: an iPhone's HEIC has a `.jpeg` name often
// enough that the extension cannot be trusted to pick the transcode path.
test("sniffFormat: recognises HEIC regardless of its name", () => {
	expect(sniffFormat(isoBmff("heic"))).toBe("image/heic");
	expect(sniffFormat(isoBmff("heix"))).toBe("image/heic");
	expect(sniffFormat(isoBmff("hevc"))).toBe("image/heic");
});

test("sniffFormat: recognises AVIF", () => {
	expect(sniffFormat(isoBmff("avif"))).toBe("image/avif");
});

test("sniffFormat: recognises a bare HEIF brand", () => {
	expect(sniffFormat(isoBmff("mif1"))).toBe("image/heif");
});

test("sniffFormat: returns null for an unknown signature", () => {
	expect(sniffFormat(header(0x00, 0x01, 0x02, 0x03))).toBeNull();
});

test("sniffFormat: returns null rather than reading past a short buffer", () => {
	expect(sniffFormat(new Uint8Array([0xff, 0xd8]))).toBeNull();
	expect(sniffFormat(new Uint8Array())).toBeNull();
});

// --- describeError ---

// The bug this was written for: the Images binding threw an error with an
// empty message, so the log and the quarantine metadata both said "Error".
test("describeError: falls back to the stack when there is no message", () => {
	const err = new Error("");
	err.stack = "Error\n    at throwErrorIfErrorResponse (images-api:282:15)";
	expect(describeError(err)).toBe(
		"Error: no message, thrown at throwErrorIfErrorResponse (images-api:282:15)",
	);
});

test("describeError: says so when there is neither message nor stack", () => {
	const err = new Error("");
	err.stack = undefined;
	expect(describeError(err)).toBe("Error: no message");
});

test("describeError: includes the message and a numeric code", () => {
	const err = Object.assign(new Error("Unsupported image type"), {
		code: 9520,
	});
	expect(describeError(err)).toBe("Error: code 9520 — Unsupported image type");
});

test("describeError: keeps the error's own name", () => {
	expect(describeError(new TypeError("nope"))).toBe("TypeError: nope");
});

test("describeError: unwraps a cause", () => {
	const err = new Error("outer", { cause: new Error("inner") });
	expect(describeError(err)).toBe("Error: outer (cause: Error: inner)");
});

test("describeError: survives a self-referencing cause", () => {
	const err = new Error("loop") as Error & { cause?: unknown };
	err.cause = err;
	expect(describeError(err)).toContain("Error: loop");
});

test("describeError: stringifies a non-Error throw", () => {
	expect(describeError("just a string")).toBe("just a string");
	expect(describeError(undefined)).toBe("undefined");
});

// --- describeInput ---

test("describeInput: names a recognised format and its size", () => {
	expect(describeInput(header(0xff, 0xd8, 0xff, 0xe0))).toBe(
		"image/jpeg, 36 bytes",
	);
});

test("describeInput: calls out an empty file", () => {
	expect(describeInput(new Uint8Array())).toBe("empty file");
});

test("describeInput: hex-dumps the head of an unrecognised file", () => {
	const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
	expect(describeInput(bytes)).toBe(
		"unrecognised signature, 6 bytes, first bytes de ad be ef 00 01",
	);
});

// The whole reason for the text preview: 9412's "the requested file is not an
// image" does not distinguish a truncated photo from a saved error page.
test("describeInput: shows the text when the bytes are not binary at all", () => {
	const html = new Uint8Array(
		[..."<!DOCTYPE html><title>403</title>"].map((c) => c.charCodeAt(0)),
	);
	expect(describeInput(html)).toContain(
		'starts with text "<!DOCTYPE html><title>403</title>"',
	);
});

test("describeInput: does not call a binary file text on a byte or two", () => {
	const bytes = new Uint8Array([0x41, 0x42, 0x00, 0xff, 0xfe, 0x01]);
	expect(describeInput(bytes)).not.toContain("starts with text");
});

// --- isUndecodableImageError ---

test("isUndecodableImageError: matches the codes that are verdicts", () => {
	for (const code of [9412, 9413, 9520]) {
		expect(
			isUndecodableImageError(Object.assign(new Error(""), { code })),
		).toBe(true);
	}
});

test("isUndecodableImageError: accepts a code that arrives as a string", () => {
	const err = Object.assign(new Error(""), { code: "9412" });
	expect(isUndecodableImageError(err)).toBe(true);
});

test("isUndecodableImageError: leaves other failures retryable", () => {
	expect(isUndecodableImageError(new Error("socket hang up"))).toBe(false);
	expect(
		isUndecodableImageError(Object.assign(new Error(""), { code: 9401 })),
	).toBe(false);
	expect(isUndecodableImageError(undefined)).toBe(false);
	expect(isUndecodableImageError(null)).toBe(false);
});

// --- sameEtag ---

test("sameEtag: matches identical etags", () => {
	expect(sameEtag("abc123", "abc123")).toBe(true);
});

test("sameEtag: ignores quoting and weak prefixes", () => {
	expect(sameEtag('"abc123"', "abc123")).toBe(true);
	expect(sameEtag('W/"abc123"', '"abc123"')).toBe(true);
});

test("sameEtag: rejects different objects", () => {
	expect(sameEtag("abc123", "def456")).toBe(false);
});

// A missing etag must never read as "unchanged" — the callers delete on the
// strength of this, and deleting a replacement loses the photo.
test("sameEtag: an absent etag never matches", () => {
	expect(sameEtag(undefined, "abc123")).toBe(false);
	expect(sameEtag("abc123", undefined)).toBe(false);
	expect(sameEtag(undefined, undefined)).toBe(false);
	expect(sameEtag("", "")).toBe(false);
	expect(sameEtag(null, "abc123")).toBe(false);
});
