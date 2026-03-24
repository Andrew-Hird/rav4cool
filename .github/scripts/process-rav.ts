#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import sharp from "sharp";

interface PlateBox {
	xmin: number;
	ymin: number;
	xmax: number;
	ymax: number;
}

interface PlateResult {
	box: PlateBox;
	plate: string;
}

interface PlateRecognizerResponse {
	results: PlateResult[];
}

interface Gallery {
	images: string[];
}

export function getDate(title: string | null | undefined): string {
	const match = (title ?? "").match(/\b(20\d{6})\b/);
	if (match) return match[1];
	const today = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
}

export function extractImageUrl(
	body: string | null | undefined,
): string | null {
	const match = (body ?? "").match(
		/!\[.*?\]\((https:\/\/github\.com\/user-attachments\/[^\s)]+)\)/,
	);
	return match ? match[1] : null;
}

export function getUniqueFilename(
	date: string,
	exists: (filename: string) => boolean,
): string {
	let filename = `${date}.jpg`;
	let suffix = 2;
	while (exists(filename)) {
		filename = `${date}_${suffix}.jpg`;
		suffix++;
	}
	return filename;
}

export function updateOgImage(html: string, filename: string): string {
	return html.replace(
		/<meta property="og:image" content="[^"]*"/,
		`<meta property="og:image" content="https://rav4.cool/assets/ravs/${filename}"`,
	);
}

export function updateGallery(gallery: Gallery, filename: string): Gallery {
	return { images: [filename, ...gallery.images] };
}

export async function blurLicensePlates(imageBuffer: Buffer): Promise<Buffer> {
	const apiKey = process.env.PLATE_RECOGNIZER_API_KEY;
	if (!apiKey) {
		console.log("PLATE_RECOGNIZER_API_KEY not set, skipping plate blur");
		return imageBuffer;
	}

	const formData = new FormData();
	const blob = new Blob([imageBuffer], { type: "image/jpeg" });
	formData.append("upload", blob, "image.jpg");

	let response: Response;
	try {
		response = await fetch("https://api.platerecognizer.com/v1/plate-reader/", {
			method: "POST",
			headers: { Authorization: `Token ${apiKey}` },
			body: formData,
		});
	} catch (err) {
		console.warn("Plate Recognizer request failed, skipping blur:", err);
		return imageBuffer;
	}

	if (!response.ok) {
		console.warn(
			`Plate Recognizer API error: ${response.status}, skipping blur`,
		);
		return imageBuffer;
	}

	const data = (await response.json()) as PlateRecognizerResponse;

	if (!data.results?.length) {
		console.log("No plates detected");
		return imageBuffer;
	}

	console.log(`Detected ${data.results.length} plate(s), blurring...`);

	// Pad the blur region slightly to ensure full plate coverage
	const PADDING = 10;
	const meta = await sharp(imageBuffer).metadata();
	const imgW = meta.width ?? 0;
	const imgH = meta.height ?? 0;

	let buf = imageBuffer;
	for (const result of data.results) {
		const left = Math.max(0, result.box.xmin - PADDING);
		const top = Math.max(0, result.box.ymin - PADDING);
		const width = Math.min(
			imgW - left,
			result.box.xmax - result.box.xmin + PADDING * 2,
		);
		const height = Math.min(
			imgH - top,
			result.box.ymax - result.box.ymin + PADDING * 2,
		);

		const original = await sharp(buf).extract({ left, top, width, height }).toBuffer();
		const blurred = await sharp(buf)
			.extract({ left, top, width, height })
			.blur(20)
			.toBuffer();

		// Build a feathered mask: inset white rect with gaussian blur gives soft edges
		const feather = Math.min(10, Math.floor(Math.min(width, height) / 4));
		const maskSvg = Buffer.from(
			`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
				<defs><filter id="f"><feGaussianBlur stdDeviation="${feather}"/></filter></defs>
				<rect x="${feather}" y="${feather}" width="${width - feather * 2}" height="${height - feather * 2}" fill="white" filter="url(#f)"/>
			</svg>`,
		);
		const mask = await sharp(maskSvg).png().toBuffer();

		// Apply mask as alpha to blurred patch, then composite onto the original patch
		// so transparent edges fade to the original pixels rather than black
		const blurredSoft = await sharp(blurred)
			.ensureAlpha()
			.composite([{ input: mask, blend: "dest-in" }])
			.toBuffer();
		const patch = await sharp(original)
			.ensureAlpha()
			.composite([{ input: blurredSoft, blend: "over" }])
			.toBuffer();

		buf = await sharp(buf)
			.composite([{ input: patch, left, top }])
			.toBuffer();
	}

	return buf;
}

async function main(): Promise<void> {
	const title = process.env.ISSUE_TITLE ?? "";
	const body = process.env.ISSUE_BODY ?? "";

	const date = getDate(title);

	const imageUrl = extractImageUrl(body);
	if (!imageUrl) {
		console.error("No GitHub image attachment found in issue body.");
		process.exit(1);
	}

	const filename = getUniqueFilename(date, (f) =>
		fs.existsSync(`assets/ravs/${f}`),
	);
	const outputPath = `assets/ravs/${filename}`;

	const tempPath = `/tmp/rav-download-${Date.now()}`;
	console.log(`Downloading: ${imageUrl}`);
	execFileSync("curl", ["-L", "--silent", "--fail", "-o", tempPath, imageUrl]);

	let imageBuffer = fs.readFileSync(tempPath);
	fs.unlinkSync(tempPath);

	imageBuffer = await blurLicensePlates(imageBuffer);

	console.log(`Processing → ${filename} (square crop, entropy)`);
	await sharp(imageBuffer)
		.resize(1200, 1200, { fit: "cover", position: "entropy" })
		.jpeg({ quality: 82, progressive: true })
		.toFile(outputPath);

	const rawGallery = fs.existsSync("gallery.json")
		? (JSON.parse(fs.readFileSync("gallery.json", "utf8")) as Gallery)
		: { images: [] };
	const newGallery = updateGallery(rawGallery, filename);
	fs.writeFileSync("gallery.json", `${JSON.stringify(newGallery, null, 2)}\n`);

	let html = fs.readFileSync("index.html", "utf8");
	html = updateOgImage(html, filename);
	fs.writeFileSync("index.html", html);

	fs.writeFileSync("/tmp/rav-filename", filename);
	fs.writeFileSync("/tmp/rav-commit-msg", `add ${filename}`);

	console.log(`Done! ${filename}`);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
