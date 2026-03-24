#!/usr/bin/env bun
// Run with: bun run blur [image-path]
// Reads PLATE_RECOGNIZER_API_KEY from .env automatically (bun loads .env natively)

import fs from "node:fs";
import path from "node:path";
import { blurLicensePlates } from "./process-rav";

const inputPath =
	process.argv[2] ?? path.join(import.meta.dir, "test-images", "test.jpg");

if (!fs.existsSync(inputPath)) {
	console.error(`Image not found: ${inputPath}`);
	console.error(
		"Usage: bun run blur [path/to/image.jpg]\n" +
			"       or drop a file at .github/scripts/test-images/test.jpg",
	);
	process.exit(1);
}

const ext = path.extname(inputPath);
const outputPath = inputPath.replace(ext, `.blurred${ext}`);

console.log(`Input:  ${inputPath}`);
const input = fs.readFileSync(inputPath);
const output = await blurLicensePlates(input);
fs.writeFileSync(outputPath, output);
console.log(`Output: ${outputPath}`);
