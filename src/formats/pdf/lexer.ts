import { PdfName, PdfRef, PdfString, type PdfDict, type PdfStream, type PdfValue } from './objects';

/**
 * PDF sozdizimi cozumleyicisi (ISO 32000-1, 7.2-7.3).
 *
 * Bayt duzeyinde calisir; dizeler asla JS metnine cevrilmez (kodlama nesneye baglidir).
 */

const BACKSLASH = 92;

export function isWhite(c: number): boolean {
    return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
}

export function isDelimiter(c: number): boolean {
    return c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d
        || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
}

export function isRegular(c: number): boolean {
    return !isWhite(c) && !isDelimiter(c);
}

export class Lexer {
    pos: number;

    constructor(readonly buf: Buffer, start = 0) {
        this.pos = start;
    }

    /** Bosluk ve yorumlari atlar. */
    skipWhite(): void {
        while (this.pos < this.buf.length) {
            const c = this.buf[this.pos];
            if (isWhite(c)) { this.pos++; continue; }
            if (c === 0x25 /* % */) {
                while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) {
                    this.pos++;
                }
                continue;
            }
            return;
        }
    }

    atEnd(): boolean {
        this.skipWhite();
        return this.pos >= this.buf.length;
    }

    /** Sonraki duzenli (regular) karakter dizisini anahtar sozcuk olarak okur. */
    readKeyword(): string {
        this.skipWhite();
        const start = this.pos;
        while (this.pos < this.buf.length && isRegular(this.buf[this.pos])) { this.pos++; }
        if (this.pos === start) { this.pos++; return this.buf.toString('latin1', start, this.pos); }
        return this.buf.toString('latin1', start, this.pos);
    }

    peekKeyword(): string {
        const save = this.pos;
        const keyword = this.readKeyword();
        this.pos = save;
        return keyword;
    }
}

/** Uzunluk dolayli basvuru ise cozmek icin kullanilir. */
export type LengthResolver = (ref: PdfRef) => number | undefined;

export class Parser extends Lexer {
    constructor(buf: Buffer, start = 0, private readonly resolveLength?: LengthResolver) {
        super(buf, start);
    }

    /** Bir nesne okur. Dosya sonunda veya cozulemeyen simgede null doner. */
    parseValue(depth = 0): PdfValue {
        if (depth > 64) { return null; }
        this.skipWhite();
        if (this.pos >= this.buf.length) { return null; }
        const c = this.buf[this.pos];

        if (c === 0x2f /* / */) { return this.parseName(); }
        if (c === 0x28 /* ( */) { return this.parseLiteralString(); }
        if (c === 0x5b /* [ */) { return this.parseArray(depth); }
        if (c === 0x3c /* < */) {
            if (this.buf[this.pos + 1] === 0x3c) { return this.parseDictOrStream(depth); }
            return this.parseHexString();
        }
        if (c === 0x5d /* ] */ || c === 0x3e /* > */ || c === 0x7d /* } */) { this.pos++; return null; }

        if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) { return this.parseNumberOrRef(); }

        const keyword = this.readKeyword();
        if (keyword === 'true') { return true; }
        if (keyword === 'false') { return false; }
        if (keyword === 'null') { return null; }
        return null;
    }

    private parseName(): PdfName {
        this.pos++; // '/'
        let out = '';
        while (this.pos < this.buf.length && isRegular(this.buf[this.pos])) {
            const c = this.buf[this.pos];
            if (c === 0x23 /* # */ && this.pos + 2 < this.buf.length) {
                const hex = this.buf.toString('latin1', this.pos + 1, this.pos + 3);
                const code = parseInt(hex, 16);
                if (Number.isFinite(code)) { out += String.fromCharCode(code); this.pos += 3; continue; }
            }
            out += String.fromCharCode(c);
            this.pos++;
        }
        return new PdfName(out);
    }

    /** `12 0 R` bicimini ileri bakarak yakalar; degilse sayidir. */
    private parseNumberOrRef(): PdfValue {
        const first = this.readNumber();
        if (!Number.isInteger(first) || first < 0) { return first; }
        const save = this.pos;
        this.skipWhite();
        const genStart = this.pos;
        let sawDigit = false;
        while (this.pos < this.buf.length && this.buf[this.pos] >= 0x30 && this.buf[this.pos] <= 0x39) {
            this.pos++; sawDigit = true;
        }
        if (sawDigit) {
            const gen = Number(this.buf.toString('latin1', genStart, this.pos));
            this.skipWhite();
            if (this.buf[this.pos] === 0x52 /* R */ && !isRegular(this.buf[this.pos + 1] ?? 0x20)) {
                this.pos++;
                return new PdfRef(first, gen);
            }
        }
        this.pos = save;
        return first;
    }

    private readNumber(): number {
        this.skipWhite();
        const start = this.pos;
        while (this.pos < this.buf.length && isRegular(this.buf[this.pos])) { this.pos++; }
        const text = this.buf.toString('latin1', start, this.pos);
        const value = Number(text);
        if (Number.isFinite(value)) { return value; }
        // "--5" veya "3.4.5" gibi bozuk sayilar: bastaki gecerli kismi al.
        const match = /^[-+]?[0-9]*[.]?[0-9]*/.exec(text.replace(/^[-+]+/, (m) => m[m.length - 1]));
        const partial = match ? Number(match[0]) : NaN;
        return Number.isFinite(partial) ? partial : 0;
    }

    private parseArray(depth: number): PdfValue[] {
        this.pos++; // '['
        const out: PdfValue[] = [];
        while (this.pos < this.buf.length) {
            this.skipWhite();
            if (this.buf[this.pos] === 0x5d /* ] */) { this.pos++; break; }
            const before = this.pos;
            out.push(this.parseValue(depth + 1));
            if (this.pos === before) { this.pos++; }
            if (out.length > 200000) { break; }
        }
        return out;
    }

    private parseDictOrStream(depth: number): PdfDict | PdfStream {
        this.pos += 2; // '<<'
        const dict: PdfDict = new Map();
        while (this.pos < this.buf.length) {
            this.skipWhite();
            if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) { this.pos += 2; break; }
            if (this.buf[this.pos] !== 0x2f /* / */) {
                // Bozuk anahtar: degeri atlayip devam etmeye calis.
                const before = this.pos;
                this.parseValue(depth + 1);
                if (this.pos === before) { this.pos++; }
                continue;
            }
            const key = this.parseName().name;
            const value = this.parseValue(depth + 1);
            dict.set(key, value);
        }

        const save = this.pos;
        this.skipWhite();
        if (this.buf.toString('latin1', this.pos, this.pos + 6) === 'stream') {
            this.pos += 6;
            if (this.buf[this.pos] === 0x0d) { this.pos++; }
            if (this.buf[this.pos] === 0x0a) { this.pos++; }
            return this.readStream(dict);
        }
        this.pos = save;
        return dict;
    }

    /** Akis govdesini okur. /Length guvenilmezse `endstream` aranarak duzeltilir. */
    private readStream(dict: PdfDict): PdfStream {
        const start = this.pos;
        const lengthValue = dict.get('Length');
        let length: number | undefined;
        if (typeof lengthValue === 'number') { length = lengthValue; }
        else if (lengthValue instanceof PdfRef) { length = this.resolveLength?.(lengthValue); }

        let end = length !== undefined && length >= 0 && start + length <= this.buf.length
            ? start + length
            : -1;

        if (end < 0 || !this.looksLikeEndstream(end)) {
            const found = this.buf.indexOf('endstream', start, 'latin1');
            end = found < 0 ? this.buf.length : trimEol(this.buf, start, found);
        }

        const raw = this.buf.subarray(start, end);
        this.pos = end;
        const marker = this.buf.indexOf('endstream', this.pos, 'latin1');
        this.pos = marker < 0 ? this.buf.length : marker + 9;
        return { dict, raw };
    }

    /** /Length dogru mu: hemen ardindan (bosluklardan sonra) `endstream` gelmeli. */
    private looksLikeEndstream(end: number): boolean {
        let i = end;
        let guard = 0;
        while (i < this.buf.length && isWhite(this.buf[i]) && guard++ < 4) { i++; }
        return this.buf.toString('latin1', i, i + 9) === 'endstream';
    }

    /** `( ... )` bicimi dize. Dengeli parantez ve ters bolu kacislari desteklenir. */
    private parseLiteralString(): PdfString {
        this.pos++; // '('
        const out: number[] = [];
        let depth = 1;
        while (this.pos < this.buf.length) {
            const c = this.buf[this.pos++];
            if (c === BACKSLASH) {
                const next = this.buf[this.pos++];
                switch (next) {
                    case 0x6e: out.push(0x0a); break; // n
                    case 0x72: out.push(0x0d); break; // r
                    case 0x74: out.push(0x09); break; // t
                    case 0x62: out.push(0x08); break; // b
                    case 0x66: out.push(0x0c); break; // f
                    case 0x0a: break;                 // satir devami
                    case 0x0d: if (this.buf[this.pos] === 0x0a) { this.pos++; } break;
                    default:
                        if (next >= 0x30 && next <= 0x37) {
                            let code = next - 0x30;
                            for (let k = 0; k < 2; k++) {
                                const digit = this.buf[this.pos];
                                if (digit >= 0x30 && digit <= 0x37) { code = code * 8 + (digit - 0x30); this.pos++; }
                                else { break; }
                            }
                            out.push(code & 0xff);
                        } else if (next !== undefined) {
                            out.push(next);
                        }
                }
                continue;
            }
            if (c === 0x28) { depth++; out.push(c); continue; }
            if (c === 0x29) { depth--; if (depth === 0) { break; } out.push(c); continue; }
            out.push(c);
        }
        return new PdfString(Buffer.from(out));
    }

    /** `< ... >` bicimi onaltilik dize. Tek kalan basamak sifirla tamamlanir. */
    private parseHexString(): PdfString {
        this.pos++; // '<'
        const out: number[] = [];
        let high = -1;
        while (this.pos < this.buf.length) {
            const c = this.buf[this.pos++];
            if (c === 0x3e /* > */) { break; }
            const digit = hexValue(c);
            if (digit < 0) { continue; }
            if (high < 0) { high = digit; } else { out.push(high * 16 + digit); high = -1; }
        }
        if (high >= 0) { out.push(high * 16); }
        return new PdfString(Buffer.from(out));
    }
}

function hexValue(c: number): number {
    if (c >= 0x30 && c <= 0x39) { return c - 0x30; }
    if (c >= 0x41 && c <= 0x46) { return c - 0x37; }
    if (c >= 0x61 && c <= 0x66) { return c - 0x57; }
    return -1;
}

/** `endstream` oncesindeki tek satir sonunu akis govdesinden dislar. */
function trimEol(buf: Buffer, start: number, end: number): number {
    let stop = end;
    if (stop > start && buf[stop - 1] === 0x0a) { stop--; }
    if (stop > start && buf[stop - 1] === 0x0d) { stop--; }
    return stop;
}
