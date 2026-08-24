import { Parser } from './lexer';
import { decodeStream } from './filters';
import {
    PdfName, PdfRef, PdfString, arrayOf, dictOf, isDict, isStream, nameOf, numberOf,
    type PdfDict, type PdfStream, type PdfValue,
} from './objects';
import { DocumentError } from '../../core/types';

/**
 * PDF nesne deposu.
 *
 * Cizelge (xref) tablosuna guvenmek yerine dosyanin tamami taranarak
 * `N G obj` basliklari bulunur. Gercek dunyadaki PDF'lerin buyuk bolumu artimli
 * guncelleme, yanlis ofset veya kesik xref tasir; tarama bunlarin hepsinde calisir.
 * Sikistirilmis nesneler (/Type /ObjStm) ayrica acilir.
 */

const MAX_STREAM_OUTPUT = 256 * 1024 * 1024;

interface ObjectSlot {
    offset: number;
    value?: PdfValue;
    parsing?: boolean;
}

export class PdfDocument {
    private readonly slots = new Map<number, ObjectSlot>();
    private readonly sortedOffsets: { offset: number; num: number }[] = [];
    readonly warnings: string[] = [];
    private trailerDicts: PdfDict[] = [];

    private constructor(readonly buf: Buffer) {}

    static open(buf: Buffer): PdfDocument {
        const header = buf.toString('latin1', 0, Math.min(1024, buf.length));
        if (!header.includes('%PDF-')) {
            throw new DocumentError('Bu dosya bir PDF degil (%PDF- imzasi yok).');
        }
        const doc = new PdfDocument(buf);
        doc.scanObjects();
        doc.collectTrailers();
        doc.expandObjectStreams();
        return doc;
    }

    /** Dolayli basvurulari cozer; zincir kirilirsa null doner. */
    resolve(value: PdfValue, depth = 0): PdfValue {
        if (!(value instanceof PdfRef) || depth > 32) { return value instanceof PdfRef ? null : value; }
        return this.resolve(this.getObject(value.num), depth + 1);
    }

    getObject(num: number): PdfValue {
        const slot = this.slots.get(num);
        if (!slot) { return null; }
        if (slot.value !== undefined) { return slot.value; }
        if (slot.parsing) { return null; }
        slot.parsing = true;
        try {
            slot.value = this.parseAt(slot.offset);
        } catch {
            slot.value = null;
        } finally {
            slot.parsing = false;
        }
        return slot.value ?? null;
    }

    /** Akisi cozer; goruntu filtresinde ham veriyi ve filtre adini birlikte doner. */
    decode(stream: PdfStream): { data: Buffer; imageFilter?: string; error?: string } {
        return decodeStream(stream, (v) => this.resolve(v), MAX_STREAM_OUTPUT);
    }

    private parseAt(offset: number): PdfValue {
        const parser = new Parser(this.buf, offset, (ref) => {
            const value = this.resolve(ref);
            return typeof value === 'number' ? value : undefined;
        });
        parser.readKeyword(); // nesne numarasi
        parser.readKeyword(); // surum
        const keyword = parser.readKeyword();
        if (keyword !== 'obj') { return null; }
        return parser.parseValue();
    }

    /** Dosyayi tarayarak tum `N G obj` basliklarini bulur. Sonraki tanim oncekini ezer. */
    private scanObjects(): void {
        const buf = this.buf;
        let pos = 0;
        while (pos < buf.length) {
            const found = buf.indexOf('obj', pos, 'latin1');
            if (found < 0) { break; }
            pos = found + 3;
            // 'obj' bir sozcuk olmali (or. 'endobj' degil).
            const after = buf[found + 3];
            if (after !== undefined && !isTokenBreak(after)) { continue; }
            const header = readObjectHeader(buf, found);
            if (header) {
                this.slots.set(header.num, { offset: header.start });
            }
        }
        for (const [num, slot] of this.slots) {
            this.sortedOffsets.push({ offset: slot.offset, num });
        }
        this.sortedOffsets.sort((a, b) => a.offset - b.offset);
        if (this.slots.size === 0) {
            throw new DocumentError('PDF icinde nesne bulunamadi - dosya bozuk olabilir.');
        }
    }

    /** `trailer` sozlukleri ve xref akislarinin sozlukleri (Root/Info/Encrypt icin). */
    private collectTrailers(): void {
        let pos = 0;
        while (pos < this.buf.length) {
            const found = this.buf.indexOf('trailer', pos, 'latin1');
            if (found < 0) { break; }
            pos = found + 7;
            const parser = new Parser(this.buf, pos);
            const value = parser.parseValue();
            if (isDict(value)) { this.trailerDicts.push(value); }
        }
        // Capraz basvuru akislari (PDF 1.5+) trailer anahtar sozcugu kullanmaz.
        for (const { num } of this.sortedOffsets) {
            const value = this.getObject(num);
            const dict = dictOf(value);
            if (dict && nameOf(this.resolve(dict.get('Type') ?? null)) === 'XRef') {
                this.trailerDicts.push(dict);
            }
        }
    }

    /** Sikistirilmis nesne akislarini (/Type /ObjStm) acar. */
    private expandObjectStreams(): void {
        const streamNums: number[] = [];
        for (const { num } of this.sortedOffsets) {
            const value = this.getObject(num);
            if (isStream(value) && nameOf(this.resolve(value.dict.get('Type') ?? null)) === 'ObjStm') {
                streamNums.push(num);
            }
        }
        for (const num of streamNums) {
            const stream = this.getObject(num);
            if (!isStream(stream)) { continue; }
            try {
                this.expandObjectStream(stream);
            } catch (err) {
                this.warnings.push(`Nesne akisi acilamadi (${num}): ${(err as Error).message}`);
            }
        }
    }

    private expandObjectStream(stream: PdfStream): void {
        const count = numberOf(this.resolve(stream.dict.get('N') ?? null)) ?? 0;
        const first = numberOf(this.resolve(stream.dict.get('First') ?? null)) ?? 0;
        if (count <= 0 || count > 100000) { return; }

        const decoded = this.decode(stream);
        if (decoded.error || decoded.data.length === 0) { return; }

        const header = new Parser(decoded.data, 0);
        const entries: { num: number; offset: number }[] = [];
        for (let i = 0; i < count; i++) {
            const num = Number(header.readKeyword());
            const offset = Number(header.readKeyword());
            if (!Number.isFinite(num) || !Number.isFinite(offset)) { break; }
            entries.push({ num, offset });
        }

        for (const entry of entries) {
            // Dosyada dogrudan tanimli nesne varsa o kazanir (artimli guncelleme).
            if (this.slots.has(entry.num)) { continue; }
            const start = first + entry.offset;
            if (start < 0 || start >= decoded.data.length) { continue; }
            const parser = new Parser(decoded.data, start);
            this.slots.set(entry.num, { offset: -1, value: parser.parseValue() });
        }
    }

    /** Sifreleme sozlugu (varsa). Sifreli belgeler v1'de acilmaz. */
    encryptDict(): PdfDict | undefined {
        for (let i = this.trailerDicts.length - 1; i >= 0; i--) {
            const encrypt = this.trailerDicts[i].get('Encrypt');
            if (encrypt) {
                const dict = dictOf(this.resolve(encrypt));
                if (dict) { return dict; }
            }
        }
        return undefined;
    }

    infoDict(): PdfDict | undefined {
        for (let i = this.trailerDicts.length - 1; i >= 0; i--) {
            const info = this.trailerDicts[i].get('Info');
            if (info) {
                const dict = dictOf(this.resolve(info));
                if (dict) { return dict; }
            }
        }
        return undefined;
    }

    catalog(): PdfDict | undefined {
        for (let i = this.trailerDicts.length - 1; i >= 0; i--) {
            const root = this.trailerDicts[i].get('Root');
            if (root) {
                const dict = dictOf(this.resolve(root));
                if (dict && dict.has('Pages')) { return dict; }
            }
        }
        // Trailer yoksa veya bozuksa: /Type /Catalog tasiyan nesneyi ara.
        for (const [num] of this.slots) {
            const dict = dictOf(this.getObject(num));
            if (dict && nameOf(this.resolve(dict.get('Type') ?? null)) === 'Catalog') { return dict; }
        }
        return undefined;
    }

    /**
     * Sayfa agacini duzlestirir. /Resources, /MediaBox, /CropBox ve /Rotate
     * ust dugumlerden miras alinir (ISO 32000-1, 7.7.3.4).
     */
    pages(): PdfDict[] {
        const catalog = this.catalog();
        const rootPages = dictOf(this.resolve(catalog?.get('Pages') ?? null));
        const out: PdfDict[] = [];
        const seen = new Set<PdfDict>();

        const walk = (node: PdfDict | undefined, inherited: PdfDict, depth: number): void => {
            if (!node || depth > 64 || seen.has(node) || out.length > 20000) { return; }
            seen.add(node);

            const merged: PdfDict = new Map(inherited);
            for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
                const value = node.get(key);
                if (value !== undefined) { merged.set(key, value); }
            }

            const type = nameOf(this.resolve(node.get('Type') ?? null));
            const kids = arrayOf(this.resolve(node.get('Kids') ?? null));
            if (type === 'Page' || (kids.length === 0 && node.has('Contents'))) {
                const page: PdfDict = new Map(merged);
                for (const [key, value] of node) { page.set(key, value); }
                out.push(page);
                return;
            }
            for (const kid of kids) {
                walk(dictOf(this.resolve(kid)), merged, depth + 1);
            }
        };

        walk(rootPages, new Map(), 0);
        if (out.length === 0) {
            // Sayfa agaci bozuk: dogrudan /Type /Page nesnelerini topla.
            for (const [num] of this.slots) {
                const dict = dictOf(this.getObject(num));
                if (dict && nameOf(this.resolve(dict.get('Type') ?? null)) === 'Page') { out.push(dict); }
            }
            if (out.length > 0) { this.warnings.push('Sayfa agaci bozuk; sayfalar dogrudan tarandi (sira degismis olabilir).'); }
        }
        return out;
    }
}

function isTokenBreak(c: number): boolean {
    return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00
        || c === 0x3c || c === 0x5b || c === 0x2f || c === 0x28 || c === 0x25;
}

/** `obj` anahtar sozcugunden geriye dogru `N G` sayilarini okur. */
function readObjectHeader(buf: Buffer, objIndex: number): { num: number; start: number } | undefined {
    let i = objIndex - 1;
    const skipSpace = () => { while (i >= 0 && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09)) { i--; } };
    const readDigits = () => {
        const end = i;
        while (i >= 0 && buf[i] >= 0x30 && buf[i] <= 0x39) { i--; }
        return end === i ? undefined : buf.toString('latin1', i + 1, end + 1);
    };

    skipSpace();
    const gen = readDigits();
    if (gen === undefined) { return undefined; }
    skipSpace();
    const num = readDigits();
    if (num === undefined) { return undefined; }

    const value = Number(num);
    if (!Number.isFinite(value) || value < 0) { return undefined; }
    return { num: value, start: i + 1 };
}

/** PDF tarih dizesi (`D:YYYYMMDDHHmmSS`) -> okunabilir metin. */
export function formatPdfDate(value: PdfValue): string | undefined {
    if (!(value instanceof PdfString)) { return undefined; }
    const raw = value.bytes.toString('latin1').trim();
    const match = /^D?:?([0-9]{4})([0-9]{2})?([0-9]{2})?([0-9]{2})?([0-9]{2})?/.exec(raw);
    if (!match) { return raw || undefined; }
    const [, year, month, day, hour, minute] = match;
    if (!month) { return year; }
    const date = `${year}-${month}-${day ?? '01'}`;
    return hour ? `${date} ${hour}:${minute ?? '00'}` : date;
}

/** Sayfa sinir kutusu -> {width, height}, /Rotate uygulanmis. */
export function pageSize(doc: PdfDocument, page: PdfDict): { width: number; height: number; rotate: number } {
    const box = arrayOf(doc.resolve(page.get('CropBox') ?? page.get('MediaBox') ?? null))
        .map((v) => numberOf(doc.resolve(v)) ?? 0);
    let width = 612;
    let height = 792;
    if (box.length === 4) {
        width = Math.abs(box[2] - box[0]) || 612;
        height = Math.abs(box[3] - box[1]) || 792;
    }
    let rotate = ((numberOf(doc.resolve(page.get('Rotate') ?? null)) ?? 0) % 360 + 360) % 360;
    rotate = Math.round(rotate / 90) * 90 % 360;
    if (rotate === 90 || rotate === 270) { return { width: height, height: width, rotate }; }
    return { width, height, rotate };
}

/** Sayfanin icerik akislarini tek bir tampona birlestirir. */
export function pageContent(doc: PdfDocument, page: PdfDict): Buffer {
    const contents = doc.resolve(page.get('Contents') ?? null);
    const streams: PdfStream[] = [];
    if (isStream(contents)) { streams.push(contents); }
    else {
        for (const item of arrayOf(contents)) {
            const resolved = doc.resolve(item);
            if (isStream(resolved)) { streams.push(resolved); }
        }
    }
    const parts: Buffer[] = [];
    for (const stream of streams) {
        const decoded = doc.decode(stream);
        if (decoded.data.length) { parts.push(decoded.data, Buffer.from('\n')); }
    }
    return parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
}

export { PdfName, PdfRef };
