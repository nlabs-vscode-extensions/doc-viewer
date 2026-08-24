import type { PdfDocument } from './document';
import { arrayOf, dictOf, isStream, nameOf, numberOf, type PdfDict } from './objects';
import { encodingByName, glyphToUnicode, parseCMap, WIN_ANSI, type CMap, type EncodingTable } from './encoding';

/**
 * Yazi tipi sozlugunden metin cikarimi icin gereken bilgi: kod -> Unicode ve
 * kod -> genislik. Glif cizimi yapilmadigi icin yazi tipi programi hic okunmaz.
 */
export interface PdfFont {
    composite: boolean;
    byteLength: number;
    toUnicode?: CMap;
    encoding: EncodingTable;
    differences: Map<number, string>;
    widths: Map<number, number>;
    defaultWidth: number;
}

export interface Glyph {
    code: number;
    text: string;
    /** Metin uzayi genisligi (1/1000 birim bolunmus, yani 0..~1). */
    width: number;
}

export function loadFont(doc: PdfDocument, fontDict: PdfDict): PdfFont {
    const subtype = nameOf(doc.resolve(fontDict.get('Subtype') ?? null));
    const composite = subtype === 'Type0';

    const font: PdfFont = {
        composite,
        byteLength: composite ? 2 : 1,
        encoding: WIN_ANSI,
        differences: new Map(),
        widths: new Map(),
        defaultWidth: composite ? 1 : 0.5,
    };

    const toUnicodeValue = doc.resolve(fontDict.get('ToUnicode') ?? null);
    if (isStream(toUnicodeValue)) {
        const decoded = doc.decode(toUnicodeValue);
        if (decoded.data.length) {
            font.toUnicode = parseCMap(decoded.data);
            if (composite) { font.byteLength = Math.max(1, font.toUnicode.byteLength); }
        }
    }

    if (composite) {
        loadCompositeFont(doc, fontDict, font);
    } else {
        loadSimpleFont(doc, fontDict, font);
    }
    return font;
}

function loadSimpleFont(doc: PdfDocument, fontDict: PdfDict, font: PdfFont): void {
    const encodingValue = doc.resolve(fontDict.get('Encoding') ?? null);
    const encodingName = nameOf(encodingValue);
    if (encodingName) {
        font.encoding = encodingByName(encodingName);
    } else {
        const encodingDict = dictOf(encodingValue);
        if (encodingDict) {
            font.encoding = encodingByName(nameOf(doc.resolve(encodingDict.get('BaseEncoding') ?? null)));
            readDifferences(doc, encodingDict, font.differences);
        }
    }

    const firstChar = numberOf(doc.resolve(fontDict.get('FirstChar') ?? null)) ?? 0;
    const widths = arrayOf(doc.resolve(fontDict.get('Widths') ?? null));
    for (let i = 0; i < widths.length; i++) {
        const width = numberOf(doc.resolve(widths[i]));
        if (width !== undefined) { font.widths.set(firstChar + i, width / 1000); }
    }

    const descriptor = dictOf(doc.resolve(fontDict.get('FontDescriptor') ?? null));
    const missing = numberOf(doc.resolve(descriptor?.get('MissingWidth') ?? null));
    if (missing !== undefined) { font.defaultWidth = missing / 1000; }
}

/** /Differences dizisi: [kod /glif /glif ... kod /glif ...] */
function readDifferences(doc: PdfDocument, encodingDict: PdfDict, out: Map<number, string>): void {
    let code = 0;
    for (const item of arrayOf(doc.resolve(encodingDict.get('Differences') ?? null))) {
        const resolved = doc.resolve(item);
        const value = numberOf(resolved);
        if (value !== undefined) { code = Math.round(value); continue; }
        const glyph = nameOf(resolved);
        if (glyph) { out.set(code++, glyph); }
    }
}

function loadCompositeFont(doc: PdfDocument, fontDict: PdfDict, font: PdfFont): void {
    const descendant = dictOf(doc.resolve(arrayOf(doc.resolve(fontDict.get('DescendantFonts') ?? null))[0] ?? null));
    if (!descendant) { return; }

    const defaultWidth = numberOf(doc.resolve(descendant.get('DW') ?? null));
    font.defaultWidth = (defaultWidth ?? 1000) / 1000;

    // /W bicimi: [ c [w1 w2 ...]  cFirst cLast w  ... ]
    const w = arrayOf(doc.resolve(descendant.get('W') ?? null));
    let i = 0;
    while (i < w.length) {
        const first = numberOf(doc.resolve(w[i]));
        if (first === undefined) { i++; continue; }
        const next = doc.resolve(w[i + 1]);
        if (Array.isArray(next)) {
            for (let k = 0; k < next.length; k++) {
                const width = numberOf(doc.resolve(next[k]));
                if (width !== undefined) { font.widths.set(first + k, width / 1000); }
            }
            i += 2;
            continue;
        }
        const last = numberOf(next);
        const width = numberOf(doc.resolve(w[i + 2]));
        if (last !== undefined && width !== undefined && last >= first && last - first < 65536) {
            for (let code = first; code <= last; code++) { font.widths.set(code, width / 1000); }
        }
        i += 3;
    }
}

/** Bayt dizisini gliflere ayirir ve metne cevirir. */
export function decodeGlyphs(font: PdfFont, bytes: Buffer): Glyph[] {
    const out: Glyph[] = [];
    const step = font.byteLength;
    for (let i = 0; i + step <= bytes.length || (step === 2 && i < bytes.length); i += step) {
        const code = step === 2
            ? (bytes[i] << 8) | (bytes[i + 1] ?? 0)
            : bytes[i];
        out.push({
            code,
            text: glyphText(font, code),
            width: font.widths.get(code) ?? font.defaultWidth,
        });
    }
    return out;
}

function glyphText(font: PdfFont, code: number): string {
    const mapped = font.toUnicode?.map.get(code);
    if (mapped !== undefined) { return mapped; }

    if (!font.composite) {
        const glyph = font.differences.get(code);
        if (glyph) {
            const unicode = glyphToUnicode(glyph);
            return unicode === undefined ? '' : String.fromCodePoint(unicode);
        }
        const fromTable = font.encoding[code];
        return fromTable === undefined ? '' : String.fromCodePoint(fromTable);
    }

    // Bilesik yazi tipi, /ToUnicode yok: CID dogrudan Unicode olarak yorumlanamaz.
    // Yalnizca yazdirilabilir Latin araliginda makul bir tahmin yapilir.
    if (code >= 0x20 && code <= 0x7e) { return String.fromCharCode(code); }
    return '';
}
