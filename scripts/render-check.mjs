/**
 * Webview cizimini VS Code acmadan calistirir (dev araci).
 *
 * Gercek dosyalari ayristirir, `media/viewer.js`'i taklit DOM'da calistirir ve
 * "document" mesajini gonderir. Cizim yolunda bir istisna varsa burada patlar.
 *
 *   pnpm run compile
 *   node scripts/render-check.mjs <dosya...> | --dir <klasor>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createDom } from './domshim.mjs';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { parseDocument } = require(join(root, 'out/formats/parse.js'));
const { kindForPath } = require(join(root, 'out/core/types.js'));

const LIMITS = {
    maxTotalUncompressed: 512 * 1024 * 1024, maxRatio: 200,
    maxRows: 5000, maxColumns: 200, csvDelimiter: 'auto', showImages: true,
};
const SETTINGS = { theme: 'auto', showImages: true, pdfTextLayout: 'columns' };
const STRINGS = new Proxy({}, { get: (_, key) => String(key) });

const source = readFileSync(join(root, 'media/viewer.js'), 'utf8');

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
        } else { out.push(args[i]); }
    }
    return out;
}

const files = collect(process.argv.slice(2));
if (!files.length) {
    console.error('kullanim: node scripts/render-check.mjs <dosya...> | --dir <klasor> | --list <liste.txt>');
    process.exit(1);
}

let ok = 0;
let failed = 0;
for (const file of files) {
    const label = basename(file);
    try {
        const model = parseDocument(readFileSync(file), label, extname(file).toLowerCase(), LIMITS);
        const { root: appRoot, globals, posted } = createDom();
        const context = vm.createContext({ ...globals, console });
        vm.runInContext(source, context, { filename: 'viewer.js' });

        const listener = capturedListener(context);
        if (!listener) { throw new Error('viewer.js mesaj dinleyicisi kaydetmedi'); }
        listener({ data: { type: 'document', model, settings: SETTINGS, strings: STRINGS, viewState: null } });

        let nodes = 0;
        appRoot.walk(() => nodes++);
        const errors = posted.filter((m) => m.type === 'error');
        if (errors.length) { throw new Error(errors.map((e) => e.message).join('; ')); }
        if (nodes < 5) { throw new Error(`cizim bos gorunuyor (${nodes} dugum)`); }

        console.log(`OK   dugum=${String(nodes).padStart(6)}  kind=${model.kind}  <- ${label}`);
        ok++;
    } catch (err) {
        console.log(`HATA ${err.message}  <- ${label}`);
        failed++;
    }
}
console.log(`\n${ok} basarili, ${failed} hatali (${files.length} dosya)`);
process.exit(failed ? 1 : 0);

/** viewer.js `window.addEventListener('message', ...)` ile kaydolur; onu yakalar. */
function capturedListener(context) {
    return context.window.__messageListener;
}
