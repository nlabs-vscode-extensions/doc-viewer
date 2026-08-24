/** PDF nesne modeli (ISO 32000-1, 7.3). */

export class PdfName {
    constructor(readonly name: string) {}
    toString(): string { return `/${this.name}`; }
}

export class PdfRef {
    constructor(readonly num: number, readonly gen: number) {}
    get key(): string { return `${this.num}_${this.gen}`; }
}

/** PDF dizeleri bayt dizisidir; metne cevirme kodlamaya baglidir. */
export class PdfString {
    constructor(readonly bytes: Buffer) {}
}

export type PdfDict = Map<string, PdfValue>;

export interface PdfStream {
    dict: PdfDict;
    /** Cozulmemis ham veri. */
    raw: Buffer;
}

export type PdfValue =
    | null
    | boolean
    | number
    | PdfName
    | PdfRef
    | PdfString
    | PdfValue[]
    | PdfDict
    | PdfStream;

export function isDict(value: PdfValue): value is PdfDict {
    return value instanceof Map;
}

export function isStream(value: PdfValue): value is PdfStream {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        && !(value instanceof Map) && 'dict' in (value as object) && 'raw' in (value as object);
}

export function isName(value: PdfValue, name?: string): value is PdfName {
    return value instanceof PdfName && (name === undefined || value.name === name);
}

export function nameOf(value: PdfValue): string | undefined {
    return value instanceof PdfName ? value.name : undefined;
}

export function numberOf(value: PdfValue): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function arrayOf(value: PdfValue): PdfValue[] {
    return Array.isArray(value) ? value : [];
}

/** Nesnenin sozlugu; akislarda akisin sozlugu doner. */
export function dictOf(value: PdfValue): PdfDict | undefined {
    if (isDict(value)) { return value; }
    if (isStream(value)) { return value.dict; }
    return undefined;
}

/**
 * PDF metin dizesini JavaScript metnine cevirir.
 * UTF-16BE BOM'u varsa ona gore, yoksa PDFDocEncoding (latin1 yaklasimi) ile.
 */
export function decodePdfString(value: PdfString): string {
    const bytes = value.bytes;
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        const body = bytes.subarray(2);
        const even = body.length % 2 === 0 ? body : body.subarray(0, body.length - 1);
        return Buffer.from(even).swap16().toString('utf16le');
    }
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return bytes.subarray(3).toString('utf8');
    }
    return bytes.toString('latin1');
}
