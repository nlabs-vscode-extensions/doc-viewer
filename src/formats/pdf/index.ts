import type { ParseLimits } from '../../core/limits';
import { MAX_IMAGE_COUNT, MAX_TOTAL_IMAGE_BYTES } from '../../core/limits';
import { imageSize } from '../../core/imageinfo';
import type { DocModel, EmbeddedImage, MetaEntry, OutlineNode, PdfLine, PdfPageModel } from '../../core/types';
import { DocumentError } from '../../core/types';
import { PdfDocument, formatPdfDate, pageContent, pageSize } from './document';
import { runContent, type Matrix, type TextChunk } from './content';
import { extractImage } from './images';
import { arrayOf, decodePdfString, dictOf, isStream, nameOf, numberOf, PdfString, type PdfDict, type PdfStream, type PdfValue } from './objects';

/**
 * PDF -> belge modeli.
 *
 * Bu urun PDF sayfalarini PIKSEL DOGRULUKLA CIZMEZ; bu bilincli bir karardir.
 * Sayfa render'i icin gereken kutuphane yigini (yazi tipi programi, JPEG2000,
 * CCITT, renk yonetimi) tam olarak kaldirmak istedigimiz saldiri yuzeyidir.
 * Bunun yerine metin, gomulu gorseller ve belge yapisi cikarilir.
 */

const MAX_PAGES = 5000;

export function parsePdf(buf: Buffer, name: string, limits: ParseLimits): DocModel {
    const doc = PdfDocument.open(buf);

    if (doc.encryptDict()) {
        throw new DocumentError(
            'Bu PDF sifrelenmis (parola korumali). nLabs Document Viewer sifreli PDF acmaz.',
            'Belgeyi sistem uygulamasinda acabilir veya korumasiz bir kopyasini kullanabilirsiniz.'
        );
    }

    const pages = doc.pages();
    if (pages.length === 0) {
        throw new DocumentError('PDF icinde sayfa bulunamadi.');
    }

    const warnings = [...doc.warnings];
    if (pages.length > MAX_PAGES) {
        warnings.push(`Sayfa sayisi ${pages.length}; ilk ${MAX_PAGES} sayfa gosteriliyor.`);
    }

    const store: ImageStore = { images: [], cache: new Map(), bytes: 0 };

    const pageModels: PdfPageModel[] = [];
    const limit = Math.min(pages.length, MAX_PAGES);
    for (let index = 0; index < limit; index++) {
        const page = pages[index];
        const { width, height, rotate } = pageSize(doc, page);
        const model: PdfPageModel = { number: index + 1, width, height, lines: [], images: [] };

        try {
            const content = pageContent(doc, page);
            if (content.length > 0) {
                const resources = dictOf(doc.resolve(page.get('Resources') ?? null));
                const result = runContent(doc, content, resources, baseMatrix(doc, page, rotate));
                model.lines = assembleLines(result.chunks, height);

                if (limits.showImages) {
                    for (const placement of result.images) {
                        if (store.images.length >= MAX_IMAGE_COUNT || store.bytes > MAX_TOTAL_IMAGE_BYTES) { break; }
                        const id = imageIdFor(doc, placement.stream, store, warnings);
                        if (id && !model.images.includes(id)) { model.images.push(id); }
                    }
                }
            }
        } catch (err) {
            model.error = (err as Error).message;
            warnings.push(`Sayfa ${index + 1} okunamadi: ${model.error}`);
        }
        pageModels.push(model);
    }

    return {
        kind: 'pdf',
        name,
        meta: readMetadata(doc, pages.length),
        warnings,
        images: store.images,
        pages: pageModels,
        outline: readOutline(doc, pages),
    };
}

/**
 * Gorseli bir kez cikarir ve kimligini onbelleger.
 * Cozulemeyen gorseller null olarak isaretlenir; ayni gorsel tekrar denenmez.
 */
interface ImageStore {
    images: EmbeddedImage[];
    cache: Map<PdfStream, string | null>;
    bytes: number;
}

function imageIdFor(
    doc: PdfDocument, stream: PdfStream, store: ImageStore, warnings: string[]
): string | undefined {
    const { cache, images } = store;
    const cached = cache.get(stream);
    if (cached !== undefined) { return cached ?? undefined; }

    const extracted = extractImage(doc, stream);
    if ('reason' in extracted) {
        cache.set(stream, null);
        warnings.push(`Gorsel cikarilamadi: ${extracted.reason}`);
        return undefined;
    }

    const id = `img${images.length + 1}`;
    const size = imageSize(extracted.data);
    images.push({
        id,
        mime: extracted.mime,
        base64: extracted.data.toString('base64'),
        width: size?.width ?? extracted.width,
        height: size?.height ?? extracted.height,
        name: `${id}.${extracted.mime === 'image/jpeg' ? 'jpg' : 'png'}`,
    });
    store.bytes += extracted.data.length;
    cache.set(stream, id);
    return id;
}

/**
 * Kullanici uzayindan dik (upright) sayfa uzayina donusum.
 * MediaBox kaymasi ve /Rotate burada uygulanir; sonrasindaki tum koordinatlar
 * sol-alt orijinli ve donmus sayfaya goredir.
 */
function baseMatrix(doc: PdfDocument, page: PdfDict, rotate: number): Matrix {
    const box = arrayOf(doc.resolve(page.get('CropBox') ?? page.get('MediaBox') ?? null))
        .map((v) => numberOf(doc.resolve(v)) ?? 0);
    const x0 = box.length === 4 ? Math.min(box[0], box[2]) : 0;
    const y0 = box.length === 4 ? Math.min(box[1], box[3]) : 0;
    const w = box.length === 4 ? Math.abs(box[2] - box[0]) : 612;
    const h = box.length === 4 ? Math.abs(box[3] - box[1]) : 792;

    const translate: Matrix = [1, 0, 0, 1, -x0, -y0];
    let rotation: Matrix;
    switch (rotate) {
        case 90: rotation = [0, -1, 1, 0, 0, w]; break;
        case 180: rotation = [-1, 0, 0, -1, w, h]; break;
        case 270: rotation = [0, 1, -1, 0, h, 0]; break;
        default: return translate;
    }
    return [
        translate[0] * rotation[0] + translate[1] * rotation[2],
        translate[0] * rotation[1] + translate[1] * rotation[3],
        translate[2] * rotation[0] + translate[3] * rotation[2],
        translate[2] * rotation[1] + translate[3] * rotation[3],
        translate[4] * rotation[0] + translate[5] * rotation[2] + rotation[4],
        translate[4] * rotation[1] + translate[5] * rotation[3] + rotation[5],
    ];
}

/**
 * Metin parcalarini satirlara toplar.
 *
 * PDF metni sayfaya parca parca ve rastgele sirada dusebilir. Ayni taban cizgisine
 * (baseline) yakin parcalar bir satir sayilir, x'e gore siralanir ve aralarindaki
 * bosluga bakilarak bosluk karakteri eklenir. y, ust-orijinli sisteme cevrilir.
 */
export function assembleLines(chunks: TextChunk[], pageHeight: number): PdfLine[] {
    if (chunks.length === 0) { return []; }

    const sorted = [...chunks].sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const groups: TextChunk[][] = [];
    let current: TextChunk[] = [sorted[0]];
    let baseline = sorted[0].y;
    let baseSize = sorted[0].size || 10;

    for (let i = 1; i < sorted.length; i++) {
        const chunk = sorted[i];
        const tolerance = Math.max(1, Math.min(baseSize, chunk.size || baseSize) * 0.45);
        if (Math.abs(chunk.y - baseline) <= tolerance) {
            current.push(chunk);
        } else {
            groups.push(current);
            current = [chunk];
            baseline = chunk.y;
            baseSize = chunk.size || 10;
        }
    }
    groups.push(current);

    const lines: PdfLine[] = [];
    for (const group of groups) {
        group.sort((a, b) => a.x - b.x);
        let text = '';
        let previous: TextChunk | undefined;
        for (const chunk of group) {
            if (previous) {
                const gap = chunk.x - previous.endX;
                const size = Math.max(chunk.size, previous.size) || 10;
                if (gap > size * 0.22 && !text.endsWith(' ') && !chunk.text.startsWith(' ')) {
                    text += ' ';
                }
            }
            text += chunk.text;
            previous = chunk;
        }
        text = text.replace(/[ \t]+/g, ' ').trim();
        if (!text) { continue; }
        const first = group[0];
        lines.push({
            x: round(first.x),
            y: round(pageHeight - first.y),
            size: round(first.size || 10),
            text,
        });
    }
    return lines;
}

function round(value: number): number {
    return Math.round(value * 10) / 10;
}

const INFO_FIELDS: [string, string][] = [
    ['Title', 'title'],
    ['Author', 'author'],
    ['Subject', 'subject'],
    ['Keywords', 'keywords'],
    ['Creator', 'creator'],
    ['Producer', 'producer'],
];

function readMetadata(doc: PdfDocument, pageCount: number): MetaEntry[] {
    const out: MetaEntry[] = [{ key: 'pages', value: String(pageCount) }];
    const info = doc.infoDict();
    if (!info) { return out; }

    for (const [key, label] of INFO_FIELDS) {
        const value = doc.resolve(info.get(key) ?? null);
        if (value instanceof PdfString) {
            const text = decodePdfString(value).trim();
            if (text) { out.push({ key: label, value: text }); }
        }
    }
    for (const [key, label] of [['CreationDate', 'created'], ['ModDate', 'modified']] as [string, string][]) {
        const formatted = formatPdfDate(doc.resolve(info.get(key) ?? null));
        if (formatted) { out.push({ key: label, value: formatted }); }
    }
    return out;
}

/** Yer imi agaci. Hedef sayfa cozulemezse dugum sayfasiz kalir. */
function readOutline(doc: PdfDocument, pages: PdfDict[]): OutlineNode[] | undefined {
    const outlines = dictOf(doc.resolve(doc.catalog()?.get('Outlines') ?? null));
    if (!outlines) { return undefined; }

    const pageIndex = new Map<PdfDict, number>();
    pages.forEach((page, index) => pageIndex.set(page, index + 1));

    const visited = new Set<PdfDict>();
    const walk = (first: PdfValue, depth: number): OutlineNode[] => {
        const out: OutlineNode[] = [];
        let node = dictOf(doc.resolve(first));
        let guard = 0;
        while (node && depth < 8 && guard++ < 5000) {
            if (visited.has(node)) { break; }
            visited.add(node);

            const titleValue = doc.resolve(node.get('Title') ?? null);
            const title = titleValue instanceof PdfString ? decodePdfString(titleValue).trim() : '';
            if (title) {
                out.push({
                    title,
                    page: destinationPage(doc, node, pageIndex),
                    children: walk(node.get('First') ?? null, depth + 1),
                });
            }
            node = dictOf(doc.resolve(node.get('Next') ?? null));
        }
        return out;
    };

    const tree = walk(outlines.get('First') ?? null, 0);
    return tree.length ? tree : undefined;
}

/** /Dest veya /A /D icindeki hedeften sayfa numarasini cozer. Adlandirilmis hedefler atlanir. */
function destinationPage(doc: PdfDocument, node: PdfDict, pageIndex: Map<PdfDict, number>): number | undefined {
    let dest = doc.resolve(node.get('Dest') ?? null);
    if (dest === null) {
        const action = dictOf(doc.resolve(node.get('A') ?? null));
        if (action && nameOf(doc.resolve(action.get('S') ?? null)) === 'GoTo') {
            dest = doc.resolve(action.get('D') ?? null);
        }
    }
    const target = Array.isArray(dest) ? doc.resolve(dest[0]) : null;
    const page = dictOf(target);
    return page ? pageIndex.get(page) : undefined;
}

export { isStream };
