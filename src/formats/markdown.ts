import { decodeText } from '../core/text';
import { imageSize } from '../core/imageinfo';
import { MAX_IMAGE_BYTES, MAX_IMAGE_COUNT, MAX_TOTAL_IMAGE_BYTES, type ParseLimits } from '../core/limits';
import type { Block, DocModel, EmbeddedImage, MetaEntry, Run, TableCell } from '../core/types';

/**
 * Markdown -> blok modeli (CommonMark + GFM tablolarinin pratik alt kumesi).
 *
 * Ham HTML BILEREK yorumlanmaz: `<div>` gibi bir satir duz metin olarak gosterilir.
 * Bu bir eksiklik degil, urunun guvenlik durusunun geregi - belge icerigi hicbir
 * zaman isaretlemeye donusmez.
 */

/** Belgeye goreli bir varligi (gorsel) okur; yoksa undefined. */
export type AssetReader = (relativePath: string) => Buffer | undefined;

const BACKSLASH = String.fromCharCode(92);
const RENDERABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp']);

const IMAGE_MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml',
};

interface Context {
    images: EmbeddedImage[];
    byPath: Map<string, string>;
    warnings: string[];
    totalImageBytes: number;
    limits: ParseLimits;
    readAsset?: AssetReader;
}

export function parseMarkdown(buf: Buffer, name: string, limits: ParseLimits, readAsset?: AssetReader): DocModel {
    const { text, encoding } = decodeText(buf);
    const context: Context = {
        images: [], byPath: new Map(), warnings: [], totalImageBytes: 0, limits, readAsset,
    };

    const lines = text.split(/\r?\n/);
    const meta: MetaEntry[] = [{ key: 'encoding', value: encoding }];
    let start = 0;

    // YAML on bilgisi (front matter): ayristirmaya calismadan anahtar/deger olarak gosterilir.
    if (lines[0] !== undefined && lines[0].trim() === '---') {
        const end = lines.findIndex((line, i) => i > 0 && (line.trim() === '---' || line.trim() === '...'));
        if (end > 0) {
            for (const line of lines.slice(1, end)) {
                const colon = line.indexOf(':');
                if (colon <= 0) { continue; }
                const key = line.slice(0, colon).trim();
                const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
                if (key && value) { meta.push({ key, value }); }
            }
            start = end + 1;
        }
    }

    const blocks = parseBlocks(lines.slice(start), context, 0);
    meta.push({ key: 'lines', value: String(lines.length) });
    if (!blocks.length) { context.warnings.push('Belgede goruntulenebilir icerik bulunamadi.'); }

    return { kind: 'markdown', name, meta, warnings: context.warnings, images: context.images, blocks };
}

const FENCE = /^(\s*)(```+|~~~+)\s*([^`]*)$/;
const ATX = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])\s*(?:\1\s*){2,}$/;
const LIST = /^(\s*)([-*+]|[0-9]{1,9}[.)])(\s+)(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const TABLE_SEP = /^\s*[|]?\s*:?-{2,}:?\s*([|]\s*:?-+:?\s*)+[|]?\s*$/;

function parseBlocks(lines: string[], context: Context, depth: number): Block[] {
    if (depth > 8) { return []; }
    const blocks: Block[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        if (line.trim() === '') { i++; continue; }

        const fence = FENCE.exec(line);
        if (fence) {
            const marker = fence[2][0];
            const body: string[] = [];
            i++;
            while (i < lines.length && !new RegExp('^\s*' + marker + '{' + fence[2].length + ',}\s*$').test(lines[i])) {
                body.push(lines[i]);
                i++;
            }
            i++; // kapanis cizgisi
            blocks.push({ t: 'code', text: body.join('\n'), lang: fence[3].trim() || undefined });
            continue;
        }

        if (RULE.test(line)) { blocks.push({ t: 'rule' }); i++; continue; }

        const atx = ATX.exec(line);
        if (atx) {
            blocks.push({ t: 'heading', level: atx[1].length, runs: parseInline(atx[2], context) });
            i++;
            continue;
        }

        if (QUOTE.test(line)) {
            const body: string[] = [];
            while (i < lines.length && (QUOTE.test(lines[i]) || (body.length > 0 && lines[i].trim() !== ''))) {
                const match = QUOTE.exec(lines[i]);
                body.push(match ? match[1] : lines[i]);
                i++;
            }
            blocks.push({ t: 'quote', blocks: parseBlocks(body, context, depth + 1) });
            continue;
        }

        // Girintili kod blogu (4 bosluk), yalniz liste baglami disinda.
        if (/^ {4}\S/.test(line)) {
            const body: string[] = [];
            while (i < lines.length && (/^ {4}/.test(lines[i]) || lines[i].trim() === '')) {
                body.push(lines[i].slice(4));
                i++;
            }
            while (body.length && body[body.length - 1].trim() === '') { body.pop(); }
            blocks.push({ t: 'code', text: body.join('\n') });
            continue;
        }

        if (LIST.test(line)) {
            const consumed = parseList(lines, i, context, depth);
            blocks.push(...consumed.blocks);
            i = consumed.next;
            continue;
        }

        if (lines[i + 1] !== undefined && line.includes('|') && TABLE_SEP.test(lines[i + 1])) {
            const consumed = parseTable(lines, i, context);
            if (consumed) { blocks.push(consumed.block); i = consumed.next; continue; }
        }

        // Setext basligi: alt satir === veya ---
        const next = lines[i + 1];
        if (next !== undefined && /^ {0,3}(=+|-+)\s*$/.test(next) && line.trim() !== '') {
            blocks.push({ t: 'heading', level: next.trim()[0] === '=' ? 1 : 2, runs: parseInline(line.trim(), context) });
            i += 2;
            continue;
        }

        // Paragraf: bos satira veya baska bir blok baslangicina kadar.
        const paragraph: string[] = [];
        while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines, i)) {
            paragraph.push(lines[i].trim());
            i++;
        }
        if (paragraph.length) {
            const runs = parseInline(paragraph.join('\n'), context);
            const only = onlyImage(runs);
            blocks.push(only ?? { t: 'para', runs });
        }
    }
    return blocks;
}

/** Paragrafin ortasinda yeni bir blok basliyor mu? */
function startsBlock(lines: string[], i: number): boolean {
    const line = lines[i];
    if (FENCE.test(line) || ATX.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line)) { return true; }
    return lines[i + 1] !== undefined && line.includes('|') && TABLE_SEP.test(lines[i + 1]);
}

const BULLETS = ['\u2022', '\u25e6', '\u25aa'];

/** Liste ogelerini girinti seviyesine gore toplar; ic ice listeler desteklenir. */
function parseList(lines: string[], from: number, context: Context, depth: number): { blocks: Block[]; next: number } {
    const blocks: Block[] = [];
    const counters = new Map<number, number>();
    let i = from;

    while (i < lines.length) {
        const match = LIST.exec(lines[i]);
        if (!match) {
            if (lines[i].trim() === '' && LIST.test(lines[i + 1] ?? '')) { i++; continue; }
            break;
        }

        const indent = match[1].replace(/\t/g, '    ').length;
        const level = Math.min(Math.floor(indent / 2), 5);
        const ordered = /[0-9]/.test(match[2]);

        // Daha derin seviyeler yeniden baslar.
        for (const key of [...counters.keys()]) {
            if (key > level) { counters.delete(key); }
        }
        const marker = ordered
            ? `${(counters.set(level, (counters.get(level) ?? Number(match[2]) - 1) + 1).get(level))}.`
            : BULLETS[level % BULLETS.length];

        // Oge govdesi: ilk satir + daha derin girintili devam satirlari.
        const body = [match[4]];
        i++;
        while (i < lines.length) {
            if (LIST.test(lines[i])) {
                const nested = LIST.exec(lines[i])!;
                if (nested[1].replace(/\t/g, '    ').length > indent) { body.push(lines[i].slice(indent)); i++; continue; }
                break;
            }
            if (lines[i].trim() === '') { break; }
            if (lines[i].startsWith(' '.repeat(indent + 2))) { body.push(lines[i].trim()); i++; continue; }
            body.push(lines[i].trim());
            i++;
        }

        const inner = parseBlocks(body, context, depth + 1);
        const first = inner.shift();
        if (first && first.t === 'para') {
            blocks.push({ t: 'para', runs: first.runs, list: { kind: ordered ? 'number' : 'bullet', level, marker } });
        } else if (first) {
            blocks.push({ t: 'para', runs: [{ text: '' }], list: { kind: ordered ? 'number' : 'bullet', level, marker } });
            blocks.push(first);
        }
        blocks.push(...inner);
    }
    return { blocks, next: i };
}

/** GFM boru (pipe) tablosu. */
function parseTable(lines: string[], from: number, context: Context): { block: Block; next: number } | undefined {
    const header = splitRow(lines[from]);
    if (!header.length) { return undefined; }
    const rows: TableCell[][] = [
        header.map((cell) => ({ blocks: [{ t: 'para', runs: parseInline(cell, context) } as Block], header: 1 as const })),
    ];

    let i = from + 2;
    while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const cells = splitRow(lines[i]);
        if (!cells.length) { break; }
        rows.push(cells.map((cell) => ({ blocks: [{ t: 'para', runs: parseInline(cell, context) } as Block] })));
        i++;
    }
    return { block: { t: 'table', rows }, next: i };
}

/** Satiri boru karakterinden boler; kacislanmis borular korunur. */
function splitRow(line: string): string[] {
    const trimmed = line.trim().replace(/^[|]/, '').replace(/[|]$/, '');
    const out: string[] = [];
    let current = '';
    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (ch === BACKSLASH && trimmed[i + 1] === '|') { current += '|'; i++; continue; }
        if (ch === '|') { out.push(current.trim()); current = ''; continue; }
        current += ch;
    }
    out.push(current.trim());
    return out;
}

/** Satir ici bicimlendirme: kalin, egik, ustu cizili, kod, baglanti, gorsel. */
function parseInline(text: string, context: Context): Run[] {
    const runs: Run[] = [];
    let buffer = '';
    let i = 0;
    const format: Run = { text: '' };

    const flush = () => {
        if (buffer) { runs.push({ ...format, text: buffer }); buffer = ''; }
    };

    while (i < text.length) {
        const ch = text[i];

        if (ch === BACKSLASH && i + 1 < text.length && /[\`*_{}[\]()#+\-.!|~>]/.test(text[i + 1])) {
            buffer += text[i + 1];
            i += 2;
            continue;
        }

        // Satir ici kod: en yakin esit uzunluktaki geri tirnak grubuna kadar.
        if (ch === '`') {
            let ticks = 0;
            while (text[i + ticks] === '`') { ticks++; }
            const close = text.indexOf('`'.repeat(ticks), i + ticks);
            if (close > 0) {
                flush();
                runs.push({ ...format, mono: 1, text: text.slice(i + ticks, close).trim() });
                i = close + ticks;
                continue;
            }
        }

        // Gorsel: ![alt](kaynak)
        if (ch === '!' && text[i + 1] === '[') {
            const link = readLink(text, i + 1);
            if (link) {
                flush();
                const image = loadImage(link.href, link.label, context);
                runs.push(image ?? { ...format, i: 1, text: `[${link.label || link.href}]` });
                i = link.next;
                continue;
            }
        }

        // Baglanti: [metin](hedef)
        if (ch === '[') {
            const link = readLink(text, i);
            if (link) {
                flush();
                runs.push({ ...format, u: 1, link: link.href, text: link.label || link.href });
                i = link.next;
                continue;
            }
        }

        // Otomatik baglanti: <https://...>
        if (ch === '<') {
            const close = text.indexOf('>', i);
            const inner = close > 0 ? text.slice(i + 1, close) : '';
            if (/^(https?|mailto):\S+$/.test(inner)) {
                flush();
                runs.push({ ...format, u: 1, link: inner, text: inner });
                i = close + 1;
                continue;
            }
        }

        const marker = readEmphasis(text, i);
        if (marker) {
            flush();
            const inner = parseInline(marker.body, context);
            for (const run of inner) {
                runs.push({ ...run, b: marker.bold || run.b, i: marker.italic || run.i, s: marker.strike || run.s });
            }
            i = marker.next;
            continue;
        }

        buffer += ch === '\n' ? ' ' : ch;
        i++;
    }
    flush();
    return runs.filter((run) => run.text !== '' || run.img !== undefined);
}

/** `[etiket](hedef "baslik")` okur. Ic ice koseli parantezler sayilir. */
function readLink(text: string, at: number): { label: string; href: string; next: number } | undefined {
    if (text[at] !== '[') { return undefined; }
    let depth = 0;
    let close = -1;
    for (let i = at; i < text.length; i++) {
        if (text[i] === BACKSLASH) { i++; continue; }
        if (text[i] === '[') { depth++; }
        else if (text[i] === ']') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close < 0 || text[close + 1] !== '(') { return undefined; }

    let paren = 0;
    let end = -1;
    for (let i = close + 1; i < text.length; i++) {
        if (text[i] === BACKSLASH) { i++; continue; }
        if (text[i] === '(') { paren++; }
        else if (text[i] === ')') { paren--; if (paren === 0) { end = i; break; } }
    }
    if (end < 0) { return undefined; }

    const target = text.slice(close + 2, end).trim();
    const href = target.replace(/\s+"[^"]*"$/, '').replace(/^<|>$/g, '').trim();
    return { label: text.slice(at + 1, close), href, next: end + 1 };
}

/** `**`, `__`, `*`, `_`, `~~` vurgularini okur. */
function readEmphasis(text: string, at: number): { body: string; bold?: 1; italic?: 1; strike?: 1; next: number } | undefined {
    const ch = text[at];
    if (ch !== '*' && ch !== '_' && ch !== '~') { return undefined; }
    const double = text[at + 1] === ch;
    const marker = double ? ch + ch : ch;
    if (ch === '~' && !double) { return undefined; }
    // Vurgu isareti bosluk ile baslayamaz (CommonMark sol-kenar kurali).
    if (text[at + marker.length] === undefined || /\s/.test(text[at + marker.length])) { return undefined; }

    const close = text.indexOf(marker, at + marker.length);
    if (close < 0) { return undefined; }
    const body = text.slice(at + marker.length, close);
    if (!body || /\s$/.test(body)) { return undefined; }

    return {
        body,
        bold: ch !== '~' && double ? 1 : undefined,
        italic: ch !== '~' && !double ? 1 : undefined,
        strike: ch === '~' ? 1 : undefined,
        next: close + marker.length,
    };
}

/** Tek basina gorsel tasiyan paragrafi gorsel blogu yapar (ortalanmis, tam genislik). */
function onlyImage(runs: Run[]): Block | undefined {
    if (runs.length !== 1 || !runs[0].img) { return undefined; }
    return { t: 'image', id: runs[0].img, alt: runs[0].text || undefined };
}

/**
 * Belgeye goreli bir gorseli okur.
 *
 * Guvenlik: yol belgeden gelir, yani guvenilmez girdidir. Mutlak yollar, surucu
 * harfleri ve `..` segmentleri reddedilir; boylece bir markdown dosyasi belge
 * klasorunun disindaki hicbir dosyayi okutamaz. Uzak adresler (http) aga cikis
 * gerektirdigi icin hic denenmez.
 */
function loadImage(href: string, alt: string, context: Context): Run | undefined {
    if (!context.limits.showImages || !context.readAsset) { return undefined; }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith('/') || href.startsWith(BACKSLASH)) { return undefined; }
    const normalized = href.split(BACKSLASH).join('/').split('#')[0].split('?')[0];
    if (normalized.split('/').some((part) => part === '..')) { return undefined; }

    const existing = context.byPath.get(normalized);
    if (existing) { return { text: alt, img: existing }; }
    if (context.images.length >= MAX_IMAGE_COUNT || context.totalImageBytes >= MAX_TOTAL_IMAGE_BYTES) { return undefined; }

    const dot = normalized.lastIndexOf('.');
    const mime = dot < 0 ? undefined : IMAGE_MIME[normalized.slice(dot + 1).toLowerCase()];
    if (!mime || !RENDERABLE.has(mime)) { return undefined; }

    const data = context.readAsset(normalized);
    if (!data || data.length === 0) {
        context.warnings.push(`Gorsel bulunamadi: ${normalized}`);
        return undefined;
    }
    if (data.length > MAX_IMAGE_BYTES) {
        context.warnings.push(`Gorsel atlandi (cok buyuk): ${normalized}`);
        return undefined;
    }

    context.totalImageBytes += data.length;
    const id = `img${context.images.length + 1}`;
    const size = imageSize(data);
    context.images.push({
        id, mime, base64: data.toString('base64'),
        width: size?.width, height: size?.height,
        name: normalized.slice(normalized.lastIndexOf('/') + 1),
        alt: alt || undefined,
    });
    context.byPath.set(normalized, id);
    return { text: alt, img: id };
}
