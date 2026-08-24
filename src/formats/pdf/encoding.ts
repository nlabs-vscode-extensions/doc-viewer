/**
 * Yazi tipi kodlamalari ve glif adi -> Unicode esleme.
 *
 * Oncelik sirasi: /ToUnicode CMap  ->  /Encoding (+ /Differences)  ->  WinAnsi.
 * Tam Adobe Glyph List degil, pratikte gorulen adlarin karsiliklaridir; bilinmeyen
 * ad "uniXXXX" / "uXXXX" bicimindeyse dogrudan cozulur.
 */

/** cp1252'nin latin1'den ayrildigi 0x80-0x9F araligi (WinAnsiEncoding ile ayni). */
const WIN_HIGH: Record<number, number> = {
    0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
    0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
    0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
    0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
    0x9e: 0x017e, 0x9f: 0x0178,
};

/** StandardEncoding'in WinAnsi'den ayrildigi noktalar. */
const STANDARD_DIFFS: Record<number, number> = {
    0x27: 0x2019, 0x60: 0x2018, 0xa4: 0x2044, 0xa6: 0x0192, 0xa8: 0x00a4,
    0xa9: 0x0027, 0xaa: 0x201c, 0xab: 0x00ab, 0xac: 0x2039, 0xad: 0x203a,
    0xae: 0xfb01, 0xaf: 0xfb02, 0xb1: 0x2013, 0xb2: 0x2020, 0xb3: 0x2021,
    0xb4: 0x00b7, 0xb7: 0x2022, 0xb8: 0x201a, 0xb9: 0x201e, 0xba: 0x201d,
    0xbb: 0x00bb, 0xbc: 0x2026, 0xbd: 0x2030, 0xbf: 0x00bf, 0xc1: 0x0060,
    0xc2: 0x00b4, 0xc3: 0x02c6, 0xc4: 0x02dc, 0xc5: 0x00af, 0xc6: 0x02d8,
    0xc7: 0x02d9, 0xc8: 0x00a8, 0xca: 0x02da, 0xcb: 0x00b8, 0xcd: 0x02dd,
    0xce: 0x02db, 0xcf: 0x02c7, 0xd0: 0x2014, 0xe1: 0x00c6, 0xe3: 0x00aa,
    0xe8: 0x0141, 0xe9: 0x00d8, 0xea: 0x0152, 0xeb: 0x00ba, 0xf1: 0x00e6,
    0xf5: 0x0131, 0xf8: 0x0142, 0xf9: 0x00f8, 0xfa: 0x0153, 0xfb: 0x00df,
};

export type EncodingTable = (number | undefined)[];

function baseTable(): EncodingTable {
    const table: EncodingTable = new Array(256);
    for (let i = 32; i < 256; i++) { table[i] = i; }
    return table;
}

export const WIN_ANSI: EncodingTable = (() => {
    const table = baseTable();
    for (const key of Object.keys(WIN_HIGH)) {
        table[Number(key)] = WIN_HIGH[Number(key)];
    }
    // WinAnsi'de tanimsiz olan aralik nokta olarak gosterilmez, atlanir.
    table[0x81] = undefined; table[0x8d] = undefined; table[0x8f] = undefined;
    table[0x90] = undefined; table[0x9d] = undefined;
    return table;
})();

export const STANDARD: EncodingTable = (() => {
    const table = baseTable();
    for (let i = 0x80; i < 256; i++) { table[i] = undefined; }
    for (const key of Object.keys(STANDARD_DIFFS)) {
        table[Number(key)] = STANDARD_DIFFS[Number(key)];
    }
    return table;
})();

export function encodingByName(name: string | undefined): EncodingTable {
    if (name === 'StandardEncoding' || name === 'MacExpertEncoding') { return STANDARD; }
    // MacRomanEncoding ASCII bolgesinde WinAnsi ile ayni; ust bolge farklari
    // metin cikarimi icin ihmal edilebilir.
    return WIN_ANSI;
}

/** Sik gecen glif adlari. Latin harfleri ve rakamlar tek karakterli adlarla gelir. */
const GLYPH_NAMES: Record<string, number> = {
    space: 0x20, exclam: 0x21, quotedbl: 0x22, numbersign: 0x23, dollar: 0x24,
    percent: 0x25, ampersand: 0x26, quotesingle: 0x27, quoteright: 0x2019,
    quoteleft: 0x2018, parenleft: 0x28, parenright: 0x29, asterisk: 0x2a,
    plus: 0x2b, comma: 0x2c, hyphen: 0x2d, period: 0x2e, slash: 0x2f,
    zero: 0x30, one: 0x31, two: 0x32, three: 0x33, four: 0x34, five: 0x35,
    six: 0x36, seven: 0x37, eight: 0x38, nine: 0x39, colon: 0x3a, semicolon: 0x3b,
    less: 0x3c, equal: 0x3d, greater: 0x3e, question: 0x3f, at: 0x40,
    bracketleft: 0x5b, backslash: 0x5c, bracketright: 0x5d, asciicircum: 0x5e,
    underscore: 0x5f, grave: 0x60, braceleft: 0x7b, bar: 0x7c, braceright: 0x7d,
    asciitilde: 0x7e, quotedblleft: 0x201c, quotedblright: 0x201d,
    quotedblbase: 0x201e, quotesinglbase: 0x201a, endash: 0x2013, emdash: 0x2014,
    bullet: 0x2022, ellipsis: 0x2026, dagger: 0x2020, daggerdbl: 0x2021,
    perthousand: 0x2030, guilsinglleft: 0x2039, guilsinglright: 0x203a,
    guillemotleft: 0x00ab, guillemotright: 0x00bb, fi: 0xfb01, fl: 0xfb02,
    florin: 0x0192, trademark: 0x2122, Euro: 0x20ac, currency: 0x00a4,
    degree: 0x00b0, plusminus: 0x00b1, multiply: 0x00d7, divide: 0x00f7,
    minus: 0x2212, sterling: 0x00a3, yen: 0x00a5, cent: 0x00a2, section: 0x00a7,
    paragraph: 0x00b6, copyright: 0x00a9, registered: 0x00ae, ordfeminine: 0x00aa,
    ordmasculine: 0x00ba, exclamdown: 0x00a1, questiondown: 0x00bf,
    onequarter: 0x00bc, onehalf: 0x00bd, threequarters: 0x00be,
    onesuperior: 0x00b9, twosuperior: 0x00b2, threesuperior: 0x00b3,
    germandbls: 0x00df, ae: 0x00e6, AE: 0x00c6, oe: 0x0153, OE: 0x0152,
    oslash: 0x00f8, Oslash: 0x00d8, dotlessi: 0x0131, Idotaccent: 0x0130,
    Scedilla: 0x015e, scedilla: 0x015f, Gbreve: 0x011e, gbreve: 0x011f,
    Ccedilla: 0x00c7, ccedilla: 0x00e7, Udieresis: 0x00dc, udieresis: 0x00fc,
    Odieresis: 0x00d6, odieresis: 0x00f6, Adieresis: 0x00c4, adieresis: 0x00e4,
    Scaron: 0x0160, scaron: 0x0161, Zcaron: 0x017d, zcaron: 0x017e,
    Ydieresis: 0x0178, ydieresis: 0x00ff, ntilde: 0x00f1, Ntilde: 0x00d1,
    aacute: 0x00e1, eacute: 0x00e9, iacute: 0x00ed, oacute: 0x00f3, uacute: 0x00fa,
    agrave: 0x00e0, egrave: 0x00e8, igrave: 0x00ec, ograve: 0x00f2, ugrave: 0x00f9,
    acircumflex: 0x00e2, ecircumflex: 0x00ea, icircumflex: 0x00ee,
    ocircumflex: 0x00f4, ucircumflex: 0x00fb, atilde: 0x00e3, otilde: 0x00f5,
    aring: 0x00e5, Aring: 0x00c5, ccaron: 0x010d, sacute: 0x015b, zdotaccent: 0x017c,
};

/** Glif adini Unicode kod noktasina cevirir. Cozulemezse undefined. */
export function glyphToUnicode(glyph: string): number | undefined {
    const known = GLYPH_NAMES[glyph];
    if (known !== undefined) { return known; }
    if (glyph.length === 1) { return glyph.charCodeAt(0); }

    const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(glyph);
    if (uni) { return parseInt(uni[1], 16); }
    const u = /^u([0-9A-Fa-f]{4,6})$/.exec(glyph);
    if (u) { return parseInt(u[1], 16); }

    // "A.sc", "one.oldstyle" gibi bicem son ekleri.
    const dot = glyph.indexOf('.');
    if (dot > 0) { return glyphToUnicode(glyph.slice(0, dot)); }
    return undefined;
}

export interface CMap {
    /** Kod -> metin (birden cok karaktere eslesebilir, or. "fi"). */
    map: Map<number, string>;
    /** Kod basina bayt sayisi (1 veya 2). Kod alani araliklarindan belirlenir. */
    byteLength: number;
}

/**
 * /ToUnicode CMap ayristirici.
 *
 * Yalnizca metin cikarimi icin gereken bolumler islenir: codespacerange,
 * bfchar ve bfrange. PostScript yorumlanmaz.
 */
export function parseCMap(data: Buffer): CMap {
    const text = data.toString('latin1');
    const map = new Map<number, string>();
    let byteLength = 1;

    for (const block of blocks(text, 'begincodespacerange', 'endcodespacerange')) {
        for (const token of hexTokens(block)) {
            if (token.length >= 4) { byteLength = 2; }
        }
    }

    for (const block of blocks(text, 'beginbfchar', 'endbfchar')) {
        const tokens = hexTokens(block);
        for (let i = 0; i + 1 < tokens.length; i += 2) {
            const code = parseInt(tokens[i], 16);
            if (Number.isFinite(code)) { map.set(code, utf16beToString(tokens[i + 1])); }
            if (tokens[i].length >= 4) { byteLength = 2; }
        }
    }

    for (const block of blocks(text, 'beginbfrange', 'endbfrange')) {
        parseBfRange(block, map, (length) => { if (length >= 4) { byteLength = 2; } });
    }

    return { map, byteLength };
}

function parseBfRange(block: string, map: Map<number, string>, noteLength: (n: number) => void): void {
    // Girdiler: "<lo> <hi> <dst>" veya "<lo> <hi> [<d1> <d2> ...]"
    const pattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]*>)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(block)) !== null) {
        const lo = parseInt(match[1], 16);
        const hi = parseInt(match[2], 16);
        noteLength(match[1].length);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65535) { continue; }

        const target = match[3];
        if (target.startsWith('[')) {
            const items = hexTokens(target);
            for (let i = 0; i <= hi - lo && i < items.length; i++) {
                map.set(lo + i, utf16beToString(items[i]));
            }
            continue;
        }
        const base = target.slice(1, -1);
        if (!base) { continue; }
        const prefix = base.slice(0, Math.max(0, base.length - 4));
        const tail = parseInt(base.slice(-4) || '0', 16);
        for (let i = 0; i <= hi - lo; i++) {
            const hex = prefix + (tail + i).toString(16).padStart(4, '0');
            map.set(lo + i, utf16beToString(hex));
        }
    }
}

function* blocks(text: string, startWord: string, endWord: string): Generator<string> {
    let pos = 0;
    while (pos < text.length) {
        const start = text.indexOf(startWord, pos);
        if (start < 0) { return; }
        const end = text.indexOf(endWord, start);
        if (end < 0) { return; }
        yield text.slice(start + startWord.length, end);
        pos = end + endWord.length;
    }
}

function hexTokens(block: string): string[] {
    const out: string[] = [];
    const pattern = /<([0-9A-Fa-f]*)>/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(block)) !== null) { out.push(match[1]); }
    return out;
}

/** UTF-16BE onaltilik dizesini metne cevirir. */
function utf16beToString(hex: string): string {
    if (!hex) { return ''; }
    const padded = hex.length % 4 === 0 ? hex : hex.padStart(Math.ceil(hex.length / 4) * 4, '0');
    let out = '';
    for (let i = 0; i + 4 <= padded.length; i += 4) {
        const code = parseInt(padded.slice(i, i + 4), 16);
        if (Number.isFinite(code)) { out += String.fromCharCode(code); }
    }
    return out;
}
