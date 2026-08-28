# CLAUDE.md — RAV4 COOL

## Project Overview

**RAV4 COOL** is a photo gallery of Toyota RAV4 sightings. Photos live in
Cloudflare R2, not in this repo. To add one you drop it into an R2 bucket; a
Cloudflare Worker blurs the license plates, crops it square, publishes it, and
prepends it to the gallery manifest. **Adding a photo does not require a
deploy or a commit.**

The site itself is static HTML/CSS/JS served by **Cloudflare Pages** via its
GitHub integration. That integration is configured in the Cloudflare dashboard,
so there is no deploy config in this repo. Pushing to `main` triggers a build.

---

## Repository Structure

```
rav4cool/
├── index.html                      # Main website (static HTML)
├── styles.css                      # Site styling
├── script.js                       # Fetches the R2 manifest, builds the gallery
├── assets/
│   ├── ravs/                       # Backup copies of the photos now in R2
│   ├── cursor.png
│   └── jingle.mp3
├── worker/                         # Cloudflare Worker: processes new uploads
│   ├── wrangler.jsonc
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                # queue() handler — the whole pipeline
│       ├── process.ts              # plate blur + square crop (Images binding)
│       ├── lib.ts                  # pure helpers
│       └── lib.test.ts
├── scripts/migrate-to-r2.ts        # One-off: the original R2 migration
├── gallery.json                    # Migration input only — NOT the live manifest
├── .github/workflows/lint.yml      # CI: actionlint + biome + tests
├── biome.json
└── package.json
```

---

## Cloudflare Architecture

```
rav4cool-uploads   (private)   ← drag a photo into upload/ via the dashboard
      │  object-create event notification (prefix: upload/)
      ▼
  Queue: rav4cool-process        (max_concurrency: 1)
      ▼
  Worker: rav4cool-process       (queue consumer; no fetch handler)
      ▼
rav4cool-images    (public, custom domain img.rav4.cool)
      gallery.json     ← the manifest the site fetches
      ravs/*.jpg       ← published photos
      latest.jpg       ← copy of the newest, used by og:image
```

**Two buckets on purpose.** An R2 custom domain serves an entire bucket and
cannot be scoped to a prefix. If raw uploads shared the public bucket, the
unblurred originals would be fetchable at `img.rav4.cool/upload/…`.

**No Worker in the read path.** The browser fetches `gallery.json` and the
images straight from R2. The Worker only runs when a photo is uploaded.

**`max_concurrency: 1` is required.** Each message does a read-modify-write of
`gallery.json`; concurrent consumers would clobber each other.

---

## The Gallery Manifest

`gallery.json` lives in R2 (**not** in this repo) and is the source of truth for
what the site displays, in order, newest first:

```json
{
  "images": [
    { "file": "20260808.jpg", "date": "20260808", "width": 1200, "height": 1200 },
    { "file": "old_rav.jpeg", "date": null, "width": 1280, "height": 960 }
  ]
}
```

- **Array order is display order.** It is not derived from filenames and must
  not be re-sorted: `old_rav.jpeg` belongs last despite sorting first, and
  `20240804roosubmission.jpg` sits between two October 2024 photos.
- **`date`** drives the overlay only. `null` means no overlay — deliberate, and
  what `old_rav.jpeg` has always done.
- **`width`/`height`** are the real intrinsic dimensions, used to reserve layout
  space. They must be per-image: only Worker-processed photos are 1200×1200,
  and a wrong ratio distorts the image rather than just mis-sizing its box.

To hide or reorder a photo, edit this object in R2. No code change needed.

### Caching gotcha

The `rav4.cool` zone has a **Browser Cache TTL of 4 hours**, which overrides any
shorter `cache-control` on responses Cloudflare edge-caches. In practice:

- `ravs/*.jpg` keeps `max-age=31536000` (longer than 4h, so respected).
- `latest.jpg` is served as `max-age=14400` regardless of what is set on the
  object. Harmless — it only affects how quickly the og:image preview updates.
- `gallery.json` keeps `max-age=60`, because JSON is not edge-cached by default
  (`cf-cache-status: DYNAMIC`), so the override never applies to it.

That last one is the one that matters: it is why a new photo appears within a
minute. If `gallery.json` ever starts edge-caching, new photos would take 4
hours to show up — fix it with a Cache Rule that respects origin headers.
`script.js` also fetches it with `cache: "no-store"`, so a reload inside that
minute still sees a photo published seconds ago.

### Never reuse a `ravs/` key

`immutable` is a promise that the bytes at a URL will never change, and
browsers keep it: they will not revalidate for a year, so a hard reload does
not help and nor does a Cloudflare purge for anyone who already has the file.

Filenames are `YYYYMMDD.jpg`, derived from the date and deduplicated only
against what is *currently* in the bucket. So **deleting a photo frees its
name for the next upload on the same date**, and that upload publishes
different bytes at a URL the world has cached as permanent. Hiding a photo by
removing its entry from `gallery.json` is safe; deleting the object from
`ravs/` is not, unless you are certain no date will collide with it.

---

## Development Setup

**Runtime**: [Bun](https://bun.sh/) (not Node.js)

```bash
bun install
bun run test        # unit tests
bun run typecheck   # tsc against the Worker
bun run biome       # lint + format check
bun run dev         # wrangler dev --remote (real R2 + Images bindings)
bun run deploy      # deploy the Worker
bun run tail        # stream Worker logs
bun run migrate     # dry run of the R2 migration; --execute to upload
```

`wrangler` commands need `wrangler login` first.

The Worker's `PLATE_RECOGNIZER_API_KEY` is a Worker secret
(`wrangler secret put`), never in `wrangler.jsonc`. Plate blurring is skipped
if it is absent.

---

## Adding Photos

**Normal path**: drag the photo into `rav4cool-uploads` under the `upload/`
prefix in the Cloudflare dashboard. Within a few seconds it is processed and
live. A date in the filename (`20260828.jpg`, or `IMG_20260828_1030.jpg`) sets
the overlay; otherwise today's date is used.

**If nothing appears**: check `failed/` in the uploads bucket. Rejected uploads
are moved there with a `reason` in their custom metadata, rather than sitting
silently in `upload/`. `bun run tail` shows the log.

**Uploading from an iPhone**: iOS Safari can hand the dashboard a **zero-byte
file**, and it has — `IMG_0741.jpeg` arrived that way. R2 stores the empty
object, the event fires, and the upload is a photo in name only. The Worker
rejects it outright (`reason: the upload is empty`), but nothing here can fix
it; the bytes never left the phone.

The object in R2 held no bytes at all, so nothing on this side lost them —
they never left the phone. Two explanations were tested and are wrong: the
photo was taken minutes beforehand, so it was not an un-downloaded iCloud
asset, and uploading immediately after picking failed the same way, so it was
not Safari's file handle going stale.

What the failing case had in common with the known reports is a **derivative
render**. iOS does not hand a web page the file it has on disk; when the photo
has been edited, when Safari's resize-on-upload prompt is answered with
anything but *Actual Size*, or when a HEIC has to become a JPEG (which is why
`IMG_0741.HEIC` uploads as `IMG_0741.jpeg`), it renders a fresh derivative at
pick time. That render is what can come back empty, and it explains why a
freshly-taken, fully-local photo uploaded without delay still arrived at zero
bytes.

**Upload via Files, not the photo library**: Share → Save to Files on the
phone, then upload that. The render happens once, in the foreground, into a
real file on disk, so there is nothing left to go wrong at pick time.

If an empty upload ever appears from a route with no render in it, that
assumption is wrong and the next thing to check is R2. `handleUpload` compares
the size on the event notification against the bytes it reads and warns when
they disagree — both zero means nothing was sent, and a non-zero notification
against an empty read means the bytes reached R2 and we lost them.

---

## Image Processing

`sharp` is a native module and **cannot run in a Worker**. All image work goes
through the Cloudflare Images binding (`env.IMAGES`), which is chainable so the
entire operation is a single encode:

0. Identify the format from its magic bytes (`sniffFormat`, called in
   `index.ts` before any of this) and transcode to JPEG unless it already is
   one. Deliberately *not* `IMAGES.info()`: that has to decode the image, so it
   is the call that fails on exactly the inputs this decision exists to handle.
   Bytes matching no known signature are rejected here rather than handed to
   the binding, because our error can name them and the binding's cannot.
1. POST the original to Plate Recognizer to locate plates.
2. For each plate, derive a padded, clamped crop region (`plateBoxToTrim`).
3. Blur the *whole* image, trim to the plate region, and `draw()` that patch
   back at the same coordinates. Blur-then-trim is deliberate: the patch pulls
   in surrounding pixels, so its edges blend instead of showing a hard seam.
   Each patch derives from the original, not the progressively-patched image,
   so there is one encode rather than one per plate.
4. Resize to 1200×1200, `fit: "cover"`, `gravity: "entropy"`.
5. Output progressive JPEG at quality 82.

**Plate detection fails open.** No API key, network error, bad status, or no
plates all publish the image unblurred rather than dropping the upload.

**So does `IMAGES.info()`**, which is called only for the intrinsic dimensions
the blur patches are positioned against. It is the one binding call that has
broken real uploads (an iPhone `.jpeg` it refused to read), so a throw costs the
blur at worst, never the photo: the image is re-encoded through the binding and
`info()` retried once against the normalised JPEG.

### Diagnosing a rejected upload

The binding's errors carry a numeric `code` and, sometimes, an empty `message`
— so `String(err)` renders them as the bare word "Error". Everything that logs
or quarantines goes through `describeError` instead, which is why the `reason`
metadata in `failed/` is now worth reading.

Three codes are the binding's verdict on the bytes rather than a transient
failure, and `isUndecodableImageError` quarantines them on the first attempt
instead of retrying three times for the same answer:

| Code | Meaning |
| ---- | ------- |
| 9412 | Not an image at all |
| 9413 | Over the 100 megapixel area limit |
| 9520 | A real image, in a format Images cannot read |

9412 says only "the requested file is not an image", so `describeInput` adds
the size, a hex dump of the first 16 bytes, and a text preview when the file
turns out not to be binary — enough to tell a truncated photo from an HTML
error page that got saved with a `.jpeg` name.

---

## Key Conventions

### Code Style (enforced by Biome)
- **Indent**: tabs. **Quotes**: double. Imports auto-organized.
- `biome check .` covers the whole repo, including `wrangler.jsonc`.
- Run `bun run biome` before committing; CI fails otherwise.

### Testing
`worker/src/lib.ts` holds every pure function and must stay free of Workers
globals and network/R2 access — that is what keeps it testable with plain
`bun test`. Side effects live in `index.ts` and `process.ts`.

**Rule**: all processing logic must be unit-testable and exported from
`lib.ts`. `updateGallery` must not mutate its input.

### Dates
`dateFromName` uses `/20\d{6}/` with **no word boundaries**, plus a calendar
check. The boundaries matter: `20240804roosubmission.jpg` and
`IMG_20260828_1030.jpg` both need to match, and neither does with `\b`.

---

## CI (`lint.yml`, on push to `main` and all PRs)
- `actionlint` — workflow syntax
- `biome check .` — lint and formatting
- `bun run test` — unit tests

---

## Important Notes for AI Assistants

- **Do not use Node.js APIs in the Worker** — Workers runtime only. `Bun.*` is
  fine in `scripts/`.
- **Do not use `npm` or `npx`** — use `bun`.
- **Biome is the only linter/formatter** — no ESLint, no Prettier.
- **No build step for the site** — `script.js` runs directly in the browser.
- **The R2 `gallery.json` is the source of truth**, not `assets/ravs/` and not
  the `gallery.json` in this repo — that one is only the migration's input and
  is not read by anything at runtime.
- **There is no GitHub Issue upload path any more.** Photos are added by
  dropping them into the R2 `upload/` prefix; that is the only route in.
- **Never re-sort the manifest** — array order is hand-maintained.
- **`assets/ravs/` is a backup.** The site no longer reads it. It is the
  rollback path, so do not delete it.
- Run `bun run test` and `bun run typecheck` after changing anything in
  `worker/`.
