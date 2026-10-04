#!/usr/bin/env node
// Renders tools/backgrounds/backgrounds.html into the backdrops the app ships with:
//   public/backgrounds/<id>.webp      full size, square (cover-fits any output ratio)
//   public/backgrounds/thumbs/<id>.webp  the gallery swatch
//   public/backgrounds/backgrounds.json  the list the Screener reads
// Usage:  npm run backgrounds                 (default 2880 px)
//         npm run backgrounds -- --size 3840
//         npm run backgrounds -- --preview out.png   (contact sheet only, writes nothing else)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = path.join(ROOT, 'tools', 'backgrounds', 'backgrounds.html');
const OUT = path.join(ROOT, 'public', 'backgrounds');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const SIZE = Number(arg('--size')) || 2880;
const THUMB = 192;

const browser = await chromium.launch();
try {
  const preview = arg('--preview');
  if (preview) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await page.goto(`file://${PAGE}?preview`);
    await page.screenshot({ path: path.resolve(preview), fullPage: true });
    console.log(`contact sheet → ${preview}`);
  } else {
    const page = await browser.newPage();
    await page.goto(`file://${PAGE}`);
    const list = await page.evaluate(() => window.BACKGROUNDS);
    fs.mkdirSync(path.join(OUT, 'thumbs'), { recursive: true });
    const write = (file, dataUrl) => fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    for (const { id, name } of list) {
      const { full, thumb } = await page.evaluate(([i, s, t]) => window.renderOne(i, s, t), [id, SIZE, THUMB]);
      write(path.join(OUT, `${id}.webp`), full);
      write(path.join(OUT, 'thumbs', `${id}.webp`), thumb);
      console.log(`${name.padEnd(14)} ${(fs.statSync(path.join(OUT, `${id}.webp`)).size / 1e6).toFixed(2)} MB`);
    }
    const index = list.map(({ id, name }) => ({ id, name, file: `${id}.webp`, thumb: `thumbs/${id}.webp` }));
    fs.writeFileSync(path.join(OUT, 'backgrounds.json'), JSON.stringify(index, null, 2) + '\n');
    console.log(`${list.length} backgrounds at ${SIZE}px → ${path.relative(ROOT, OUT)}/`);
  }
} finally {
  await browser.close();
}
