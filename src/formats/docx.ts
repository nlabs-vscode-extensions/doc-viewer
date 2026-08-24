import { attr, child, childrenOf, descendants, textOf, type XmlNode } from '../xml/xml';
import type { ParseLimits } from '../core/limits';
import type { Block, DocModel, ListInfo, Run, TableCell } from '../core/types';
import { DocumentError } from '../core/types';
import { collectImages, openContainer, readRelationships, readXml, RENDERABLE_MIME } from './ooxml';
import { readCoreProperties } from './props';

/** Word (WordprocessingML) -> blok modeli. */

/** EMU (English Metric Unit) -> CSS pikseli. 914400 EMU = 1 inc, 96 dpi. */
const EMU_PER_PX = 9525;

interface DocContext {
    rels: Map<string, string>;
    imageByPath: Map<string, string>;
    renderable: Set<string>;
    styleHeading: Map<string, number>;
    numbering: NumberingIndex;
    counters: Map<string, number[]>;
    warnings: string[];
}

export function parseDocx(buf: Buffer, name: string, limits: ParseLimits): DocModel {
    const zip = openContainer(buf, limits);
    const document = readXml(zip, 'word/document.xml');
    if (!document) {
        throw new DocumentError('Belge govdesi bulunamadi (word/document.xml). Dosya bir .docx olmayabilir.');
    }

    const collected = collectImages(zip, 'word/media/', limits);
    const context: DocContext = {
        rels: readRelationships(zip, 'word/document.xml'),
        imageByPath: collected.byPath,
        renderable: new Set(collected.images.filter((i) => RENDERABLE_MIME.has(i.mime)).map((i) => i.id)),
        styleHeading: readHeadingStyles(zip),
        numbering: readNumbering(zip),
        counters: new Map(),
        warnings: [...collected.warnings],
    };

    const body = child(document, 'body');
    if (!body) { throw new DocumentError('Belge govdesi bos.'); }
    const blocks = readBlocks(body, context);

    if (!blocks.length) {
        context.warnings.push('Belgede goruntulenebilir icerik bulunamadi.');
    }

    return {
        kind: 'word',
        name,
        meta: readCoreProperties(zip),
        warnings: context.warnings,
        images: collected.images,
        blocks,
    };
}

function readBlocks(parent: XmlNode, context: DocContext): Block[] {
    const blocks: Block[] = [];
    for (const node of parent.children) {
        if (node.local === 'p') {
            const block = readParagraph(node, context);
            if (block) { blocks.push(block); }
        } else if (node.local === 'tbl') {
            const table = readTable(node, context);
            if (table) { blocks.push(table); }
        } else if (node.local === 'sdt') {
            // Yapilandirilmis icerik denetimi: govdesi seffaf gecilir.
            const content = child(node, 'sdtContent');
            if (content) { blocks.push(...readBlocks(content, context)); }
        }
    }
    return blocks;
}

function readParagraph(node: XmlNode, context: DocContext): Block | undefined {
    const props = child(node, 'pPr');
    const runs: Run[] = [];
    const images: Block[] = [];
    collectRuns(node, context, runs, images, undefined);

    const heading = headingLevel(props, context);
    const hasText = runs.some((r) => r.text.trim() !== '');

    // Yalniz gorsel tasiyan paragraf: gorseli tek basina blok yapariz.
    if (!hasText && images.length > 0) {
        return images.length === 1 ? images[0] : { t: 'para', runs: [], align: 'center' };
    }
    if (!hasText && images.length === 0) {
        // Bos paragraf: yalnizca sayfa sonu tasiyorsa anlamli.
        return hasPageBreak(node) ? { t: 'pagebreak' } : undefined;
    }

    if (heading !== undefined) {
        return { t: 'heading', level: heading, runs: mergeRuns(runs) };
    }

    const block: Block = { t: 'para', runs: mergeRuns(runs) };
    const alignment = attr(child(props, 'jc'), 'val');
    if (alignment === 'center' || alignment === 'right' || alignment === 'both') {
        block.align = alignment === 'both' ? 'justify' : alignment;
    }
    const indent = Number(attr(child(props, 'ind'), 'left') ?? 0);
    if (indent > 0) { block.indent = Math.min(Math.round(indent / 720), 8); }

    const list = listInfo(props, context);
    if (list) { block.list = list; }
    return block;
}

/** Kacinci baslik seviyesi? Once stil adi, sonra `outlineLvl` bakilir. */
function headingLevel(props: XmlNode | undefined, context: DocContext): number | undefined {
    const styleId = attr(child(props, 'pStyle'), 'val');
    if (styleId) {
        const level = context.styleHeading.get(styleId.toLowerCase());
        if (level !== undefined) { return level; }
    }
    const outline = Number(attr(child(props, 'outlineLvl'), 'val') ?? NaN);
    if (Number.isFinite(outline) && outline >= 0 && outline <= 8) { return outline + 1; }
    return undefined;
}

function hasPageBreak(node: XmlNode): boolean {
    return descendants(node, 'br').some((br) => attr(br, 'type') === 'page');
}

/** Ard arda gelen ayni bicimli parcalari birlestirir - DOM'da daha az dugum. */
function mergeRuns(runs: Run[]): Run[] {
    const out: Run[] = [];
    for (const run of runs) {
        if (run.text === '') { continue; }
        const last = out[out.length - 1];
        if (last && sameFormat(last, run)) { last.text += run.text; continue; }
        out.push(run);
    }
    return out;
}

function sameFormat(a: Run, b: Run): boolean {
    return a.b === b.b && a.i === b.i && a.u === b.u && a.s === b.s
        && a.sup === b.sup && a.sub === b.sub && a.mono === b.mono
        && a.color === b.color && a.bg === b.bg && a.size === b.size && a.link === b.link;
}

/** Paragraf agacini gezerek metin parcalarini ve gorselleri toplar. */
function collectRuns(node: XmlNode, context: DocContext, runs: Run[], images: Block[], link: string | undefined): void {
    for (const item of node.children) {
        switch (item.local) {
            case 'pPr':
                break;
            case 'hyperlink': {
                const relId = attr(item, 'id');
                const target = relId ? context.rels.get(relId) : undefined;
                collectRuns(item, context, runs, images, target ?? link);
                break;
            }
            case 'r': {
                const format = runFormat(child(item, 'rPr'), link);
                for (const piece of item.children) {
                    if (piece.local === 't') {
                        runs.push({ ...format, text: piece.text || textOf(piece) });
                    } else if (piece.local === 'tab') {
                        runs.push({ ...format, text: '\t' });
                    } else if (piece.local === 'br') {
                        runs.push({ ...format, text: '\n' });
                    } else if (piece.local === 'drawing' || piece.local === 'pict' || piece.local === 'object') {
                        const image = readImage(piece, context);
                        if (image) { images.push(image); }
                    } else if (piece.local === 'sym') {
                        const code = attr(piece, 'char');
                        const value = code ? parseInt(code, 16) : NaN;
                        if (Number.isFinite(value)) { runs.push({ ...format, text: String.fromCharCode(value) }); }
                    }
                }
                break;
            }
            case 'ins':
            case 'smartTag':
            case 'sdt':
            case 'sdtContent':
                collectRuns(item, context, runs, images, link);
                break;
            case 'del':
                // Silinmis (degisiklik izleme) metin gosterilmez.
                break;
            default:
                break;
        }
    }
}

function runFormat(props: XmlNode | undefined, link: string | undefined): Run {
    const run: Run = { text: '' };
    if (link) { run.link = link; }
    if (!props) { return run; }
    if (isOn(child(props, 'b'))) { run.b = 1; }
    if (isOn(child(props, 'i'))) { run.i = 1; }
    if (isOn(child(props, 'strike')) || isOn(child(props, 'dstrike'))) { run.s = 1; }
    const underline = attr(child(props, 'u'), 'val');
    if (underline && underline !== 'none') { run.u = 1; }
    const vertAlign = attr(child(props, 'vertAlign'), 'val');
    if (vertAlign === 'superscript') { run.sup = 1; }
    if (vertAlign === 'subscript') { run.sub = 1; }

    const color = attr(child(props, 'color'), 'val');
    if (color && /^[0-9a-fA-F]{6}$/.test(color) && color.toLowerCase() !== '000000') {
        run.color = `#${color.toLowerCase()}`;
    }
    const highlight = attr(child(props, 'highlight'), 'val');
    const highlightColor = highlight ? HIGHLIGHT[highlight] : undefined;
    const shading = attr(child(props, 'shd'), 'fill');
    if (highlightColor) { run.bg = highlightColor; }
    else if (shading && /^[0-9a-fA-F]{6}$/.test(shading) && shading.toLowerCase() !== 'ffffff') {
        run.bg = `#${shading.toLowerCase()}`;
    }

    const halfPoints = Number(attr(child(props, 'sz'), 'val') ?? NaN);
    if (Number.isFinite(halfPoints) && halfPoints > 0) { run.size = halfPoints / 2; }

    const font = attr(child(props, 'rFonts'), 'ascii') ?? '';
    if (/courier|consolas|mono/i.test(font)) { run.mono = 1; }
    return run;
}

/** `<w:b/>` acik demektir; `val="0"` veya `val="false"` kapalidir. */
function isOn(node: XmlNode | undefined): boolean {
    if (!node) { return false; }
    const value = attr(node, 'val');
    return value !== '0' && value !== 'false' && value !== 'off';
}

const HIGHLIGHT: Record<string, string> = {
    yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff',
    blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080',
    darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
    darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0',
};

/** `w:drawing` / `w:pict` icindeki gorsel basvurusunu blok haline getirir. */
function readImage(node: XmlNode, context: DocContext): Block | undefined {
    let relId = attr(descendants(node, 'blip')[0], 'embed');
    if (!relId) { relId = attr(descendants(node, 'imagedata')[0], 'id'); }
    if (!relId) { return undefined; }

    const target = context.rels.get(relId);
    const id = target ? context.imageByPath.get(target) : undefined;
    if (!id || !context.renderable.has(id)) { return undefined; }

    const block: Block = { t: 'image', id };
    const extent = descendants(node, 'extent')[0];
    const cx = Number(attr(extent, 'cx') ?? NaN);
    const cy = Number(attr(extent, 'cy') ?? NaN);
    if (Number.isFinite(cx) && cx > 0) { block.w = Math.round(cx / EMU_PER_PX); }
    if (Number.isFinite(cy) && cy > 0) { block.h = Math.round(cy / EMU_PER_PX); }

    const description = descendants(node, 'docPr')[0];
    const alt = attr(description, 'descr') ?? attr(description, 'name');
    if (alt) { block.alt = alt; }
    return block;
}

function readTable(node: XmlNode, context: DocContext): Block | undefined {
    const rows: TableCell[][] = [];
    for (const rowNode of childrenOf(node, 'tr')) {
        const cells: TableCell[] = [];
        for (const cellNode of childrenOf(rowNode, 'tc')) {
            const cellProps = child(cellNode, 'tcPr');
            const vMerge = child(cellProps, 'vMerge');
            // Devam eden dikey birlesim hucresi: ustteki hucrenin rowSpan'ina eklenir.
            if (vMerge && (attr(vMerge, 'val') ?? 'continue') === 'continue') {
                extendRowSpan(rows, cells.length);
                continue;
            }
            const cell: TableCell = { blocks: readBlocks(cellNode, context) };
            const span = Number(attr(child(cellProps, 'gridSpan'), 'val') ?? 1);
            if (span > 1) { cell.colSpan = span; }
            if (isHeaderRow(rowNode)) { cell.header = 1; }
            cells.push(cell);
        }
        if (cells.length) { rows.push(cells); }
    }
    return rows.length ? { t: 'table', rows } : undefined;
}

function isHeaderRow(rowNode: XmlNode): boolean {
    return child(child(rowNode, 'trPr'), 'tblHeader') !== undefined;
}

/** Dikey birlesimde ustteki (ayni sutundaki) hucrenin rowSpan degerini artirir. */
function extendRowSpan(rows: TableCell[][], columnIndex: number): void {
    for (let r = rows.length - 1; r >= 0; r--) {
        let column = 0;
        for (const cell of rows[r]) {
            if (column === columnIndex) {
                cell.rowSpan = (cell.rowSpan ?? 1) + 1;
                return;
            }
            column += cell.colSpan ?? 1;
        }
    }
}

/** styleId -> baslik seviyesi. "Heading 2" / "Baslik 2" gibi adlar da yakalanir. */
function readHeadingStyles(zip: ReturnType<typeof openContainer>): Map<string, number> {
    const map = new Map<string, number>();
    const root = readXml(zip, 'word/styles.xml');
    if (!root) { return map; }
    for (const style of descendants(root, 'style')) {
        const id = attr(style, 'styleId');
        if (!id) { continue; }
        const name = attr(child(style, 'name'), 'val') ?? '';
        const level = levelFromName(id) ?? levelFromName(name);
        if (level !== undefined) { map.set(id.toLowerCase(), level); }
    }
    return map;
}

function levelFromName(name: string): number | undefined {
    const normalized = name.toLowerCase().replace(/[\s_-]/g, '');
    if (normalized === 'title') { return 1; }
    if (normalized === 'subtitle') { return 2; }
    const match = /^(?:heading|baslik|berschrift|titre)([1-9])$/.exec(normalized);
    return match ? Number(match[1]) : undefined;
}

interface LevelDefinition {
    format: string;
    text: string;
    start: number;
}

type NumberingIndex = Map<string, Map<number, LevelDefinition>>;

function readNumbering(zip: ReturnType<typeof openContainer>): NumberingIndex {
    const index: NumberingIndex = new Map();
    const root = readXml(zip, 'word/numbering.xml');
    if (!root) { return index; }

    const abstract = new Map<string, Map<number, LevelDefinition>>();
    for (const node of descendants(root, 'abstractNum')) {
        const id = attr(node, 'abstractNumId');
        if (!id) { continue; }
        const levels = new Map<number, LevelDefinition>();
        for (const lvl of childrenOf(node, 'lvl')) {
            const level = Number(attr(lvl, 'ilvl') ?? NaN);
            if (!Number.isFinite(level)) { continue; }
            levels.set(level, {
                format: attr(child(lvl, 'numFmt'), 'val') ?? 'decimal',
                text: attr(child(lvl, 'lvlText'), 'val') ?? '%1.',
                start: Number(attr(child(lvl, 'start'), 'val') ?? 1) || 1,
            });
        }
        abstract.set(id, levels);
    }

    for (const node of descendants(root, 'num')) {
        const numId = attr(node, 'numId');
        const abstractId = attr(child(node, 'abstractNumId'), 'val');
        if (numId && abstractId && abstract.has(abstractId)) {
            index.set(numId, abstract.get(abstractId)!);
        }
    }
    return index;
}

/** Paragraf bir liste ogesi mi? Ise isaretcisini (madde imi veya sira numarasi) uretir. */
function listInfo(props: XmlNode | undefined, context: DocContext): ListInfo | undefined {
    const numPr = child(props, 'numPr');
    if (!numPr) { return undefined; }
    const numId = attr(child(numPr, 'numId'), 'val');
    if (!numId || numId === '0') { return undefined; }
    const level = Number(attr(child(numPr, 'ilvl'), 'val') ?? 0) || 0;

    const definition = context.numbering.get(numId)?.get(level);
    const format = definition?.format ?? 'decimal';
    if (format === 'none') { return undefined; }
    if (format === 'bullet') {
        return { kind: 'bullet', level, marker: BULLETS[level % BULLETS.length] };
    }

    const counters = advanceCounter(context, numId, level, definition?.start ?? 1);
    const template = definition?.text ?? '%1.';
    const marker = template.replace(/%([1-9])/g, (match, digit: string) => {
        const value = counters[Number(digit) - 1];
        return value === undefined ? match : formatCounter(value, digit === String(level + 1) ? format : 'decimal');
    });
    return { kind: 'number', level, marker };
}

const BULLETS = ['\u2022', '\u25e6', '\u25aa'];

/** Sayaci ilerletir ve derin seviyeleri sifirlar; her `numId` kendi sayacini tutar. */
function advanceCounter(context: DocContext, numId: string, level: number, start: number): number[] {
    let counters = context.counters.get(numId);
    if (!counters) { counters = []; context.counters.set(numId, counters); }
    for (let i = 0; i < level; i++) {
        if (counters[i] === undefined) { counters[i] = 1; }
    }
    counters[level] = counters[level] === undefined ? start : counters[level] + 1;
    counters.length = level + 1;
    return counters;
}

function formatCounter(value: number, format: string): string {
    switch (format) {
        case 'lowerLetter': return letters(value).toLowerCase();
        case 'upperLetter': return letters(value);
        case 'lowerRoman': return roman(value).toLowerCase();
        case 'upperRoman': return roman(value);
        default: return String(value);
    }
}

function letters(value: number): string {
    let out = '';
    let n = value;
    while (n > 0) {
        const rem = (n - 1) % 26;
        out = String.fromCharCode(65 + rem) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out || 'A';
}

const ROMAN: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

function roman(value: number): string {
    if (value <= 0 || value > 3999) { return String(value); }
    let n = value;
    let out = '';
    for (const [amount, symbol] of ROMAN) {
        while (n >= amount) { out += symbol; n -= amount; }
    }
    return out;
}
