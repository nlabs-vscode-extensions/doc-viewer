import { attr, child, childrenOf, descendants, textOf, type XmlNode } from '../xml/xml';
import type { ParseLimits } from '../core/limits';
import type { DocModel, MetaEntry, SheetCell, SheetModel } from '../core/types';
import { DocumentError } from '../core/types';
import { collectImages, openContainer, readRelationships, readXml } from './ooxml';
import { readCoreProperties } from './props';

/** Excel (SpreadsheetML) -> tablo modeli. */

interface Style {
    numFmtId: number;
    bold?: 1;
    italic?: 1;
    color?: string;
    bg?: string;
    align?: 'l' | 'c' | 'r';
}

export function parseXlsx(buf: Buffer, name: string, limits: ParseLimits): DocModel {
    const zip = openContainer(buf, limits);
    const workbook = readXml(zip, 'xl/workbook.xml');
    if (!workbook) {
        throw new DocumentError('Calisma kitabi bulunamadi (xl/workbook.xml). Dosya bir .xlsx olmayabilir.');
    }

    const warnings: string[] = [];
    const rels = readRelationships(zip, 'xl/workbook.xml');
    const shared = readSharedStrings(zip);
    const { styles, numFmts } = readStyles(zip);
    const date1904 = attr(child(workbook, 'workbookPr'), 'date1904') === '1';

    const sheets: SheetModel[] = [];
    const sheetNodes = descendants(workbook, 'sheet');
    for (const node of sheetNodes) {
        const sheetName = attr(node, 'name') ?? `Sheet${sheets.length + 1}`;
        const relId = attr(node, 'id');
        const target = relId ? rels.get(relId) : undefined;
        if (!target || !zip.has(target)) {
            warnings.push(`Sayfa okunamadi: ${sheetName}`);
            continue;
        }
        try {
            const root = readXml(zip, target);
            if (root) {
                sheets.push(readSheet(root, sheetName, shared, styles, numFmts, date1904, limits));
            }
        } catch (err) {
            warnings.push(`Sayfa okunamadi (${sheetName}): ${(err as Error).message}`);
        }
    }
    if (!sheets.length) {
        throw new DocumentError('Calisma kitabinda okunabilir sayfa yok.');
    }

    const collected = collectImages(zip, 'xl/media/', limits);
    warnings.push(...collected.warnings);

    const meta: MetaEntry[] = [
        { key: 'sheets', value: String(sheetNodes.length) },
        ...readCoreProperties(zip),
    ];

    return { kind: 'sheet', name, meta, warnings, images: collected.images, sheets };
}

/** Paylasilan dizeler tablosu. Zengin metin parcalari (`r`) duz metne birlestirilir. */
function readSharedStrings(zip: ReturnType<typeof openContainer>): string[] {
    const root = readXml(zip, 'xl/sharedStrings.xml');
    if (!root) { return []; }
    return childrenOf(root, 'si').map((si) => {
        const direct = child(si, 't');
        if (direct && si.children.length === 1) { return textOf(direct); }
        return childrenOf(si, 'r').map((r) => textOf(child(r, 't'))).join('') || textOf(si);
    });
}

function readStyles(zip: ReturnType<typeof openContainer>): { styles: Style[]; numFmts: Map<number, string> } {
    const numFmts = new Map<number, string>();
    const styles: Style[] = [];
    const root = readXml(zip, 'xl/styles.xml');
    if (!root) { return { styles, numFmts }; }

    for (const fmt of descendants(root, 'numFmt')) {
        const id = Number(attr(fmt, 'numFmtId'));
        const code = attr(fmt, 'formatCode');
        if (Number.isFinite(id) && code) { numFmts.set(id, code); }
    }

    const fonts = childrenOf(child(root, 'fonts'), 'font').map((font) => ({
        bold: child(font, 'b') ? (1 as const) : undefined,
        italic: child(font, 'i') ? (1 as const) : undefined,
        color: rgbOf(child(font, 'color')),
    }));
    const fills = childrenOf(child(root, 'fills'), 'fill').map((fill) => {
        const pattern = child(fill, 'patternFill');
        if (!pattern || attr(pattern, 'patternType') === 'none') { return undefined; }
        return rgbOf(child(pattern, 'fgColor'));
    });

    for (const xf of childrenOf(child(root, 'cellXfs'), 'xf')) {
        const fontIndex = Number(attr(xf, 'fontId') ?? 0);
        const fillIndex = Number(attr(xf, 'fillId') ?? 0);
        const font = fonts[fontIndex];
        const alignment = child(xf, 'alignment');
        const horizontal = attr(alignment, 'horizontal');
        styles.push({
            numFmtId: Number(attr(xf, 'numFmtId') ?? 0) || 0,
            bold: font?.bold,
            italic: font?.italic,
            color: font?.color,
            bg: attr(xf, 'applyFill') === '0' ? undefined : fills[fillIndex],
            align: horizontal === 'center' ? 'c' : horizontal === 'right' ? 'r' : horizontal === 'left' ? 'l' : undefined,
        });
    }
    return { styles, numFmts };
}

/** ARGB veya indeksli renk -> #rrggbb. Tema renkleri cozulmez (tema dosyasi gerekir). */
function rgbOf(node: XmlNode | undefined): string | undefined {
    const rgb = attr(node, 'rgb');
    if (!rgb || rgb.length < 6) { return undefined; }
    const hex = rgb.length === 8 ? rgb.slice(2) : rgb;
    return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : undefined;
}

function readSheet(
    root: XmlNode,
    name: string,
    shared: string[],
    styles: Style[],
    numFmts: Map<number, string>,
    date1904: boolean,
    limits: ParseLimits
): SheetModel {
    const sheetData = child(root, 'sheetData');
    const rowNodes = childrenOf(sheetData, 'row');

    let totalRows = 0;
    let totalCols = 0;
    const parsed: { index: number; cells: Map<number, SheetCell> }[] = [];

    for (const rowNode of rowNodes) {
        const rowIndex = Number(attr(rowNode, 'r') ?? 0) || parsed.length + 1;
        totalRows = Math.max(totalRows, rowIndex);
        const cells = new Map<number, SheetCell>();
        for (const cellNode of childrenOf(rowNode, 'c')) {
            const ref = attr(cellNode, 'r');
            const col = ref ? columnOf(ref) : cells.size + 1;
            totalCols = Math.max(totalCols, col);
            const cell = readCell(cellNode, shared, styles, numFmts, date1904);
            if (cell) { cells.set(col, cell); }
        }
        if (cells.size > 0) { parsed.push({ index: rowIndex, cells }); }
    }

    applyMerges(root, parsed);

    const rowLimit = Math.min(totalRows, limits.maxRows);
    const colLimit = Math.min(Math.max(totalCols, 1), limits.maxColumns);
    const rows: (SheetCell | null)[][] = [];
    for (let r = 1; r <= rowLimit; r++) { rows.push(new Array(colLimit).fill(null)); }
    for (const row of parsed) {
        if (row.index > rowLimit) { continue; }
        for (const [col, cell] of row.cells) {
            if (col <= colLimit) { rows[row.index - 1][col - 1] = cell; }
        }
    }

    return {
        name,
        rows,
        totalRows,
        totalCols,
        truncated: totalRows > rowLimit || totalCols > colLimit,
        colWidths: readColumnWidths(root, colLimit),
    };
}

/** Birlestirilmis hucreleri (mergeCells) span bilgisine cevirir; ortulen hucreler silinir. */
function applyMerges(root: XmlNode, parsed: { index: number; cells: Map<number, SheetCell> }[]): void {
    const merges = descendants(root, 'mergeCell');
    if (!merges.length) { return; }
    const byRow = new Map(parsed.map((r) => [r.index, r.cells]));
    for (const merge of merges) {
        const range = attr(merge, 'ref');
        if (!range || !range.includes(':')) { continue; }
        const [from, to] = range.split(':');
        const r1 = rowOf(from); const c1 = columnOf(from);
        const r2 = rowOf(to); const c2 = columnOf(to);
        if (!r1 || !r2 || !c1 || !c2) { continue; }
        const anchor = byRow.get(r1)?.get(c1);
        if (anchor) {
            if (c2 > c1) { anchor.cs = c2 - c1 + 1; }
            if (r2 > r1) { anchor.rs = r2 - r1 + 1; }
        }
        for (let r = r1; r <= r2; r++) {
            for (let c = c1; c <= c2; c++) {
                if (r === r1 && c === c1) { continue; }
                byRow.get(r)?.delete(c);
            }
        }
    }
}

function readColumnWidths(root: XmlNode, colLimit: number): number[] | undefined {
    const cols = descendants(root, 'col');
    if (!cols.length) { return undefined; }
    const widths = new Array<number>(colLimit).fill(0);
    let any = false;
    for (const col of cols) {
        const min = Number(attr(col, 'min') ?? 0);
        const max = Number(attr(col, 'max') ?? 0);
        const width = Number(attr(col, 'width') ?? 0);
        if (!min || !width) { continue; }
        for (let c = min; c <= Math.min(max || min, colLimit); c++) { widths[c - 1] = width; any = true; }
    }
    return any ? widths : undefined;
}

function readCell(
    node: XmlNode, shared: string[], styles: Style[], numFmts: Map<number, string>, date1904: boolean
): SheetCell | undefined {
    const type = attr(node, 't') ?? 'n';
    const styleIndex = Number(attr(node, 's') ?? 0);
    const style = styles[styleIndex];
    const formula = child(node, 'f');
    const rawValue = textOf(child(node, 'v'));

    let text: string;
    let cellType: SheetCell['t'] = 's';

    if (type === 's') {
        const index = Number(rawValue);
        text = shared[index] ?? '';
    } else if (type === 'inlineStr') {
        const is = child(node, 'is');
        text = childrenOf(is, 'r').map((r) => textOf(child(r, 't'))).join('') || textOf(child(is, 't'));
    } else if (type === 'b') {
        text = rawValue === '1' ? 'TRUE' : 'FALSE';
        cellType = 'b';
    } else if (type === 'e') {
        text = rawValue;
        cellType = 'e';
    } else if (type === 'str') {
        text = rawValue;
    } else if (type === 'd') {
        text = rawValue;
        cellType = 'd';
    } else {
        if (rawValue === '') { text = ''; }
        else {
            const numFmtId = style?.numFmtId ?? 0;
            const code = numFmts.get(numFmtId);
            if (isDateFormat(numFmtId, code)) {
                text = formatSerialDate(Number(rawValue), date1904, code);
                cellType = 'd';
            } else {
                text = formatNumber(Number(rawValue), code);
                cellType = 'n';
            }
        }
    }

    if (text === '' && !formula) { return undefined; }
    const cell: SheetCell = { v: text, t: cellType };
    if (cellType === 'n' || cellType === 'd') { cell.align = 'r'; }
    if (style?.align) { cell.align = style.align; }
    if (style?.bold) { cell.b = 1; }
    if (style?.italic) { cell.i = 1; }
    if (style?.color) { cell.color = style.color; }
    if (style?.bg) { cell.bg = style.bg; }
    if (formula) {
        const expression = textOf(formula);
        if (expression) { cell.f = `=${expression}`; }
    }
    return cell;
}

/** "B12" -> 2. Gecersiz basvuruda 0 doner. */
export function columnOf(ref: string): number {
    let col = 0;
    for (let i = 0; i < ref.length; i++) {
        const code = ref.charCodeAt(i);
        if (code >= 65 && code <= 90) { col = col * 26 + (code - 64); }
        else if (code >= 97 && code <= 122) { col = col * 26 + (code - 96); }
        else { break; }
    }
    return col;
}

/** "B12" -> 12. */
export function rowOf(ref: string): number {
    const match = /[0-9]+/.exec(ref);
    return match ? Number(match[0]) : 0;
}

/** Yerlesik tarih bicimleri; ozel bicimlerde kod incelenir. */
const BUILTIN_DATE_IDS = new Set([
    14, 15, 16, 17, 18, 19, 20, 21, 22,
    27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
    45, 46, 47,
    50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

export function isDateFormat(numFmtId: number, code: string | undefined): boolean {
    if (BUILTIN_DATE_IDS.has(numFmtId)) { return true; }
    if (!code) { return false; }
    return /[ymdhs]/i.test(stripFormatLiterals(code));
}

/** Bicim kodundaki tirnakli metinleri, renk/kosul koseli parantezlerini ve kacislari atar. */
function stripFormatLiterals(code: string): string {
    let out = '';
    let i = 0;
    while (i < code.length) {
        const ch = code[i];
        if (ch === '"') {
            const end = code.indexOf('"', i + 1);
            i = end < 0 ? code.length : end + 1;
            continue;
        }
        if (ch === '[') {
            const end = code.indexOf(']', i + 1);
            i = end < 0 ? code.length : end + 1;
            continue;
        }
        if (ch === String.fromCharCode(92)) { i += 2; continue; }
        out += ch;
        i++;
    }
    return out;
}

/** Excel seri numarasi -> ISO benzeri tarih metni. 1900 artik yil hatasi hesaba katilir. */
export function formatSerialDate(serial: number, date1904: boolean, code: string | undefined): string {
    if (!Number.isFinite(serial)) { return ''; }
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const ms = epoch + Math.round(serial * 86400000);
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) { return String(serial); }

    const stripped = code ? stripFormatLiterals(code) : '';
    const hasDate = !code || /[ymd]/i.test(stripped);
    const hasTime = /[hs]/i.test(stripped) || serial % 1 !== 0;

    const pad = (n: number) => String(n).padStart(2, '0');
    const datePart = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    const timePart = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
    if (hasDate && hasTime) { return `${datePart} ${timePart}`; }
    if (hasTime) { return timePart; }
    return datePart;
}

/**
 * Sayiyi bicim koduna gore metne cevirir.
 *
 * Tam bir Excel bicim motoru degildir - yuzde, binlik ayraci ve ondalik basamak
 * sayisi desteklenir; para birimi sembolleri ve kosullu bolumler yok sayilir.
 */
export function formatNumber(value: number, code: string | undefined): string {
    if (!Number.isFinite(value)) { return ''; }
    const stripped = code ? stripFormatLiterals(code).split(';')[0] : '';
    const isPercent = stripped.includes('%');
    const scaled = isPercent ? value * 100 : value;

    const decimalMatch = /[.]([0#]+)/.exec(stripped);
    const decimals = decimalMatch ? decimalMatch[1].length : undefined;
    const grouped = stripped.includes(',#') || /#,#/.test(stripped);

    let text: string;
    if (decimals !== undefined) {
        text = scaled.toFixed(Math.min(decimals, 20));
    } else if (Number.isInteger(scaled)) {
        text = String(scaled);
    } else {
        text = String(Number(scaled.toPrecision(15)));
    }
    if (grouped) { text = addThousands(text); }
    return isPercent ? `${text}%` : text;
}

function addThousands(text: string): string {
    const negative = text.startsWith('-');
    const body = negative ? text.slice(1) : text;
    const [intPart, fracPart] = body.split('.');
    const withSeparators = intPart.replace(/\B(?=([0-9]{3})+(?![0-9]))/g, ',');
    return `${negative ? '-' : ''}${withSeparators}${fracPart ? '.' + fracPart : ''}`;
}
