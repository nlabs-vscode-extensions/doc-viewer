import { decodeText } from '../core/text';
import type { ParseLimits } from '../core/limits';
import type { DocModel, JsonRecordSet, MetaEntry } from '../core/types';
import { DocumentError } from '../core/types';

/**
 * JSONL / NDJSON -> kayit kumesi.
 *
 * Her satir bagimsiz bir JSON degeridir. Bozuk satirlar dosyayi gecersiz kilmaz;
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

export function parseJsonl(buf: Buffer, name: string, limits: ParseLimits): DocModel {
    const { text, encoding } = decodeText(buf);
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

    if (total === 0) {
        throw new DocumentError('Dosyada JSON kaydi bulunamadi.');
    }
    if (records.length === 0) {
        throw new DocumentError(`Hicbir satir ayristirilamadi (${invalidLines.length} bozuk satir).`);
    }

    const labelKeys = LABEL_CANDIDATES.filter((key) => (keyCounts.get(key) ?? 0) > records.length / 2);
    const json: JsonRecordSet = {
        records,
        totalRecords: total,
        truncated: total > records.length,
        invalidLines: invalidLines.slice(0, 50),
        labelKeys,
    };

    const meta: MetaEntry[] = [
        { key: 'records', value: String(total) },
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
