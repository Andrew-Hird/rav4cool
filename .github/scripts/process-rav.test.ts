import { expect, test } from "bun:test";
import {
	extractImageUrl,
	getDate,
	getUniqueFilename,
	updateHtml,
} from "./process-rav";

// --- getDate ---

test("getDate: extracts YYYYMMDD from title", () => {
	expect(getDate("20260315")).toBe("20260315");
});

test("getDate: extracts date embedded in other text", () => {
	expect(getDate("spotted this today 20260315 near the shops")).toBe(
		"20260315",
	);
});

test("getDate: returns today when title is empty", () => {
	const today = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const expected = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
	expect(getDate("")).toBe(expected);
});

test("getDate: returns today when title has no date", () => {
	const today = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const expected = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
	expect(getDate("spotted a green one")).toBe(expected);
});

test("getDate: returns today when title is null", () => {
	const today = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const expected = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
	expect(getDate(null)).toBe(expected);
});

// --- extractImageUrl ---

const ATTACHMENT_URL = "https://github.com/user-attachments/assets/abc-123-def";

test("extractImageUrl: extracts URL from GitHub attachment markdown", () => {
	const body = `Here's the RAV!\n\n![image](${ATTACHMENT_URL})\n`;
	expect(extractImageUrl(body)).toBe(ATTACHMENT_URL);
});

test("extractImageUrl: returns null when no image in body", () => {
	expect(extractImageUrl("Just some text, no image here.")).toBeNull();
});

test("extractImageUrl: returns null for empty body", () => {
	expect(extractImageUrl("")).toBeNull();
});

test("extractImageUrl: returns null for non-GitHub image URLs", () => {
	expect(extractImageUrl("![img](https://example.com/photo.jpg)")).toBeNull();
});

test("extractImageUrl: returns first image when multiple attachments", () => {
	const url1 = "https://github.com/user-attachments/assets/first";
	const url2 = "https://github.com/user-attachments/assets/second";
	expect(extractImageUrl(`![img](${url1})\n![img](${url2})`)).toBe(url1);
});

// --- getUniqueFilename ---

test("getUniqueFilename: returns base filename when no conflict", () => {
	expect(getUniqueFilename("20260320", () => false)).toBe("20260320.jpg");
});

test("getUniqueFilename: appends _2 when base exists", () => {
	expect(getUniqueFilename("20260320", (f) => f === "20260320.jpg")).toBe(
		"20260320_2.jpg",
	);
});

test("getUniqueFilename: appends _3 when base and _2 exist", () => {
	const exists = (f: string) => f === "20260320.jpg" || f === "20260320_2.jpg";
	expect(getUniqueFilename("20260320", exists)).toBe("20260320_3.jpg");
});

// --- updateHtml ---

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:image" content="https://rav4.cool/assets/ravs/20260318.jpg" />
</head>
<body>
  <div class="ravs">
    <img src="assets/ravs/20260318.jpg" alt="RAV4" />
  </div>
</body>
</html>`;

test("updateHtml: updates og:image to new filename", () => {
	const result = updateHtml(SAMPLE_HTML, "20260320.jpg");
	expect(result).toContain(
		'content="https://rav4.cool/assets/ravs/20260320.jpg"',
	);
	expect(result).not.toContain(
		'content="https://rav4.cool/assets/ravs/20260318.jpg"',
	);
});

test("updateHtml: inserts new img tag at top of .ravs div", () => {
	const result = updateHtml(SAMPLE_HTML, "20260320.jpg");
	const ravsIndex = result.indexOf('<div class="ravs">');
	const newImgIndex = result.indexOf('src="assets/ravs/20260320.jpg"');
	const oldImgIndex = result.indexOf('src="assets/ravs/20260318.jpg"');
	expect(newImgIndex).toBeGreaterThan(ravsIndex);
	expect(newImgIndex).toBeLessThan(oldImgIndex);
});

test("updateHtml: does not duplicate existing images", () => {
	const result = updateHtml(SAMPLE_HTML, "20260320.jpg");
	expect((result.match(/20260318\.jpg/g) ?? []).length).toBe(1);
});
