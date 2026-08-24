import * as zlib from 'node:zlib';
import { arrayOf, dictOf, nameOf, numberOf, type PdfDict, type PdfStream, type PdfValue } from './objects';

/**
 * PDF akis filtreleri (ISO 32000-1, 7.4).
 *
 * Goruntu filtreleri (DCTDecode/JPXDecode/CCITTFaxDecode) burada COZULMEZ: veri
 * oldugu gibi birakilir, gorsel katmani onlari ya dogrudan kullanir (JPEG) ya da
 * atlar. Boylece kendi goruntu kod cozucumuzu yazma yuzeyi hic acilmaz.
 */

export const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode']);

export interface DecodeResult {
    data: Buffer;
    /** Cozulemeden birakilan son filtre (goruntu filtresi) - varsa. */
    imageFilter?: string;
    error?: string;
}

/** Akisi filtre zincirinden gecirir. Ust sinir, zip-bomb benzeri buyumeyi keser. */
export function decodeStream(stream: PdfStream, resolve: (v: PdfValue) => PdfValue, maxOutput: number): DecodeResult {
    const filters = filterNames(stream.dict, resolve);
    const parmsList = decodeParms(stream.dict, resolve, filters.length);

    let data = stream.raw;
    for (let i = 0; i < filters.length; i++) {
        const filter = filters[i];
        if (IMAGE_FILTERS.has(filter)) {
            return { data, imageFilter: filter };
        }
        try {
            data = applyFilter(filter, data, parmsList[i], resolve, maxOutput);
        } catch (err) {
            return { data: Buffer.alloc(0), error: `${filter}: ${(err as Error).message}` };
        }
        if (data.length > maxOutput) {
            return { data: data.subarray(0, maxOutput), error: 'akis boyut siniri asildi' };
        }
    }
    return { data };
}

function filterNames(dict: PdfDict, resolve: (v: PdfValue) => PdfValue): string[] {
    const raw = resolve(dict.get('Filter') ?? dict.get('F') ?? null);
    const single = nameOf(raw);
    if (single) { return [single]; }
    return arrayOf(raw).map((v) => nameOf(resolve(v))).filter((n): n is string => !!n);
}

function decodeParms(dict: PdfDict, resolve: (v: PdfValue) => PdfValue, count: number): (PdfDict | undefined)[] {
    const raw = resolve(dict.get('DecodeParms') ?? dict.get('DP') ?? null);
    const out: (PdfDict | undefined)[] = new Array(count).fill(undefined);
    const single = dictOf(raw);
    if (single) { out[0] = single; return out; }
    const list = arrayOf(raw);
    for (let i = 0; i < Math.min(count, list.length); i++) { out[i] = dictOf(resolve(list[i])); }
    return out;
}

function applyFilter(
    filter: string, data: Buffer, parms: PdfDict | undefined,
    resolve: (v: PdfValue) => PdfValue, maxOutput: number
): Buffer {
    switch (filter) {
        case 'FlateDecode':
        case 'Fl':
            return applyPredictor(inflate(data, maxOutput), parms, resolve);
        case 'LZWDecode':
        case 'LZW':
            return applyPredictor(lzwDecode(data, numberOf(resolve(parms?.get('EarlyChange') ?? null)) ?? 1, maxOutput), parms, resolve);
        case 'ASCIIHexDecode':
        case 'AHx':
            return asciiHexDecode(data);
        case 'ASCII85Decode':
        case 'A85':
            return ascii85Decode(data);
        case 'RunLengthDecode':
        case 'RL':
            return runLengthDecode(data, maxOutput);
        case 'Crypt':
            return data;
        default:
            throw new Error('desteklenmeyen filtre');
    }
}

/**
 * zlib akisi. Gercek dunyada bozuk basliklar ve eksik kuyruk sik gorulur;
 * once standart, sonra ham (raw) deflate, sonra "ne kadar cozulduyse o" denenir.
 */
function inflate(data: Buffer, maxOutput: number): Buffer {
    const options: zlib.ZlibOptions = { maxOutputLength: maxOutput };
    try {
        return zlib.inflateSync(data, options);
    } catch {
        // Bazi uretici araclar basligi atlar veya fazladan bayt koyar.
    }
    try {
        return zlib.inflateRawSync(data, options);
    } catch {
        // Kesilmis akis: elde edilebilen kismi al.
    }
    for (const skip of [1, 2]) {
        try {
            return zlib.inflateRawSync(data.subarray(skip), options);
        } catch {
            continue;
        }
    }
    try {
        return zlib.inflateSync(data, { ...options, finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch {
        throw new Error('flate akisi cozulemedi');
    }
}

/** LZW (TIFF surumu, degisken kod uzunlugu 9-12 bit). */
export function lzwDecode(data: Buffer, earlyChange: number, maxOutput: number): Buffer {
    const CLEAR = 256;
    const EOD = 257;
    const out: number[] = [];
    let dictionary: (number[])[] = [];

    const reset = () => {
        dictionary = new Array(258);
        for (let i = 0; i < 256; i++) { dictionary[i] = [i]; }
    };
    reset();

    let codeWidth = 9;
    let previous: number[] | undefined;
    let bitBuffer = 0;
    let bitCount = 0;

    for (let i = 0; i < data.length; i++) {
        bitBuffer = (bitBuffer << 8) | data[i];
        bitCount += 8;
        while (bitCount >= codeWidth) {
            const code = (bitBuffer >> (bitCount - codeWidth)) & ((1 << codeWidth) - 1);
            bitCount -= codeWidth;

            if (code === CLEAR) { reset(); codeWidth = 9; previous = undefined; continue; }
            if (code === EOD) { return Buffer.from(out); }

            let entry: number[];
            if (code < dictionary.length && dictionary[code]) {
                entry = dictionary[code];
            } else if (previous) {
                entry = [...previous, previous[0]];
            } else {
                return Buffer.from(out);
            }

            for (const byte of entry) { out.push(byte); }
            if (out.length > maxOutput) { return Buffer.from(out.slice(0, maxOutput)); }

            if (previous) { dictionary.push([...previous, entry[0]]); }
            previous = entry;

            const limit = dictionary.length + (earlyChange ? 1 : 0);
            if (limit >= 512 && codeWidth === 9) { codeWidth = 10; }
            else if (limit >= 1024 && codeWidth === 10) { codeWidth = 11; }
            else if (limit >= 2048 && codeWidth === 11) { codeWidth = 12; }
        }
    }
    return Buffer.from(out);
}

export function asciiHexDecode(data: Buffer): Buffer {
    const out: number[] = [];
    let high = -1;
    for (const c of data) {
        if (c === 0x3e /* > */) { break; }
        let digit = -1;
        if (c >= 0x30 && c <= 0x39) { digit = c - 0x30; }
        else if (c >= 0x41 && c <= 0x46) { digit = c - 0x37; }
        else if (c >= 0x61 && c <= 0x66) { digit = c - 0x57; }
        else { continue; }
        if (high < 0) { high = digit; } else { out.push(high * 16 + digit); high = -1; }
    }
    if (high >= 0) { out.push(high * 16); }
    return Buffer.from(out);
}

export function ascii85Decode(data: Buffer): Buffer {
    const out: number[] = [];
    let tuple = 0;
    let count = 0;
    let i = 0;
    // Bas taraftaki "<~" isaretcisi istege baglidir.
    if (data[0] === 0x3c && data[1] === 0x7e) { i = 2; }

    for (; i < data.length; i++) {
        const c = data[i];
        if (c === 0x7e /* ~ */) { break; }
        if (c === 0x7a /* z */ && count === 0) { out.push(0, 0, 0, 0); continue; }
        if (c < 0x21 || c > 0x75) { continue; }
        tuple = tuple * 85 + (c - 0x21);
        if (++count === 5) {
            out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
            tuple = 0; count = 0;
        }
    }
    if (count > 0) {
        for (let k = count; k < 5; k++) { tuple = tuple * 85 + 84; }
        const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
        for (let k = 0; k < count - 1; k++) { out.push(bytes[k]); }
    }
    return Buffer.from(out);
}

export function runLengthDecode(data: Buffer, maxOutput: number): Buffer {
    const out: number[] = [];
    let i = 0;
    while (i < data.length) {
        const length = data[i++];
        if (length === 128) { break; }
        if (length < 128) {
            for (let k = 0; k <= length && i < data.length; k++) { out.push(data[i++]); }
        } else {
            const byte = data[i++];
            for (let k = 0; k < 257 - length; k++) { out.push(byte); }
        }
        if (out.length > maxOutput) { break; }
    }
    return Buffer.from(out);
}

/** Predictor 2 = TIFF, 10-15 = PNG suzgecleri (ISO 32000-1, Tablo 10). */
function applyPredictor(data: Buffer, parms: PdfDict | undefined, resolve: (v: PdfValue) => PdfValue): Buffer {
    if (!parms) { return data; }
    const predictor = numberOf(resolve(parms.get('Predictor') ?? null)) ?? 1;
    if (predictor <= 1) { return data; }

    const colors = numberOf(resolve(parms.get('Colors') ?? null)) ?? 1;
    const bpc = numberOf(resolve(parms.get('BitsPerComponent') ?? null)) ?? 8;
    const columns = numberOf(resolve(parms.get('Columns') ?? null)) ?? 1;
    const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    const rowLength = Math.ceil((colors * bpc * columns) / 8);

    if (predictor === 2) { return tiffPredictor(data, colors, bpc, columns); }
    return pngPredictor(data, rowLength, bpp);
}

function pngPredictor(data: Buffer, rowLength: number, bpp: number): Buffer {
    const rows = Math.floor(data.length / (rowLength + 1));
    const out = Buffer.alloc(rows * rowLength);
    let previous = Buffer.alloc(rowLength);

    for (let r = 0; r < rows; r++) {
        const type = data[r * (rowLength + 1)];
        const src = data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1));
        const row = Buffer.from(src);
        for (let i = 0; i < rowLength; i++) {
            const left = i >= bpp ? row[i - bpp] : 0;
            const up = previous[i];
            const upLeft = i >= bpp ? previous[i - bpp] : 0;
            switch (type) {
                case 1: row[i] = (row[i] + left) & 0xff; break;
                case 2: row[i] = (row[i] + up) & 0xff; break;
                case 3: row[i] = (row[i] + ((left + up) >> 1)) & 0xff; break;
                case 4: row[i] = (row[i] + paeth(left, up, upLeft)) & 0xff; break;
                default: break;
            }
        }
        row.copy(out, r * rowLength);
        previous = row;
    }
    return out;
}

function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) { return a; }
    return pb <= pc ? b : c;
}

function tiffPredictor(data: Buffer, colors: number, bpc: number, columns: number): Buffer {
    if (bpc !== 8) { return data; }
    const rowLength = colors * columns;
    const out = Buffer.from(data);
    for (let r = 0; r + rowLength <= out.length; r += rowLength) {
        for (let i = colors; i < rowLength; i++) {
            out[r + i] = (out[r + i] + out[r + i - colors]) & 0xff;
        }
    }
    return out;
}
