// Queue consumer for RAV4 photo uploads.
//
// Drop a photo into rav4cool-uploads under `upload/` and an R2 event
// notification lands here. We blur the plates, crop to a square, publish to
// the public bucket, and prepend an entry to the gallery manifest.
//
// There is deliberately no fetch() handler: the site reads gallery.json and
// the images straight from R2 over the img.rav4.cool custom domain, so no
// Worker sits in the read path.

import {
	basename,
	getDate,
	getUniqueFilename,
	isImageKey,
	parseGallery,
	serializeGallery,
	updateGallery,
} from "./lib";
import { OUTPUT_SIZE, processImage } from "./process";

export interface Env {
	UPLOADS: R2Bucket;
	IMAGES_BUCKET: R2Bucket;
	IMAGES: ImagesBinding;
	PLATE_RECOGNIZER_API_KEY?: string;
}

interface R2EventNotification {
	account: string;
	action: string;
	bucket: string;
	object: { key: string; size?: number; eTag?: string };
	eventTime: string;
}

const MANIFEST_KEY = "gallery.json";
const LATEST_KEY = "latest.jpg";
const IMAGE_PREFIX = "ravs/";
const FAILED_PREFIX = "failed/";

/** The Images binding refuses an input over 20 MB. */
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** Must match `max_retries` + 1 in wrangler.jsonc. */
const MAX_ATTEMPTS = 3;

// ravs/* keys are written once and never change, so they can be cached hard.
// gallery.json is rewritten on every upload, so it gets a short TTL.
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const MANIFEST_CACHE = "public, max-age=60";
const LATEST_CACHE = "public, max-age=300";

/** An error that retrying cannot fix — quarantine the upload instead. */
class TerminalError extends Error {}

export default {
	async queue(
		batch: MessageBatch<R2EventNotification>,
		env: Env,
	): Promise<void> {
		for (const message of batch.messages) {
			const key = message.body?.object?.key ?? "<unknown>";
			try {
				await handleUpload(message.body, env);
				message.ack();
			} catch (err) {
				if (err instanceof TerminalError) {
					console.error(`[${key}] rejected: ${err.message}`);
					await quarantine(env, key, err.message);
					message.ack();
				} else if (message.attempts >= MAX_ATTEMPTS) {
					console.error(`[${key}] giving up after ${message.attempts}:`, err);
					await quarantine(env, key, String(err));
					message.ack();
				} else {
					console.error(`[${key}] attempt ${message.attempts} failed:`, err);
					message.retry();
				}
			}
		}
	},
} satisfies ExportedHandler<Env, R2EventNotification>;

async function handleUpload(
	event: R2EventNotification,
	env: Env,
): Promise<void> {
	const key = event.object.key;

	// Folder placeholders aren't uploads; ack and move on without quarantining.
	if (key.endsWith("/")) return;

	if (!isImageKey(key)) {
		throw new TerminalError(`not a supported image type: ${basename(key)}`);
	}
	if ((event.object.size ?? 0) > MAX_INPUT_BYTES) {
		throw new TerminalError(
			`${event.object.size} bytes exceeds the ${MAX_INPUT_BYTES} byte limit ` +
				"of the Images binding",
		);
	}

	const object = await env.UPLOADS.get(key);
	if (!object) {
		// Already processed, or deleted by hand between the event and now.
		console.log(`[${key}] no longer in the uploads bucket, skipping`);
		return;
	}
	const original = new Uint8Array(await object.arrayBuffer());
	if (original.byteLength > MAX_INPUT_BYTES) {
		throw new TerminalError(
			`${original.byteLength} bytes exceeds the Images binding limit`,
		);
	}

	// Read and validate the manifest before writing anything. A broken
	// gallery.json must abort the whole upload rather than leave an orphaned
	// image in the public bucket that nothing links to.
	const manifestObject = await env.IMAGES_BUCKET.get(MANIFEST_KEY);
	if (!manifestObject) {
		throw new Error(
			`${MANIFEST_KEY} is missing from the images bucket — refusing to ` +
				"create a new one, as that would replace the whole gallery",
		);
	}
	const gallery = parseGallery(await manifestObject.text());

	const processed = await processImage(
		env.IMAGES,
		original,
		env.PLATE_RECOGNIZER_API_KEY,
	);

	const date = getDate(basename(key));
	const filename = await getUniqueFilename(
		date,
		async (candidate) =>
			(await env.IMAGES_BUCKET.head(IMAGE_PREFIX + candidate)) !== null,
	);

	await env.IMAGES_BUCKET.put(IMAGE_PREFIX + filename, processed, {
		httpMetadata: {
			contentType: "image/jpeg",
			cacheControl: IMMUTABLE_CACHE,
		},
	});
	await env.IMAGES_BUCKET.put(
		MANIFEST_KEY,
		serializeGallery(
			updateGallery(gallery, {
				file: filename,
				date,
				width: OUTPUT_SIZE,
				height: OUTPUT_SIZE,
			}),
		),
		{
			httpMetadata: {
				contentType: "application/json",
				cacheControl: MANIFEST_CACHE,
			},
		},
	);
	// Stable URL for the og:image meta tag, so index.html never needs a redeploy.
	await env.IMAGES_BUCKET.put(LATEST_KEY, processed, {
		httpMetadata: { contentType: "image/jpeg", cacheControl: LATEST_CACHE },
	});

	// Only once every write above has succeeded, so a failure leaves the raw
	// file in place for the retry.
	await env.UPLOADS.delete(key);

	console.log(`[${key}] published ravs/${filename} (date ${date})`);
}

/**
 * Move a rejected upload to `failed/` so it is visible in the R2 dashboard
 * instead of sitting silently in `upload/` looking like nothing happened.
 * The event notification filters on the `upload/` prefix, so this does not
 * re-trigger the queue. Never throws — it runs inside a catch block.
 */
async function quarantine(
	env: Env,
	key: string,
	reason: string,
): Promise<void> {
	try {
		const object = await env.UPLOADS.get(key);
		if (!object) return;
		await env.UPLOADS.put(FAILED_PREFIX + basename(key), object.body, {
			customMetadata: { reason: reason.slice(0, 900), originalKey: key },
		});
		await env.UPLOADS.delete(key);
		console.log(`[${key}] moved to ${FAILED_PREFIX}${basename(key)}`);
	} catch (err) {
		console.error(`[${key}] could not quarantine:`, err);
	}
}
