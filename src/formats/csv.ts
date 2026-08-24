import type { ParseLimits } from '../core/limits';
import { decodeText } from '../core/text';
import type { DocModel, SheetCell, SheetModel } from '../core/types';

/** CSV/TSV -> tablo modeli. RFC 4180 tirnaklama kurallari, alan icinde satir sonu destekli. */

const DELIMITERS: Record<string, string> = {
    comma: ',',
    semicolon: ';',
    tab: '\t',
    pipe: '|',
};

const CANDIDATES = [',', ';', '\t', '|'];

export function parseCsv(buf: Buffer, name: string, limits: ParseLimits): DocModel {
    const { text, encoding } = decodeText(buf);
    const delimiter = limits.csvDelimiter === 'auto'
        ? detectDelimiter(text, name)
        : DELIMITERS[limits.csvDelimiter] ?? ',';

    const rows = splitRows(text, delimiter);
    const totalRows = rows.length;
    const totalCols = rows.reduce((max, r) => Math.max(max, r.length), 0);

    const truncated = totalRows > limits.maxRows || totalCols > limits.maxColumns;
    const visible = rows.slice(0, limits.maxRows).map((row) =>
        row.slice(0, limits.maxColumns).map(toCell)
    );

    const sheet: SheetModel = {
        name: name.replace(/[.][^.]+$/, ''),
        rows: visible,
        totalRows,
        totalCols,
        truncated,
        headerRow: looksLikeHeader(rows) ? 1 : undefined,
    };

    return {
        kind: 'csv',
        name,
        meta: [
            { key: 'rows', value: String(totalRows) },
            { key: 'columns', value: String(totalCols) },
            { key: 'delimiter', value: describeDelimiter(delimiter) },
            { key: 'encoding', value: encoding },
        ],
        warnings: [],
        images: [],
        sheets: [sheet],
    };
}

function toCell(value: string): SheetCell | null {
    if (value === '') { return null; }
    const numeric = parseNumeric(value);
    return numeric === undefined
        ? { v: value, t: 's' }
        : { v: value, t: 'n', align: 'r' };
}

/** Hem "1234.5" hem "1.234,5" bicimini sayi sayar; hizalama icin yeterli. */
function parseNumeric(value: string): number | undefined {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 32) { return undefined; }
    if (!/^[-+]?[0-9][0-9.,\s]*$/.test(trimmed)) { return undefined; }
    const plain = trimmed.replace(/[\s]/g, '').replace(/[.,](?=[0-9]{3}(?:[^0-9]|$))/g, '').replace(',', '.');
    const num = Number(plain);
    return Number.isFinite(num) ? num : undefined;
}

/** Ilk satirlarda tutarli en cok gorulen ayraci secer; TSV uzantisi sekmeyi zorlar. */
function detectDelimiter(text: string, name: string): string {
    if (name.toLowerCase().endsWith('.tsv')) { return '\t'; }
    const sample = text.slice(0, 64 * 1024);
    let best = ',';
    let bestScore = -1;
    for (const candidate of CANDIDATES) {
        const rows = splitRows(sample, candidate).slice(0, 20);
        if (rows.length < 2) { continue; }
        const counts = rows.map((r) => r.length);
        const first = counts[0];
        if (first < 2) { continue; }
        // Tutarlilik: ayni sutun sayisini veren satir orani.
        const consistent = counts.filter((c) => c === first).length / counts.length;
        const score = consistent * 10 + Math.min(first, 20);
        if (score > bestScore) { bestScore = score; best = candidate; }
    }
    return best;
}

function describeDelimiter(delimiter: string): string {
    if (delimiter === '\t') { return 'tab'; }
    return delimiter;
}

/** Basligi tahmin eder: ilk satirin tamami metin, sonraki satirlarda sayi varsa. */
function looksLikeHeader(rows: string[][]): boolean {
    if (rows.length < 2) { return false; }
    const head = rows[0];
    if (head.length < 2 || head.some((c) => c.trim() === '')) { return false; }
    if (head.some((c) => parseNumeric(c) !== undefined)) { return false; }
    const body = rows.slice(1, 21);
    return body.some((row) => row.some((c) => parseNumeric(c) !== undefined));
}

/** Tirnak farkindali satir/alan bolucu. Tirnak ici satir sonlari korunur. */
export function splitRows(text: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    let i = 0;

    const pushField = () => { row.push(field); field = ''; };
    const pushRow = () => { pushField(); rows.push(row); row = []; };

    while (i < text.length) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i++; continue;
            }
            field += ch; i++; continue;
        }
        if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
        if (ch === delimiter) { pushField(); i++; continue; }
        if (ch === '\r') { i++; continue; }
        if (ch === '\n') { pushRow(); i++; continue; }
        field += ch; i++;
    }
    if (field !== '' || row.length > 0) { pushRow(); }

    // Sondaki tamamen bos satiri at (dosya sonu satir sonu).
    while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) { rows.pop(); }
    return rows;
}
