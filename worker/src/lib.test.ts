import { expect, test } from "bun:test";
import {
	basename,
	dateFromName,
	getDate,
	getUniqueFilename,
	isImageKey,
	parseGallery,
	plateBoxToTrim,
	serializeGallery,
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

test("getUniqueFilename: returns base filename when no conflict", async () => {
	expect(await getUniqueFilename("20260320", async () => false)).toBe(
		"20260320.jpg",
	);
});

test("getUniqueFilename: appends _2 when base exists", async () => {
	const exists = async (f: string) => f === "20260320.jpg";
	expect(await getUniqueFilename("20260320", exists)).toBe("20260320_2.jpg");
});

test("getUniqueFilename: appends _3 when base and _2 exist", async () => {
	const exists = async (f: string) =>
		f === "20260320.jpg" || f === "20260320_2.jpg";
	expect(await getUniqueFilename("20260320", exists)).toBe("20260320_3.jpg");
});

test("getUniqueFilename: throws rather than looping forever", async () => {
	expect(getUniqueFilename("20260320", async () => true)).rejects.toThrow(
		/No free filename/,
	);
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
