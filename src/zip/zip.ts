import * as zlib from 'node:zlib';
import { DocumentError } from '../core/types';

/**
 * Bagimliliksiz ZIP okuyucu (OOXML kapsayicilari icin).
 *
 * Yalnizca ihtiyac duyulan kadari desteklenir: merkezi dizin, ZIP64 uzantisi,
 * "stored" (0) ve "deflate" (8) yontemleri. Sifreli girdiler reddedilir.
 *
 * Guvenlik: girdi adlarinda yol kacisi (path traversal) engellenir, acilmis
 * toplam boyut ve girdi basina sikistirma orani sinirlanir (zip bomb).
 */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const FLAG_ENCRYPTED = 0x0001;

const MAX_ENTRIES = 20000;
const BACKSLASH = String.fromCharCode(92);

export interface ZipLimits {
    /** Acilmis toplam bayt ust siniri. */
    maxTotalUncompressed: number;
    /** Girdi basina acilmis/sikistirilmis oran ust siniri. */
    maxRatio: number;
}

export interface ZipEntry {
    name: string;
    compressedSize: number;
    uncompressedSize: number;
    method: number;
    crc32: number;
    localHeaderOffset: number;
    isDirectory: boolean;
}

export class ZipArchive {
    private readonly entries = new Map<string, ZipEntry>();
    private consumed = 0;

    private constructor(private readonly buf: Buffer, private readonly limits: ZipLimits) {}

    static open(buf: Buffer, limits: ZipLimits): ZipArchive {
        const archive = new ZipArchive(buf, limits);
        archive.readCentralDirectory();
        return archive;
    }

    /** Arsivdeki girdi adlari (dizinler haric). */
    names(): string[] {
        return [...this.entries.keys()];
    }

    has(name: string): boolean {
        return this.entries.has(name);
    }

    entry(name: string): ZipEntry | undefined {
        return this.entries.get(name);
    }

    /** Girdiyi acar. Yoksa undefined doner. */
    read(name: string): Buffer | undefined {
        const entry = this.entries.get(name);
        return entry ? this.readEntry(entry) : undefined;
    }

    readText(name: string): string | undefined {
        const buf = this.read(name);
        if (!buf) { return undefined; }
        // OOXML parcalari UTF-8'dir; BOM varsa duselim.
        if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
            return buf.subarray(3).toString('utf8');
        }
        return buf.toString('utf8');
    }

    private readEntry(entry: ZipEntry): Buffer {
        if (entry.isDirectory) { return Buffer.alloc(0); }

        const local = entry.localHeaderOffset;
        if (local + 30 > this.buf.length || this.buf.readUInt32LE(local) !== SIG_LOCAL) {
            throw new DocumentError(`ZIP: bozuk yerel baslik (${entry.name})`);
        }
        const nameLen = this.buf.readUInt16LE(local + 26);
        const extraLen = this.buf.readUInt16LE(local + 28);
        const start = local + 30 + nameLen + extraLen;
        const end = start + entry.compressedSize;
        if (end > this.buf.length) {
            throw new DocumentError(`ZIP: girdi dosya sinirini asiyor (${entry.name})`);
        }

        // Zip bomb korumasi: bu girdi acildiginda kalan butceyi asamaz.
        const budget = this.limits.maxTotalUncompressed - this.consumed;
        if (entry.uncompressedSize > budget) {
            throw new DocumentError(
                'ZIP: acilmis toplam boyut siniri asildi (zip bomb korumasi). ' +
                'nlabsDoc.zip.maxUncompressedMb ayarini yukseltebilirsiniz.'
            );
        }
        if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > this.limits.maxRatio) {
            throw new DocumentError(
                `ZIP: sikistirma orani siniri asildi (${entry.name}). ` +
                'nlabsDoc.zip.maxCompressionRatio ayarini yukseltebilirsiniz.'
            );
        }

        const raw = this.buf.subarray(start, end);
        let out: Buffer;
        if (entry.method === METHOD_STORE) {
            out = Buffer.from(raw);
        } else if (entry.method === METHOD_DEFLATE) {
            // maxOutputLength ikinci bir bariyerdir: merkezi dizindeki boyut yalan soylerse
            // zlib kendisi durdurur.
            out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, budget) });
        } else {
            throw new DocumentError(`ZIP: desteklenmeyen sikistirma yontemi (${entry.method})`);
        }

        this.consumed += out.length;
        return out;
    }

    private readCentralDirectory(): void {
        const eocd = this.findEocd();
        let entryCount = this.buf.readUInt16LE(eocd + 10);
        let cdSize = this.buf.readUInt32LE(eocd + 12);
        let cdOffset = this.buf.readUInt32LE(eocd + 16);

        // ZIP64: alanlar 0xFFFF/0xFFFFFFFF ise gercek degerler ZIP64 kayidindadir.
        if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
            const z64 = this.findZip64Eocd(eocd);
            if (z64 !== undefined) {
                entryCount = readU64(this.buf, z64 + 32);
                cdSize = readU64(this.buf, z64 + 40);
                cdOffset = readU64(this.buf, z64 + 48);
            }
        }

        if (entryCount > MAX_ENTRIES) {
            throw new DocumentError(`ZIP: girdi sayisi cok yuksek (${entryCount}).`);
        }
        if (cdOffset + cdSize > this.buf.length) {
            throw new DocumentError('ZIP: merkezi dizin dosya sinirini asiyor.');
        }

        let pos = cdOffset;
        for (let i = 0; i < entryCount; i++) {
            if (pos + 46 > this.buf.length || this.buf.readUInt32LE(pos) !== SIG_CENTRAL) {
                throw new DocumentError('ZIP: bozuk merkezi dizin kaydi.');
            }
            const flags = this.buf.readUInt16LE(pos + 8);
            if ((flags & FLAG_ENCRYPTED) !== 0) {
                throw new DocumentError('ZIP: sifreli (parola korumali) belgeler desteklenmiyor.');
            }
            const method = this.buf.readUInt16LE(pos + 10);
            const crc32 = this.buf.readUInt32LE(pos + 16);
            let compressedSize = this.buf.readUInt32LE(pos + 20);
            let uncompressedSize = this.buf.readUInt32LE(pos + 24);
            const nameLen = this.buf.readUInt16LE(pos + 28);
            const extraLen = this.buf.readUInt16LE(pos + 30);
            const commentLen = this.buf.readUInt16LE(pos + 32);
            let localHeaderOffset = this.buf.readUInt32LE(pos + 42);

            const rawName = this.buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
            const extra = this.buf.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen);
            const z64 = readZip64Extra(extra, uncompressedSize, compressedSize, localHeaderOffset);
            uncompressedSize = z64.uncompressedSize;
            compressedSize = z64.compressedSize;
            localHeaderOffset = z64.localHeaderOffset;

            const name = sanitizeEntryName(rawName);
            const isDirectory = rawName.endsWith('/');
            if (name && !isDirectory) {
                this.entries.set(name, {
                    name, compressedSize, uncompressedSize, method, crc32, localHeaderOffset, isDirectory,
                });
            }
            pos += 46 + nameLen + extraLen + commentLen;
        }
    }

    private findEocd(): number {
        // EOCD sonda, en fazla 22 + 65535 bayt geride olabilir (yorum alani).
        const min = Math.max(0, this.buf.length - (22 + 0xffff));
        for (let i = this.buf.length - 22; i >= min; i--) {
            if (this.buf.readUInt32LE(i) === SIG_EOCD) { return i; }
        }
        throw new DocumentError('ZIP: merkezi dizin sonu (EOCD) bulunamadi - dosya bir Office belgesi olmayabilir.');
    }

    private findZip64Eocd(eocd: number): number | undefined {
        const locator = eocd - 20;
        if (locator < 0 || this.buf.readUInt32LE(locator) !== SIG_EOCD64_LOCATOR) { return undefined; }
        const offset = readU64(this.buf, locator + 8);
        if (offset + 56 > this.buf.length || this.buf.readUInt32LE(offset) !== SIG_EOCD64) { return undefined; }
        return offset;
    }
}

/**
 * Girdi adini guvenli hale getirir.
 *
 * Arsiv icindeki adlar guvenilmez girdidir: mutlak yol, surucu harfi, `..` segmenti
 * veya NUL iceren adlar reddedilir. Ters bolu ileri boluya cevrilir (Windows'ta
 * uretilmis arsivler).
 */
export function sanitizeEntryName(raw: string): string | undefined {
    if (raw.includes('\u0000')) { return undefined; }
    const normalized = raw.split(BACKSLASH).join('/');
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) { return undefined; }
    const parts = normalized.split('/');
    for (const part of parts) {
        if (part === '..') { return undefined; }
    }
    const cleaned = parts.filter((p) => p !== '' && p !== '.').join('/');
    return cleaned || undefined;
}

function readU64(buf: Buffer, offset: number): number {
    const value = buf.readBigUInt64LE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new DocumentError('ZIP: dosya bu surum icin cok buyuk.');
    }
    return Number(value);
}

/** ZIP64 uzanti alanindan (0x0001) gercek boyut/ofset degerlerini okur. */
function readZip64Extra(
    extra: Buffer, uncompressedSize: number, compressedSize: number, localHeaderOffset: number
): { uncompressedSize: number; compressedSize: number; localHeaderOffset: number } {
    let pos = 0;
    while (pos + 4 <= extra.length) {
        const id = extra.readUInt16LE(pos);
        const size = extra.readUInt16LE(pos + 2);
        if (id === 0x0001) {
            let field = pos + 4;
            const end = Math.min(field + size, extra.length);
            if (uncompressedSize === 0xffffffff && field + 8 <= end) { uncompressedSize = readU64(extra, field); field += 8; }
            if (compressedSize === 0xffffffff && field + 8 <= end) { compressedSize = readU64(extra, field); field += 8; }
            if (localHeaderOffset === 0xffffffff && field + 8 <= end) { localHeaderOffset = readU64(extra, field); }
            break;
        }
        pos += 4 + size;
    }
    return { uncompressedSize, compressedSize, localHeaderOffset };
}
