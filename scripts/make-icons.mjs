// Rasterizes public/icon.svg into the two PNG sizes the manifest references.
// Run with: npm run icons
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const here   = dirname(fileURLToPath(import.meta.url));
const root   = join(here, '..');
const svg    = readFileSync(join(root, 'public', 'icon.svg'));

for (const size of [192, 512]) {
  const out = join(root, 'public', `icon-${size}.png`);
  await sharp(svg).resize(size, size).png().toFile(out);
  console.log(`wrote ${out}`);
}
