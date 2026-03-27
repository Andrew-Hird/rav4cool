# CLAUDE.md — RAV4 COOL

## Project Overview

**RAV4 COOL** is a GitHub-automated photo gallery website for sharing Toyota RAV4 sightings. Users submit photos via GitHub Issues; a workflow validates, processes, and auto-commits them to the gallery.

---

## Repository Structure

```
rav4cool/
├── index.html                          # Main website (static HTML)
├── styles.css                          # Site styling
├── script.js                           # Frontend JS (gallery loader, audio, date overlays)
├── gallery.json                        # Ordered list of image filenames (newest first)
├── assets/
│   ├── ravs/                           # RAV4 photos (YYYYMMDD.jpg naming)
│   ├── cursor.png                      # Custom cursor
│   └── jingle.mp3                      # Audio played on first interaction
├── .github/
│   ├── workflows/
│   │   ├── process-rav.yml             # Main automation: triggered on issue creation
│   │   └── lint.yml                    # CI: actionlint + biome + tests
│   └── scripts/
│       ├── process-rav.ts              # Core image processing logic
│       ├── process-rav.test.ts         # Tests (Bun test runner)
│       └── test-blur.ts                # CLI utility to test license plate blurring
├── biome.json                          # Biome formatter/linter config
├── tsconfig.json                       # TypeScript config (strict mode)
├── package.json                        # Scripts and dependencies
└── bun.lock                            # Bun lockfile
```

---

## Development Setup

**Runtime**: [Bun](https://bun.sh/) (not Node.js)

```bash
bun install          # Install dependencies
bun run test         # Run tests
bun run biome        # Lint and format check
bun run blur         # Test license plate blurring on a local image
```

**Environment variable** (optional — blurring skipped if absent):
```
PLATE_RECOGNIZER_API_KEY=your_api_key_here
```
Copy `.env.example` to `.env` to configure locally.

---

## Tech Stack

| Layer | Tool |
|---|---|
| Runtime | Bun |
| Language | TypeScript (strict) |
| Image processing | sharp ^0.33.5 |
| Linting/formatting | Biome ^2.4.8 |
| CI/CD | GitHub Actions |
| Plate detection | Plate Recognizer API (optional) |

---

## Key Conventions

### File Naming
- RAV4 photos use `YYYYMMDD.jpg` (e.g., `20260324.jpg`)
- Duplicate dates get a suffix: `20260324_2.jpg`, `20260324_3.jpg`

### Code Style (enforced by Biome)
- **Indent**: tabs
- **Quotes**: double quotes in JavaScript/TypeScript
- **Imports**: auto-organized by Biome assist
- Run `bun run biome` before committing; CI will fail otherwise

### Gallery Order
- `gallery.json` is always **newest first**
- `og:image` in `index.html` always points to the newest photo
- Frontend applies lazy loading starting from the 3rd image

### Adding Photos Manually
1. Place photo in `assets/ravs/YYYYMMDD.jpg`
2. Prepend filename to the `images` array in `gallery.json`
3. Update `og:image` meta tag in `index.html` to the new filename
4. Commit with message: `add YYYYMMDD.jpg`

---

## Automated Image Processing Workflow

**Trigger**: Opening a GitHub Issue

**Access control**: Only repository collaborators can trigger processing.

**Issue format**:
- **Title**: Can contain a date in `YYYYMMDD` format; defaults to today if absent
- **Body**: Must contain a GitHub image attachment in markdown format:
  `![description](https://github.com/user-attachments/...)`

**Processing pipeline** (`.github/scripts/process-rav.ts`):
1. Extract date from issue title (`getDate`)
2. Extract image URL from issue body (`extractImageUrl`)
3. Download image via `curl`
4. Blur license plates via Plate Recognizer API (`blurLicensePlates`) — skipped if no API key
5. Resize/crop to 1200×1200 square using entropy-based positioning (sharp)
6. Encode as progressive JPEG at 82% quality
7. Generate unique filename (`getUniqueFilename`)
8. Prepend to `gallery.json` (`updateGallery`)
9. Update `og:image` in `index.html` (`updateOgImage`)
10. Git commit & push; close issue with success comment

---

## Testing

Tests live in `.github/scripts/process-rav.test.ts` and use Bun's built-in test runner.

```bash
bun run test
```

Tested functions:
- `getDate()` — date extraction from issue titles
- `extractImageUrl()` — GitHub attachment URL parsing
- `getUniqueFilename()` — collision-safe filename generation
- `updateOgImage()` — og:image replacement in HTML
- `updateGallery()` — immutable gallery prepend

**Rule**: All processing logic must be unit-testable and exported from `process-rav.ts`. Side-effectful operations (file I/O, network calls) are isolated in `main()`.

---

## CI/CD

### `lint.yml` — runs on push to `main` and all PRs
- `actionlint` — validates GitHub Actions workflow syntax
- `biome check .` — linting and formatting
- `bun run test` — unit tests

### `process-rav.yml` — runs on issue creation
- Runs tests before processing
- Requires `PLATE_RECOGNIZER_API_KEY` secret for plate blurring
- Uses `GITHUB_TOKEN` for git push and issue comments

---

## Plate Blurring Details

`blurLicensePlates(imageBuffer)` in `process-rav.ts`:
1. POSTs image to Plate Recognizer API
2. For each detected plate bounding box:
   - Extracts region with 10px padding
   - Applies blur (radius 20) to region
   - Creates a feathered SVG mask with Gaussian blur for soft edges
   - Composites blurred region back over original
3. Gracefully skips if `PLATE_RECOGNIZER_API_KEY` is not set

---

## Important Notes for AI Assistants

- **Do not use Node.js APIs** — this project runs on Bun. Use `Bun.*` APIs where needed.
- **Do not use `npm` or `npx`** — use `bun` for all package/script operations.
- **Biome is the only linter/formatter** — there is no ESLint or Prettier.
- **No build step** — the frontend is vanilla HTML/CSS/JS; `script.js` runs directly in the browser.
- **`gallery.json` is the source of truth** for displayed images, not the filesystem.
- **Tests must pass** before any workflow runs image processing; always run `bun run test` after changes to `process-rav.ts`.
- **Immutability**: `updateGallery` must not mutate its input — return a new object.
- When modifying `.github/workflows/*.yml`, run `bun run lint` (actionlint) to validate syntax.
