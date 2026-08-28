/**
 * Ayristirici duman testi (dev araci).
 *
 * Derlenmis out/ katmanini gercek dosyalara karsi calistirir - VS Code acmadan
 * PDF/Office ayristiricilarinin ne cikardigini gorur.
 *
 *   pnpm run compile
 *   node scripts/smoke.mjs "C:/yol/dosya.docx" "C:/yol/dosya.pdf" ...
 *   node scripts/smoke.mjs --dir "C:/klasor"     (klasordeki desteklenen dosyalar)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { parseDocument } = require(join(root, 'out/formats/parse.js'));
const { kindForPath } = require(join(root, 'out/core/types.js'));

const LIMITS = {
    maxTotalUncompressed: 512 * 1024 * 1024,
    maxRatio: 200,
    maxRows: 5000,
    maxColumns: 200,
    csvDelimiter: 'auto',
    showImages: true,
};

function collect(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--list') {
            const listFile = args[++i];
            for (const line of readFileSync(listFile, 'utf8').split(String.fromCharCode(10))) {
                if (line.trim()) { out.push(line.trim()); }
            }
            continue;
        }
        if (args[i] === '--dir') {
            const dir = args[++i];
            for (const name of readdirSync(dir)) {
                const full = join(dir, name);
                if (statSync(full).isFile() && kindForPath(full)) { out.push(full); }
            }
        } else {
            out.push(args[i]);
        }
    }
    return out;
}

const files = collect(process.argv.slice(2));
if (!files.length) {
    console.error('kullanim: node scripts/smoke.mjs <dosya...> | --dir <klasor> | --list <liste.txt>');
    process.exit(1);
}

let ok = 0;
let failed = 0;
for (const file of files) {
    const label = basename(file);
    const started = process.hrtime.bigint();
    try {
        const model = parseDocument(readFileSync(file), label, extname(file).toLowerCase(), LIMITS);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const parts = [`kind=${model.kind}`];
        if (model.pages) {
            const lines = model.pages.reduce((n, p) => n + p.lines.length, 0);
            parts.push(`sayfa=${model.pages.length}`, `satir=${lines}`);
        }
        if (model.blocks) { parts.push(`blok=${model.blocks.length}`); }
        if (model.sheets) {
            parts.push(`sayfa=${model.sheets.length}`, `satir=${model.sheets.reduce((n, s) => n + s.rows.length, 0)}`);
        }
        if (model.json) {
            parts.push(`kayit=${model.json.records.length}/${model.json.totalRecords}`);
            if (model.json.invalidLines.length) { parts.push(`bozuk=${model.json.invalidLines.length}`); }
        }
        parts.push(`gorsel=${model.images.length}`);
        if (model.outline?.length) { parts.push(`outline=${model.outline.length}`); }
        if (model.warnings.length) { parts.push(`uyari=${model.warnings.length}`); }
        console.log(`OK   ${ms.toFixed(0).padStart(5)}ms  ${parts.join(' ')}  <- ${label}`);
        for (const w of model.warnings.slice(0, 3)) { console.log(`        ! ${w}`); }
        ok++;
    } catch (err) {
        console.log(`HATA         ${err.message}  <- ${label}`);
        failed++;
    }
}
console.log(`\n${ok} basarili, ${failed} hatali (${files.length} dosya)`);
