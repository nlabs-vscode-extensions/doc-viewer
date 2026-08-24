import type { PdfDocument } from './document';
import { arrayOf, isStream, nameOf, numberOf, type PdfStream, type PdfValue } from './objects';
import { encodePng, PNG_GRAY, PNG_RGB, PNG_RGBA, type PngColorType } from '../../core/png';

/**
 * Gorsel XObject -> gosterilebilir bayt dizisi.
 *
 * JPEG (DCTDecode) oldugu gibi gecirilir. Ham ornekler PNG'ye kodlanir.
 * JPEG2000, CCITT ve JBIG2 COZULMEZ - kendi goruntu kod cozucumuzu yazmak
 * bagimliligi degil, saldiri yuzeyini geri getirirdi.
 */

const MAX_PIXELS = 60_000_000;

export interface ExtractedImage {
    mime: string;
    data: Buffer;
    width: number;
    height: number;
}

export interface ExtractionFailure {
    reason: string;
}

export function extractImage(doc: PdfDocument, stream: PdfStream): ExtractedImage | ExtractionFailure {
    const dict = stream.dict;
    const width = Math.round(numberOf(doc.resolve(dict.get('Width') ?? dict.get('W') ?? null)) ?? 0);
    const height = Math.round(numberOf(doc.resolve(dict.get('Height') ?? dict.get('H') ?? null)) ?? 0);
    if (width <= 0 || height <= 0) { return { reason: 'gecersiz boyut' }; }
    if (width * height > MAX_PIXELS) { return { reason: 'cok buyuk gorsel' }; }

    const decoded = doc.decode(stream);
    if (decoded.imageFilter === 'DCTDecode' || decoded.imageFilter === 'DCT') {
        return { mime: 'image/jpeg', data: decoded.data, width, height };
    }
    if (decoded.imageFilter) {
        return { reason: `${decoded.imageFilter} destegi yok` };
    }
    if (decoded.error || decoded.data.length === 0) {
        return { reason: decoded.error ?? 'akis bos' };
    }

    const bpc = Math.round(numberOf(doc.resolve(dict.get('BitsPerComponent') ?? dict.get('BPC') ?? null)) ?? 8);
    const isMask = doc.resolve(dict.get('ImageMask') ?? dict.get('IM') ?? null) === true;
    const decodeArray = arrayOf(doc.resolve(dict.get('Decode') ?? dict.get('D') ?? null))
        .map((v) => numberOf(doc.resolve(v)) ?? 0);

    if (isMask) {
        return maskToPng(decoded.data, width, height, decodeArray);
    }

    const space = resolveColorSpace(doc, doc.resolve(dict.get('ColorSpace') ?? dict.get('CS') ?? null));
    if (!space) { return { reason: 'desteklenmeyen renk uzayi' }; }

    try {
        const rgb = samplesToRgb(decoded.data, width, height, bpc, space, decodeArray);
        const alpha = readSoftMask(doc, dict.get('SMask') ?? null, width, height);
        if (alpha) {
            const rgba = Buffer.alloc(width * height * 4);
            for (let i = 0, p = 0; i < width * height; i++) {
                rgba[p++] = rgb[i * 3];
                rgba[p++] = rgb[i * 3 + 1];
                rgba[p++] = rgb[i * 3 + 2];
                rgba[p++] = alpha[i];
            }
            return { mime: 'image/png', data: encodePng(rgba, width, height, PNG_RGBA), width, height };
        }
        return { mime: 'image/png', data: encodePng(rgb, width, height, PNG_RGB), width, height };
    } catch (err) {
        return { reason: (err as Error).message };
    }
}

interface ColorSpace {
    components: number;
    kind: 'gray' | 'rgb' | 'cmyk' | 'indexed';
    /** Indexed icin: taban uzay ve arama tablosu. */
    base?: ColorSpace;
    lookup?: Buffer;
}

function resolveColorSpace(doc: PdfDocument, value: PdfValue, depth = 0): ColorSpace | undefined {
    if (depth > 8) { return undefined; }
    const name = nameOf(value);
    if (name) { return byName(name); }

    const list = arrayOf(value);
    if (list.length === 0) { return undefined; }
    const family = nameOf(doc.resolve(list[0]));

    switch (family) {
        case 'ICCBased': {
            const streamValue = doc.resolve(list[1]);
            const n = isStream(streamValue)
                ? numberOf(doc.resolve(streamValue.dict.get('N') ?? null)) ?? 3
                : 3;
            return n === 1 ? { components: 1, kind: 'gray' }
                : n === 4 ? { components: 4, kind: 'cmyk' }
                    : { components: 3, kind: 'rgb' };
        }
        case 'Indexed':
        case 'I': {
            const base = resolveColorSpace(doc, doc.resolve(list[1]), depth + 1) ?? { components: 3, kind: 'rgb' };
            const lookupValue = doc.resolve(list[3]);
            let lookup: Buffer | undefined;
            if (isStream(lookupValue)) {
                const decoded = doc.decode(lookupValue);
                if (!decoded.error) { lookup = decoded.data; }
            } else if (lookupValue && typeof lookupValue === 'object' && 'bytes' in lookupValue) {
                lookup = (lookupValue as { bytes: Buffer }).bytes;
            }
            return lookup ? { components: 1, kind: 'indexed', base, lookup } : undefined;
        }
        case 'CalRGB': return { components: 3, kind: 'rgb' };
        case 'CalGray': return { components: 1, kind: 'gray' };
        case 'Lab': return { components: 3, kind: 'rgb' };
        case 'Separation': return { components: 1, kind: 'gray' };
        case 'DeviceN': {
            const names = arrayOf(doc.resolve(list[1]));
            return { components: Math.max(1, names.length), kind: 'gray' };
        }
        case 'DeviceGray': return { components: 1, kind: 'gray' };
        case 'DeviceRGB': return { components: 3, kind: 'rgb' };
        case 'DeviceCMYK': return { components: 4, kind: 'cmyk' };
        default: return undefined;
    }
}

function byName(name: string): ColorSpace | undefined {
    switch (name) {
        case 'DeviceGray': case 'G': case 'CalGray': return { components: 1, kind: 'gray' };
        case 'DeviceRGB': case 'RGB': case 'CalRGB': return { components: 3, kind: 'rgb' };
        case 'DeviceCMYK': case 'CMYK': return { components: 4, kind: 'cmyk' };
        default: return undefined;
    }
}

/** Bit paketli ornekleri acar ve RGB uclusune cevirir. */
function samplesToRgb(
    data: Buffer, width: number, height: number, bpc: number, space: ColorSpace, decode: number[]
): Buffer {
    const components = space.components;
    const maxValue = (1 << bpc) - 1;
    const rowBits = width * components * bpc;
    const rowBytes = Math.ceil(rowBits / 8);
    if (data.length < rowBytes * height) {
        // Kesik akis: eksik satirlar beyaz kalir.
        const padded = Buffer.alloc(rowBytes * height, 0xff);
        data.copy(padded);
        data = padded;
    }

    const out = Buffer.alloc(width * height * 3);
    const sample = new Array<number>(components);
    const inverted = decode.length >= 2 && decode[0] > decode[1];

    for (let y = 0; y < height; y++) {
        let bitPos = y * rowBytes * 8;
        for (let x = 0; x < width; x++) {
            for (let c = 0; c < components; c++) {
                let value = readBits(data, bitPos, bpc);
                bitPos += bpc;
                if (inverted && space.kind !== 'indexed') { value = maxValue - value; }
                sample[c] = value;
            }
            const target = (y * width + x) * 3;
            writeRgb(out, target, sample, space, bpc, maxValue);
        }
    }
    return out;
}

function writeRgb(
    out: Buffer, target: number, sample: number[], space: ColorSpace, bpc: number, maxValue: number
): void {
    const scale = (v: number) => Math.round((v / maxValue) * 255);
    switch (space.kind) {
        case 'gray': {
            const g = scale(sample[0]);
            out[target] = g; out[target + 1] = g; out[target + 2] = g;
            return;
        }
        case 'rgb':
            out[target] = scale(sample[0]);
            out[target + 1] = scale(sample[1]);
            out[target + 2] = scale(sample[2]);
            return;
        case 'cmyk': {
            const k = sample[3] / maxValue;
            out[target] = Math.round(255 * (1 - Math.min(1, sample[0] / maxValue + k)));
            out[target + 1] = Math.round(255 * (1 - Math.min(1, sample[1] / maxValue + k)));
            out[target + 2] = Math.round(255 * (1 - Math.min(1, sample[2] / maxValue + k)));
            return;
        }
        case 'indexed': {
            const base = space.base ?? { components: 3, kind: 'rgb' as const };
            const lookup = space.lookup ?? Buffer.alloc(0);
            const index = sample[0] * base.components;
            const values = new Array<number>(base.components);
            for (let c = 0; c < base.components; c++) { values[c] = lookup[index + c] ?? 0; }
            writeRgb(out, target, values, base, bpc, 255);
            return;
        }
    }
}

function readBits(data: Buffer, bitPos: number, bits: number): number {
    if (bits === 8) { return data[bitPos >> 3] ?? 0; }
    if (bits === 16) {
        const byte = bitPos >> 3;
        return ((data[byte] ?? 0) << 8 | (data[byte + 1] ?? 0)) >> 8;
    }
    let value = 0;
    for (let i = 0; i < bits; i++) {
        const bit = bitPos + i;
        const byte = data[bit >> 3] ?? 0;
        value = (value << 1) | ((byte >> (7 - (bit & 7))) & 1);
    }
    return value;
}

/** Stencil maske (1 bit): boyanan pikseller siyah, digerleri saydam. */
function maskToPng(data: Buffer, width: number, height: number, decode: number[]): ExtractedImage {
    const rowBytes = Math.ceil(width / 8);
    const paintOnZero = !(decode.length >= 2 && decode[0] === 1);
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const byte = data[y * rowBytes + (x >> 3)] ?? 0xff;
            const bit = (byte >> (7 - (x & 7))) & 1;
            const painted = paintOnZero ? bit === 0 : bit === 1;
            const target = (y * width + x) * 4;
            rgba[target + 3] = painted ? 255 : 0;
        }
    }
    return { mime: 'image/png', data: encodePng(rgba, width, height, PNG_RGBA), width, height };
}

/** /SMask akisini alfa kanalina cevirir; boyut farkliysa en yakin komsu ile olceklenir. */
function readSoftMask(doc: PdfDocument, value: PdfValue, width: number, height: number): Buffer | undefined {
    const mask = doc.resolve(value);
    if (!isStream(mask)) { return undefined; }

    const maskWidth = Math.round(numberOf(doc.resolve(mask.dict.get('Width') ?? null)) ?? 0);
    const maskHeight = Math.round(numberOf(doc.resolve(mask.dict.get('Height') ?? null)) ?? 0);
    if (maskWidth <= 0 || maskHeight <= 0 || maskWidth * maskHeight > MAX_PIXELS) { return undefined; }

    const decoded = doc.decode(mask);
    if (decoded.imageFilter || decoded.error || decoded.data.length === 0) { return undefined; }

    const bpc = Math.round(numberOf(doc.resolve(mask.dict.get('BitsPerComponent') ?? null)) ?? 8);
    const maxValue = (1 << bpc) - 1;
    const rowBytes = Math.ceil((maskWidth * bpc) / 8);

    const out = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
        const sourceY = Math.min(maskHeight - 1, Math.floor((y * maskHeight) / height));
        for (let x = 0; x < width; x++) {
            const sourceX = Math.min(maskWidth - 1, Math.floor((x * maskWidth) / width));
            const value = readBits(decoded.data, sourceY * rowBytes * 8 + sourceX * bpc, bpc);
            out[y * width + x] = Math.round((value / maxValue) * 255);
        }
    }
    return out;
}

export { PNG_GRAY };
export type { PngColorType };
