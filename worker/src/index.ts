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
	describeError,
	describeInput,
	getDate,
	getUniqueFilename,
	isImageKey,
	isUndecodableImageError,
	parseGallery,
	sameEtag,
	serializeGallery,
	sniffFormat,
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

/**
 * What a zero-byte upload gets told.
 *
 * `reported` is the size on the event notification, and printing it next to
 * what we actually read is the point: the two agreeing at zero means the
 * bytes never left the browser, while a non-zero `reported` against an empty
 * read means the object changed under us and the problem is on this side.
 */
function emptyUpload(reported: number | undefined): string {
	const notification =
		reported === undefined
			? "the event notification did not say what size it was"
			: `the event notification reported ${reported} bytes`;
	return (
		`the upload is empty — read 0 bytes, ${notification}. There is no photo ` +
		"here to process; upload it again."
	);
}

export default {
	async queue(
		batch: MessageBatch<R2EventNotification>,
		env: Env,
	): Promise<void> {
		for (const message of batch.messages) {
			const key = message.body?.object?.key ?? "<unknown>";
			const etag = message.body?.object?.eTag;
			try {
				await handleUpload(message.body, env);
				message.ack();
			} catch (err) {
				if (err instanceof TerminalError) {
					console.error(`[${key}] rejected: ${err.message}`);
					await quarantine(env, key, err.message, etag);
					message.ack();
				} else if (isUndecodableImageError(err)) {
					// The binding has looked at the bytes and refused them. Three
					// attempts at that is three identical answers, so quarantine now.
					const reason = describeError(err);
					console.error(`[${key}] rejected: ${reason}`);
					await quarantine(env, key, reason, etag);
					message.ack();
				} else if (message.attempts >= MAX_ATTEMPTS) {
					// describeError, not String(err): the Images binding throws errors
					// with an empty message, which String() renders as a bare "Error".
					const reason = describeError(err);
					console.error(
						`[${key}] giving up after ${message.attempts}: ${reason}`,
					);
					await quarantine(env, key, reason, etag);
					message.ack();
				} else {
					console.error(
						`[${key}] attempt ${message.attempts} failed: ${describeError(err)}`,
					);
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
	// Speaks up only when it has something to say. The two disagreeing means
	// the object was replaced between the event and this read, which is worth
	// knowing about whether or not what we read is usable.
	if (
		event.object.size !== undefined &&
		event.object.size !== original.byteLength
	) {
		console.warn(
			`[${key}] read ${original.byteLength} bytes, notification said ` +
				`${event.object.size} — the object changed after the event fired`,
		);
	}
	if (original.byteLength === 0) {
		throw new TerminalError(emptyUpload(event.object.size));
	}
	if (original.byteLength > MAX_INPUT_BYTES) {
		throw new TerminalError(
			`${original.byteLength} bytes exceeds the Images binding limit`,
		);
	}

	// Check the bytes, not just the extension. The Images binding's verdict on
	// an unreadable file is "the requested file is not an image" and nothing
	// else, so anything we can identify ourselves is worth identifying here,
	// where the reason lands in the quarantined object's metadata.
	// Keep the signatures sniffFormat knows in step with IMAGE_EXTENSIONS.
	const format = sniffFormat(original);
	if (!format) {
		throw new TerminalError(
			`${basename(key)} is not a readable image: ${describeInput(original)}`,
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
		format,
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
	// file in place for the retry — and only if it is still the object this
	// message was about. Re-uploading the same filename is the normal reaction
	// to a photo not appearing, and deleting the replacement instead of the
	// original loses the very photo the retry was meant to publish.
	await deleteIfUnchanged(env, key, event.object.eTag);

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
	etag: string | undefined,
): Promise<void> {
	try {
		const object = await env.UPLOADS.get(key);
		if (!object) return;
		// Whatever is at this key now may not be what failed. A retried message
		// can be minutes behind the event, which is ample time to re-upload the
		// same filename, and quarantining that would file a perfectly good photo
		// under failed/ and delete it from under its own pending event.
		// `etag &&` because only a positive mismatch is evidence. An event that
		// carried no etag tells us nothing, and must not strand the upload here.
		if (etag && !sameEtag(object.etag, etag)) {
			console.log(
				`[${key}] replaced since the event fired, leaving it for its own message`,
			);
			return;
		}
		await env.UPLOADS.put(FAILED_PREFIX + basename(key), object.body, {
			customMetadata: { reason: reason.slice(0, 900), originalKey: key },
		});
		await env.UPLOADS.delete(key);
		console.log(`[${key}] moved to ${FAILED_PREFIX}${basename(key)}`);
	} catch (err) {
		console.error(`[${key}] could not quarantine:`, err);
	}
}

/**
 * Delete a key unless it demonstrably holds a different object than the event
 * described. An event without an etag is no evidence of replacement, so it
 * deletes — leaving processed uploads behind would be its own bug.
 */
async function deleteIfUnchanged(
	env: Env,
	key: string,
	etag: string | undefined,
): Promise<void> {
	const current = await env.UPLOADS.head(key);
	if (etag && current && !sameEtag(current.etag, etag)) {
		console.log(`[${key}] replaced since the event fired, leaving it in place`);
		return;
	}
	await env.UPLOADS.delete(key);
}
