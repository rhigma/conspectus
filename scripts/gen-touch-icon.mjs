// Einmalig auf dem VPS ausführen: node scripts/gen-touch-icon.mjs
// Erzeugt frontend/apple-touch-icon.png (180x180) aus dem hellen SVG-Logo.
// Benötigt: npm install sharp (einmalig, kann danach wieder deinstalliert werden)

import sharp from 'sharp';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svgBuf = readFileSync(join(root, 'frontend', 'logo-hell.svg'));

// Weißen/beigen Hintergrund (#f5f0ea) hinter das transparente Logo legen
const bg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180">
     <rect width="180" height="180" rx="40" fill="#f5f0ea"/>
   </svg>`
);

const icon = await sharp(bg)
  .composite([{ input: await sharp(svgBuf).resize(180, 180).png().toBuffer(), top: 0, left: 0 }])
  .png()
  .toFile(join(root, 'frontend', 'apple-touch-icon.png'));

console.log('apple-touch-icon.png erstellt:', icon);
