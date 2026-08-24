import { Parser, isRegular, isWhite } from './lexer';
import { PdfName, PdfString, arrayOf, dictOf, isStream, nameOf, numberOf, type PdfDict, type PdfStream, type PdfValue } from './objects';
import { decodeGlyphs, loadFont, type PdfFont } from './fonts';
import type { PdfDocument } from './document';

/**
 * Icerik akisi yorumlayicisi (ISO 32000-1, 9. bolum).
 *
 * Sayfayi CIZMEZ; yalnizca metnin nereye dustugunu ve hangi gorsellerin
 * yerlestirildigini hesaplar. Cizim islecleri (yol, boyama, kirpma) atlanir.
 */

/** [a b c d e f] donusum dizeyi. */
export type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
    return [
        m[0] * n[0] + m[1] * n[2],
        m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2],
        m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4],
        m[4] * n[1] + m[5] * n[3] + n[5],
    ];
}

export interface TextChunk {
    x: number;
    y: number;
    /** Sayfa birimine olceklenmis yazi boyutu. */
    size: number;
    /** Metnin bittigi x konumu - satir birlestirmede bosluk karari icin. */
    endX: number;
    text: string;
}

export interface ImagePlacement {
    /** Cozulmus gorsel akisi. Nesne onbellekli oldugu icin ayni gorsel ayni ornegi verir. */
    stream: PdfStream;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ContentResult {
    chunks: TextChunk[];
    images: ImagePlacement[];
}

interface GraphicsState {
    ctm: Matrix;
    font?: PdfFont;
    fontSize: number;
    charSpacing: number;
    wordSpacing: number;
    horizontalScale: number;
    leading: number;
    rise: number;
    renderMode: number;
}

function cloneState(state: GraphicsState): GraphicsState {
    return { ...state, ctm: [...state.ctm] as Matrix };
}

const MAX_CHUNKS = 400000;

export function runContent(
    doc: PdfDocument, content: Buffer, resources: PdfDict | undefined, baseCtm: Matrix
): ContentResult {
    const result: ContentResult = { chunks: [], images: [] };
    execute(doc, content, resources, baseCtm, result, 0);
    return result;
}

function execute(
    doc: PdfDocument, content: Buffer, resources: PdfDict | undefined, baseCtm: Matrix,
    result: ContentResult, depth: number
): void {
    if (depth > 12 || content.length === 0) { return; }

    // Yazi tipi onbellegi kaynak sozlugune bagli: her icerik akisi kendi adlarini kullanir.
    const fontCache = new Map<string, PdfFont>();
    const parser = new Parser(content, 0);
    const stack: GraphicsState[] = [];
    let state: GraphicsState = {
        ctm: baseCtm, fontSize: 0, charSpacing: 0, wordSpacing: 0,
        horizontalScale: 1, leading: 0, rise: 0, renderMode: 0,
    };
    let textMatrix: Matrix = IDENTITY;
    let lineMatrix: Matrix = IDENTITY;
    const operands: PdfValue[] = [];

    const num = (index: number): number => {
        const value = operands[operands.length - index];
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    };

    while (!parser.atEnd()) {
        const before = parser.pos;
        const c = content[parser.pos];

        if (isOperandStart(c)) {
            operands.push(parser.parseValue());
            if (operands.length > 64) { operands.shift(); }
            if (parser.pos === before) { parser.pos++; }
            continue;
        }

        const op = parser.readKeyword();
        if (parser.pos === before) { parser.pos++; continue; }

        switch (op) {
            case 'q': stack.push(cloneState(state)); break;
            case 'Q': { const restored = stack.pop(); if (restored) { state = restored; } break; }
            case 'cm':
                state.ctm = multiply([num(6), num(5), num(4), num(3), num(2), num(1)], state.ctm);
                break;

            case 'BT': textMatrix = IDENTITY; lineMatrix = IDENTITY; break;
            case 'ET': break;

            case 'Tf': {
                state.fontSize = num(1);
                const fontName = nameOf(operands[operands.length - 2]);
                state.font = fontName ? lookupFont(doc, resources, fontName, fontCache) : undefined;
                break;
            }
            case 'Tc': state.charSpacing = num(1); break;
            case 'Tw': state.wordSpacing = num(1); break;
            case 'Tz': state.horizontalScale = num(1) / 100; break;
            case 'TL': state.leading = num(1); break;
            case 'Ts': state.rise = num(1); break;
            case 'Tr': state.renderMode = num(1); break;

            case 'Td':
                lineMatrix = multiply([1, 0, 0, 1, num(2), num(1)], lineMatrix);
                textMatrix = lineMatrix;
                break;
            case 'TD':
                state.leading = -num(1);
                lineMatrix = multiply([1, 0, 0, 1, num(2), num(1)], lineMatrix);
                textMatrix = lineMatrix;
                break;
            case 'Tm':
                lineMatrix = [num(6), num(5), num(4), num(3), num(2), num(1)];
                textMatrix = lineMatrix;
                break;
            case 'T*':
                lineMatrix = multiply([1, 0, 0, 1, 0, -state.leading], lineMatrix);
                textMatrix = lineMatrix;
                break;

            case 'Tj':
            case "'":
            case '"': {
                if (op !== 'Tj') {
                    if (op === '"') { state.wordSpacing = num(3); state.charSpacing = num(2); }
                    lineMatrix = multiply([1, 0, 0, 1, 0, -state.leading], lineMatrix);
                    textMatrix = lineMatrix;
                }
                const value = operands[operands.length - 1];
                if (value instanceof PdfString) {
                    textMatrix = showText(state, textMatrix, value.bytes, result);
                }
                break;
            }
            case 'TJ': {
                const items = arrayOf(operands[operands.length - 1]);
                for (const item of items) {
                    if (item instanceof PdfString) {
                        textMatrix = showText(state, textMatrix, item.bytes, result);
                    } else if (typeof item === 'number') {
                        const shift = (-item / 1000) * state.fontSize * state.horizontalScale;
                        textMatrix = multiply([1, 0, 0, 1, shift, 0], textMatrix);
                    }
                }
                break;
            }

            case 'Do': {
                const xobjectName = nameOf(operands[operands.length - 1]);
                if (xobjectName) {
                    drawXObject(doc, xobjectName, resources, state, result, depth);
                }
                break;
            }

            case 'BI':
                skipInlineImage(parser, content);
                break;

            default:
                break;
        }
        operands.length = 0;
        if (result.chunks.length > MAX_CHUNKS) { return; }
    }
}

/** Islec degil de islenen (operand) baslangici mi? */
function isOperandStart(c: number): boolean {
    return c === 0x2f || c === 0x28 || c === 0x5b || c === 0x3c
        || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e;
}

/**
 * Metni "gosterir": her glif icin konum hesaplanir, metin dizeye eklenir ve
 * metin dizeyi ilerletilir. Ciktisi tek bir metin parcasidir.
 */
function showText(state: GraphicsState, textMatrix: Matrix, bytes: Buffer, result: ContentResult): Matrix {
    if (!state.font || state.fontSize === 0) { return textMatrix; }
    // Kirpma amacli gorunmez metin (mod 7) atlanir; mod 3 (gorunmez) OCR katmanidir, alinir.
    if (state.renderMode === 7) { return textMatrix; }

    const glyphs = decodeGlyphs(state.font, bytes);
    let matrix = textMatrix;
    let text = '';
    let startX: number | undefined;
    let startY = 0;
    let size = 0;
    let endX = 0;

    for (const glyph of glyphs) {
        const trm = multiply(
            [state.fontSize * state.horizontalScale, 0, 0, state.fontSize, 0, state.rise],
            multiply(matrix, state.ctm)
        );
        if (startX === undefined) {
            startX = trm[4];
            startY = trm[5];
            size = Math.hypot(trm[2], trm[3]) || state.fontSize;
        }
        text += glyph.text;

        const isSpaceCode = glyph.code === 32 && state.font.byteLength === 1;
        const advance = (glyph.width * state.fontSize + state.charSpacing + (isSpaceCode ? state.wordSpacing : 0))
            * state.horizontalScale;
        matrix = multiply([1, 0, 0, 1, advance, 0], matrix);
        endX = multiply([state.fontSize * state.horizontalScale, 0, 0, state.fontSize, 0, state.rise],
            multiply(matrix, state.ctm))[4];
    }

    if (startX !== undefined && text !== '') {
        result.chunks.push({ x: startX, y: startY, size, endX, text });
    }
    return matrix;
}

function lookupFont(
    doc: PdfDocument, resources: PdfDict | undefined, name: string, cache: Map<string, PdfFont>
): PdfFont | undefined {
    const cached = cache.get(name);
    if (cached) { return cached; }
    const fonts = dictOf(doc.resolve(resources?.get('Font') ?? null));
    const fontDict = dictOf(doc.resolve(fonts?.get(name) ?? null));
    if (!fontDict) { return undefined; }
    const font = loadFont(doc, fontDict);
    cache.set(name, font);
    return font;
}

function drawXObject(
    doc: PdfDocument, name: string, resources: PdfDict | undefined, state: GraphicsState,
    result: ContentResult, depth: number
): void {
    const xobjects = dictOf(doc.resolve(resources?.get('XObject') ?? null));
    const target = doc.resolve(xobjects?.get(name) ?? null);
    if (!isStream(target)) { return; }

    const subtype = nameOf(doc.resolve(target.dict.get('Subtype') ?? null));
    if (subtype === 'Image') {
        const ctm = state.ctm;
        result.images.push({
            stream: target,
            x: ctm[4],
            y: ctm[5],
            width: Math.hypot(ctm[0], ctm[1]),
            height: Math.hypot(ctm[2], ctm[3]),
        });
        return;
    }
    if (subtype !== 'Form') { return; }

    const matrixValues = arrayOf(doc.resolve(target.dict.get('Matrix') ?? null))
        .map((v) => numberOf(doc.resolve(v)) ?? 0);
    const formMatrix: Matrix = matrixValues.length === 6
        ? [matrixValues[0], matrixValues[1], matrixValues[2], matrixValues[3], matrixValues[4], matrixValues[5]]
        : IDENTITY;

    const decoded = doc.decode(target);
    if (decoded.error || decoded.data.length === 0) { return; }
    const formResources = dictOf(doc.resolve(target.dict.get('Resources') ?? null)) ?? resources;
    execute(doc, decoded.data, formResources, multiply(formMatrix, state.ctm), result, depth + 1);
}

/**
 * Satir ici gorseli (BI ... ID <ikili veri> EI) atlar.
 *
 * Ikili veri sozdizimini bozabilecegi icin `EI` yalnizca bosluklarla cevrili
 * oldugunda gecerli sayilir.
 */
function skipInlineImage(parser: Parser, content: Buffer): void {
    const idIndex = content.indexOf('ID', parser.pos, 'latin1');
    if (idIndex < 0) { parser.pos = content.length; return; }
    let pos = idIndex + 2;
    if (isWhite(content[pos])) { pos++; }

    while (pos < content.length) {
        const found = content.indexOf('EI', pos, 'latin1');
        if (found < 0) { parser.pos = content.length; return; }
        const before = content[found - 1];
        const after = content[found + 2];
        if (isWhite(before) && (after === undefined || !isRegular(after))) {
            parser.pos = found + 2;
            return;
        }
        pos = found + 2;
    }
    parser.pos = content.length;
}

export { PdfName };
