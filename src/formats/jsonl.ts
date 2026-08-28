import { decodeText } from '../core/text';
import type { ParseLimits } from '../core/limits';
import type { DocModel, JsonRecordSet, MetaEntry } from '../core/types';
import { DocumentError } from '../core/types';

/**
 * JSON / JSONL / NDJSON -> kayit kumesi.
 *
 * Iki okuma kipi vardir ve biri digerine duser:
 *  - **Tum dosya**: gecerli tek bir JSON degeri. Dizi ise ogeleri kayit olur,
 *    nesne ise tek kayit. `.json` ve `.geojson` once bunu dener.
 *  - **Satir basina**: her satir bagimsiz bir JSON degeridir. `.jsonl`/`.ndjson`
 *    once bunu dener.
 *
 * Satir kipinde her satir bagimsiz bir JSON degeridir. Bozuk satirlar dosyayi gecersiz kilmaz;
 * numaralari toplanip uyari olarak gosterilir - gercek gunlukler sik sik yarim
 * yazilmis son satir tasir.
 */

/** Ozet satirinda etiket olarak kullanilmaya aday anahtarlar, oncelik sirasiyla. */
const LABEL_CANDIDATES = ['type', 'role', 'event', 'level', 'name', 'action', 'kind', 'msg', 'message'];

/** Cok derin veya cok genis kayitlar webview'i kilitler; budama sinirlari. */
const MAX_DEPTH = 24;
const MAX_KEYS = 500;
const MAX_ARRAY = 2000;
const MAX_STRING = 20000;

/**
 * Webview'e gonderilecek kayitlarin toplam bayt butcesi.
 *
 * Satir sayisi tek basina yetmez: tek bir gunluk kaydi megabaytlarca olabilir.
 * Butce dolunca kayit eklemeyi birakiriz, boylece arayuz her zaman acilir.
 */
const MAX_PAYLOAD_BYTES = 12 * 1024 * 1024;

export function parseJsonl(buf: Buffer, name: string, limits: ParseLimits, wholeFileFirst = false): DocModel {
    const { text, encoding } = decodeText(buf);

    if (wholeFileFirst) {
        const whole = readWholeFile(text, limits);
        if (whole) { return build(name, whole, encoding, [], 'document'); }
    }
    const lines = text.split(/\r?\n/);

    const records: unknown[] = [];
    const invalidLines: number[] = [];
    const keyCounts = new Map<string, number>();
    let total = 0;
    let payloadBytes = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '') { continue; }
        total++;
        if (records.length >= limits.maxRows || payloadBytes >= MAX_PAYLOAD_BYTES) { continue; }

        try {
            const value = prune(JSON.parse(line), 0);
            payloadBytes += line.length;
            records.push(value);
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                for (const key of Object.keys(value as object)) {
                    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
                }
            }
        } catch {
            invalidLines.push(i + 1);
        }
    }

    if (records.length === 0) {
        // Satir kipi tutmadi: dosyanin tamamini tek bir JSON degeri olarak dene.
        const whole = readWholeFile(text, limits);
        if (whole) { return build(name, whole, encoding, [], 'document'); }
        if (total === 0) { throw new DocumentError('Dosyada JSON kaydi bulunamadi.'); }
        throw new DocumentError(`Hicbir satir ayristirilamadi (${invalidLines.length} bozuk satir).`);
    }

    return build(name, { records, total }, encoding, invalidLines, 'lines');
}

/** Dosyanin tamamini tek bir JSON degeri olarak okur; olmuyorsa undefined. */
function readWholeFile(text: string, limits: ParseLimits): { records: unknown[]; total: number } | undefined {
    const trimmed = text.trim();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) { return undefined; }
    let value: unknown;
    try {
        value = JSON.parse(trimmed);
    } catch {
        return undefined;
    }
    // Dizi ise ogeleri kayit sayilir; tek nesne ise dosyanin kendisi tek kayittir.
    const all = Array.isArray(value) ? value : [value];
    const kept = all.slice(0, limits.maxRows).map((item) => prune(item, 0));
    return { records: kept, total: all.length };
}

/** Iki okuma kipinin ortak sonuc ureticisi. */
function build(
    name: string,
    source: { records: unknown[]; total: number },
    encoding: string,
    invalidLines: number[],
    mode: 'lines' | 'document'
): DocModel {
    const { records, total } = source;
    const keyCounts = new Map<string, number>();
    for (const record of records) {
        if (record && typeof record === 'object' && !Array.isArray(record)) {
            for (const key of Object.keys(record as object)) {
                keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
            }
        }
    }

    const json: JsonRecordSet = {
        records,
        totalRecords: total,
        truncated: total > records.length,
        invalidLines: invalidLines.slice(0, 50),
        labelKeys: LABEL_CANDIDATES.filter((key) => (keyCounts.get(key) ?? 0) > records.length / 2),
    };

    const meta: MetaEntry[] = [
        { key: 'records', value: String(total) },
        { key: 'mode', value: mode === 'lines' ? 'one JSON value per line' : 'single JSON document' },
        { key: 'encoding', value: encoding },
    ];
    const topKeys = [...keyCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
    if (topKeys.length) { meta.push({ key: 'keys', value: topKeys.join(', ') }); }

    const warnings: string[] = [];
    if (invalidLines.length) {
        const shown = invalidLines.slice(0, 10).join(', ');
        warnings.push(`${invalidLines.length} satir ayristirilamadi (satir ${shown}${invalidLines.length > 10 ? ', ...' : ''}).`);
    }

    return { kind: 'jsonl', name, meta, warnings, images: [], json };
}

/** Asiri derin/genis yapilari budar; budanan yer isaretle belirtilir. */
function prune(value: unknown, depth: number): unknown {
    if (depth >= MAX_DEPTH) { return '[derinlik siniri]'; }
    if (typeof value === 'string') {
        return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + `... [${value.length} karakter]` : value;
    }
    if (Array.isArray(value)) {
        const out = value.slice(0, MAX_ARRAY).map((item) => prune(item, depth + 1));
        if (value.length > MAX_ARRAY) { out.push(`... [${value.length} oge]`); }
        return out;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS);
        const out: Record<string, unknown> = {};
        for (const [key, item] of entries) { out[key] = prune(item, depth + 1); }
        return out;
    }
    return value;
}
