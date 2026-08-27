#!/usr/bin/env bun
//
// One-off migration of assets/ravs/ into the rav4cool-images R2 bucket.
//
//   bun run migrate                 # dry run: print what would happen
//   bun run migrate --execute       # actually upload
//   bun run migrate --execute --normalize
//
// --normalize re-encodes every image to 1200x1200 / q82 first, matching what
// the Worker does to new uploads. Off by default: an entropy crop on a
// non-square original may crop badly, so eyeball a dry run of the sizes first.
//
// Uploads go through `wrangler r2 object put`, so the only credential needed
// is an ordinary `wrangler login` — no R2 access keys.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
	dateFromName,
	type Gallery,
	serializeGallery,
} from "../worker/src/lib";

const BUCKET = "rav4cool-images";
const SOURCE_DIR = "assets/ravs";
const IMAGE_PREFIX = "ravs/";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const MANIFEST_CACHE = "public, max-age=60";
const LATEST_CACHE = "public, max-age=300";
const OUTPUT_SIZE = 1200;
const OUTPUT_QUALITY = 82;

const execute = process.argv.includes("--execute");
const normalize = process.argv.includes("--normalize");

function contentTypeFor(file: string): string {
	return file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
}

function put(key: string, file: string, contentType: string, cache: string) {
	execFileSync(
		"bunx",
		[
			"wrangler",
			"r2",
			"object",
			"put",
			`${BUCKET}/${key}`,
			"--file",
			file,
			"--content-type",
			contentType,
			"--cache-control",
			cache,
			"--remote",
		],
		{ stdio: ["ignore", "ignore", "inherit"] },
	);
}

// --- build the manifest ------------------------------------------------

const legacy = JSON.parse(fs.readFileSync("gallery.json", "utf8")) as {
	images: string[];
};

const missing = legacy.images.filter(
	(f) => !fs.existsSync(path.join(SOURCE_DIR, f)),
);
if (missing.length > 0) {
	console.error(
		`Listed in gallery.json but not on disk: ${missing.join(", ")}`,
	);
	process.exit(1);
}

const onDisk = fs.readdirSync(SOURCE_DIR).filter((f) => !f.startsWith("."));
const untracked = onDisk.filter((f) => !legacy.images.includes(f));
if (untracked.length > 0) {
	console.warn(
		`Note: on disk but not in gallery.json, skipping: ${untracked.join(", ")}`,
	);
}

// Array order is the gallery order and is preserved exactly. `date` drives the
// overlay only, which is why old_rav.jpeg can sit last with no date at all.
// Intrinsic dimensions go into the manifest so the frontend can reserve
// layout space per image. They must be the real ones: most of these are
// original camera output at assorted aspect ratios, and a wrong ratio would
// distort the image rather than merely mis-size its placeholder.
const gallery: Gallery = {
	images: await Promise.all(
		legacy.images.map(async (file) => {
			const meta = await sharp(path.join(SOURCE_DIR, file)).metadata();
			const size = normalize
				? { width: OUTPUT_SIZE, height: OUTPUT_SIZE }
				: { width: meta.width, height: meta.height };
			return { file, date: dateFromName(file), ...size };
		}),
	),
};

// --- report ------------------------------------------------------------

console.log(`\n${gallery.images.length} images -> ${BUCKET}/${IMAGE_PREFIX}\n`);
for (const [i, entry] of gallery.images.entries()) {
	const bytes = fs.statSync(path.join(SOURCE_DIR, entry.file)).size;
	const kb = `${Math.round(bytes / 1024)}k`.padStart(6);
	const date = entry.date ?? "(no date overlay)";
	const dims = `${entry.width}x${entry.height}`.padStart(10);
	console.log(
		`  ${String(i).padStart(2)}. ${entry.file.padEnd(28)} ${kb} ${dims}  ${date}`,
	);
}

const newest = gallery.images[0];
console.log(`\n  gallery.json  -> ${BUCKET}/gallery.json`);
console.log(`  latest.jpg    -> copy of ${newest.file}`);
console.log(
	`  normalize     -> ${normalize ? `yes (${OUTPUT_SIZE}px, q${OUTPUT_QUALITY})` : "no (byte-identical uploads)"}`,
);

if (!execute) {
	console.log("\nDry run. Re-run with --execute to upload.\n");
	process.exit(0);
}

// --- upload ------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rav4-migrate-"));
let latestSource = path.join(SOURCE_DIR, newest.file);

console.log("");
for (const [i, entry] of gallery.images.entries()) {
	const source = path.join(SOURCE_DIR, entry.file);
	let upload = source;

	if (normalize) {
		const sharp = (await import("sharp")).default;
		upload = path.join(tmpDir, entry.file);
		await sharp(source)
			.resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "cover", position: "entropy" })
			.jpeg({ quality: OUTPUT_QUALITY, progressive: true })
			.toFile(upload);
		if (i === 0) latestSource = upload;
	}

	put(
		IMAGE_PREFIX + entry.file,
		upload,
		contentTypeFor(entry.file),
		IMMUTABLE_CACHE,
	);
	console.log(`  uploaded ${IMAGE_PREFIX}${entry.file}`);
}

const manifestPath = path.join(tmpDir, "gallery.json");
fs.writeFileSync(manifestPath, serializeGallery(gallery));
put("gallery.json", manifestPath, "application/json", MANIFEST_CACHE);
console.log("  uploaded gallery.json");

put("latest.jpg", latestSource, "image/jpeg", LATEST_CACHE);
console.log(`  uploaded latest.jpg (${newest.file})`);

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\nDone. ${gallery.images.length} images + manifest.\n`);
