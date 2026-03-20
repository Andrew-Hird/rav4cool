#!/usr/bin/env node

import sharp from 'sharp';
import fs from 'fs';

export function getDate(title: string | null | undefined): string {
  const match = (title ?? '').match(/\b(20\d{6})\b/);
  if (match) return match[1];
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
}

export function extractImageUrl(body: string | null | undefined): string | null {
  const match = (body ?? '').match(/!\[.*?\]\((https:\/\/github\.com\/user-attachments\/[^\s)]+)\)/);
  return match ? match[1] : null;
}

export function getUniqueFilename(date: string, exists: (filename: string) => boolean): string {
  let filename = `${date}.jpg`;
  let suffix = 2;
  while (exists(filename)) {
    filename = `${date}_${suffix}.jpg`;
    suffix++;
  }
  return filename;
}

export function updateHtml(html: string, filename: string): string {
  html = html.replace(
    /<meta property="og:image" content="[^"]*"/,
    `<meta property="og:image" content="https://rav4.cool/assets/ravs/${filename}"`
  );
  html = html.replace(
    '<div class="ravs">',
    `<div class="ravs">\n      <img src="assets/ravs/${filename}" alt="RAV4" />`
  );
  return html;
}

async function main(): Promise<void> {
  const title = process.env.ISSUE_TITLE ?? '';
  const body = process.env.ISSUE_BODY ?? '';

  const date = getDate(title);

  const imageUrl = extractImageUrl(body);
  if (!imageUrl) {
    console.error('No GitHub image attachment found in issue body.');
    process.exit(1);
  }

  const filename = getUniqueFilename(date, f => fs.existsSync(`assets/ravs/${f}`));
  const outputPath = `assets/ravs/${filename}`;

  console.log(`Downloading: ${imageUrl}`);
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status} ${res.statusText}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  console.log(`Optimizing → ${filename}`);
  await sharp(buffer)
    .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, progressive: true })
    .toFile(outputPath);

  let html = fs.readFileSync('index.html', 'utf8');
  html = updateHtml(html, filename);
  fs.writeFileSync('index.html', html);

  fs.writeFileSync('/tmp/rav-filename', filename);
  fs.writeFileSync('/tmp/rav-commit-msg', `add ${filename}`);

  console.log(`Done! ${filename}`);
}

if (import.meta.main) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
