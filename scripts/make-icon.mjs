/**
 * Marketplace ikonunu uretir (images/icon.png, 256x256).
 *
 * Cizim ve PNG kodlama projenin kendi kodu ile yapilir - ikon icin bile
 * disaridan paket alinmaz. 4x asiri ornekleme (supersampling) ile kenarlar
 * yumusatilir.
 *
 *   pnpm run compile && node scripts/make-icon.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { encodePng, PNG_RGBA } = require(join(root, 'out/core/png.js'));

const SIZE = 256;
const SS = 4;                 // asiri ornekleme carpani
const W = SIZE * SS;

const BACKDROP = [27, 58, 92];       // koyu lacivert
const PAGE = [250, 250, 250];
const FOLD = [206, 214, 224];
const TEXT_BAR = [154, 165, 178];
const ACCENT = [74, 163, 255];

const page = { x: 62 * SS, y: 40 * SS, w: 132 * SS, h: 176 * SS };
const foldSize = 40 * SS;

/** Sekil kumesi: her piksel icin ustteki ilk eslesen renk kazanir. */
function colorAt(x, y) {
    // Sayfa govdesi (sag ust kose kesik).
    if (inRect(x, y, page.x, page.y, page.w, page.h)) {
        const fromRight = page.x + page.w - x;
        const fromTop = y - page.y;
        if (fromRight + fromTop < foldSize) { return null; }        // kesilen kose: arka plan
        if (fromRight + fromTop < foldSize + 3 * SS) { return FOLD; } // kivrim golgesi

        for (const bar of bars()) {
            if (inRect(x, y, bar.x, bar.y, bar.w, bar.h)) { return bar.color; }
        }
        return PAGE;
    }
    return null;
}

function bars() {
    const out = [];
    const left = page.x + 20 * SS;
    const width = page.w - 40 * SS;
    const heights = [8, 8, 8, 8, 8];
    let y = page.y + 62 * SS;
    heights.forEach((h, index) => {
        const isAccent = index === 0;
        out.push({
            x: left,
            y,
            w: index === heights.length - 1 ? width * 0.55 : (isAccent ? width * 0.7 : width),
            h: h * SS,
            color: isAccent ? ACCENT : TEXT_BAR,
        });
        y += (h + 14) * SS;
    });
    return out;
}

function inRect(x, y, rx, ry, rw, rh) {
    return x >= rx && x < rx + rw && y >= ry && y < ry + rh;
}

/** Yuvarlatilmis kose maskesi - ikonun disi seffaf kalir. */
function insideBackdrop(x, y) {
    const r = 48 * SS;
    const cx = Math.min(Math.max(x, r), W - r);
    const cy = Math.min(Math.max(y, r), W - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
                const px = x * SS + sx;
                const py = y * SS + sy;
                if (!insideBackdrop(px, py)) { continue; }
                const color = colorAt(px, py) ?? BACKDROP;
                r += color[0]; g += color[1]; b += color[2]; a += 255;
            }
        }
        const samples = SS * SS;
        const target = (y * SIZE + x) * 4;
        const alpha = a / samples;
        // Renkleri kaplanan orana gore normalize et (seffaf kenarlarda kararma olmasin).
        const covered = Math.max(1, a / 255);
        rgba[target] = Math.round(r / covered);
        rgba[target + 1] = Math.round(g / covered);
        rgba[target + 2] = Math.round(b / covered);
        rgba[target + 3] = Math.round(alpha);
    }
}

mkdirSync(join(root, 'images'), { recursive: true });
const png = encodePng(rgba, SIZE, SIZE, PNG_RGBA);
writeFileSync(join(root, 'images/icon.png'), png);
console.log(`ikon uretildi: images/icon.png (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`);
