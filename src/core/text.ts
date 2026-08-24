/**
 * Kodlama sezme ve cozme (bagimliliksiz).
 *
 * CSV gibi duz metin dosyalari her zaman UTF-8 degildir; Turkiye'de Excel'den
 * cikan dosyalar sik sik windows-1254'tur. BOM -> gecerli UTF-8 -> windows-1254
 * sirasiyla denenir.
 */

/** windows-1254 (Turkce) tablosunun latin1'den ayrildigi kod noktalari. */
const CP1254_HIGH: Record<number, string> = {
    0x80: '\u20ac', 0x82: '\u201a', 0x83: '\u0192', 0x84: '\u201e', 0x85: '\u2026',
    0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02c6', 0x89: '\u2030', 0x8a: '\u0160',
    0x8b: '\u2039', 0x8c: '\u0152', 0x91: '\u2018', 0x92: '\u2019', 0x93: '\u201c',
    0x94: '\u201d', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014', 0x98: '\u02dc',
    0x99: '\u2122', 0x9a: '\u0161', 0x9b: '\u203a', 0x9c: '\u0153', 0x9f: '\u0178',
    0xd0: '\u011e', 0xdd: '\u0130', 0xde: '\u015e',
    0xf0: '\u011f', 0xfd: '\u0131', 0xfe: '\u015f',
};

export interface DecodedText {
    text: string;
    encoding: string;
}

export function decodeText(buf: Buffer): DecodedText {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return { text: buf.subarray(3).toString('utf8'), encoding: 'UTF-8 (BOM)' };
    }
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return { text: buf.subarray(2).toString('utf16le'), encoding: 'UTF-16 LE' };
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        return { text: swap16(buf.subarray(2)).toString('utf16le'), encoding: 'UTF-16 BE' };
    }
    if (isValidUtf8(buf)) {
        return { text: buf.toString('utf8'), encoding: 'UTF-8' };
    }
    return { text: decodeCp1254(buf), encoding: 'windows-1254' };
}

function swap16(buf: Buffer): Buffer {
    const out = Buffer.from(buf);
    if (out.length % 2 !== 0) { return out.subarray(0, out.length - 1).swap16(); }
    return out.swap16();
}

export function decodeCp1254(buf: Buffer): string {
    let out = '';
    for (const byte of buf) {
        out += byte < 0x80 ? String.fromCharCode(byte) : (CP1254_HIGH[byte] ?? String.fromCharCode(byte));
    }
    return out;
}

/** Kati UTF-8 dogrulamasi - asiri uzun kodlama ve yalniz-vekil (surrogate) reddedilir. */
export function isValidUtf8(buf: Buffer): boolean {
    let i = 0;
    while (i < buf.length) {
        const b = buf[i];
        if (b < 0x80) { i++; continue; }
        let need: number;
        let code: number;
        if (b >= 0xc2 && b <= 0xdf) { need = 1; code = b & 0x1f; }
        else if (b >= 0xe0 && b <= 0xef) { need = 2; code = b & 0x0f; }
        else if (b >= 0xf0 && b <= 0xf4) { need = 3; code = b & 0x07; }
        else { return false; }
        if (i + need >= buf.length) { return false; }
        for (let k = 1; k <= need; k++) {
            const cb = buf[i + k];
            if (cb < 0x80 || cb > 0xbf) { return false; }
            code = (code << 6) | (cb & 0x3f);
        }
        if (need === 2 && (code < 0x800 || (code >= 0xd800 && code <= 0xdfff))) { return false; }
        if (need === 3 && (code < 0x10000 || code > 0x10ffff)) { return false; }
        i += need + 1;
    }
    return true;
}
