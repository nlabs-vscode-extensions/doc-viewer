import type { ParseLimits } from '../core/limits';
import { DocumentError, kindForPath, type DocModel } from '../core/types';
import { parseCsv } from './csv';
import { parseDocx } from './docx';
import { parseXlsx } from './xlsx';
import { parsePdf } from './pdf';
import { parseMarkdown, type AssetReader } from './markdown';
import { parseJsonl } from './jsonl';

/**
 * Tek giris noktasi: bayt dizisi -> webview'in cizecegi belge modeli.
 *
 * Ayristirma tamamen eklenti host'unda (Node) yapilir; webview'e yalnizca veri gider.
 */
export function parseDocument(
    buf: Buffer,
    name: string,
    extension: string,
    limits: ParseLimits,
    /** Markdown'daki goreli gorselleri okumak icin; yalniz yerel dosyalarda saglanir. */
    readAsset?: AssetReader
): DocModel {
    const kind = kindForPath(`x${extension}`);
    if (!kind) {
        throw new DocumentError(`Desteklenmeyen dosya turu: ${extension || '(uzantisiz)'}`);
    }
    if (buf.length === 0) {
        throw new DocumentError('Dosya bos.');
    }

    switch (kind) {
        case 'word': return parseDocx(buf, name, limits);
        case 'sheet': return parseXlsx(buf, name, limits);
        case 'csv': return parseCsv(buf, name, limits);
        case 'pdf': return parsePdf(buf, name, limits);
        case 'markdown': return parseMarkdown(buf, name, limits, readAsset);
        case 'jsonl': return parseJsonl(buf, name, limits);
    }
}
