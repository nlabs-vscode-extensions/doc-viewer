/**
 * Eklenti host'u ile webview arasindaki tek sozlesme.
 *
 * Ayristirma tamamen host tarafinda yapilir; webview yalnizca bu modeli DOM API'si
 * ile cizer (innerHTML kullanilmaz). Boylece belge icerigi hicbir zaman HTML olarak
 * yorumlanmaz - bicimlerin tasidigi metin, isaretleme degil veridir.
 */

export type DocKind = 'pdf' | 'word' | 'sheet' | 'csv' | 'markdown' | 'jsonl';

export const VIEW_TYPE: Record<DocKind, string> = {
    pdf: 'nlabs.docViewer.pdf',
    word: 'nlabs.docViewer.word',
    sheet: 'nlabs.docViewer.sheet',
    csv: 'nlabs.docViewer.csv',
    markdown: 'nlabs.docViewer.markdown',
    jsonl: 'nlabs.docViewer.jsonl',
};

/** Uzanti (nokta dahil, kucuk harf) -> belge ailesi. package.json selector'lari ile ayni kume. */
export const EXTENSION_KIND: Record<string, DocKind> = {
    '.pdf': 'pdf',
    '.docx': 'word',
    '.dotx': 'word',
    '.docm': 'word',
    '.xlsx': 'sheet',
    '.xlsm': 'sheet',
    '.xltx': 'sheet',
    '.csv': 'csv',
    '.tsv': 'csv',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.mdown': 'markdown',
    '.jsonl': 'jsonl',
    '.ndjson': 'jsonl',
    '.json': 'jsonl',
    '.geojson': 'jsonl',
};

export function kindForPath(fsPath: string): DocKind | undefined {
    const dot = fsPath.lastIndexOf('.');
    if (dot < 0) { return undefined; }
    return EXTENSION_KIND[fsPath.slice(dot).toLowerCase()];
}

/** Bicimlendirilmis metin parcasi. */
export interface Run {
    text: string;
    b?: 1;
    i?: 1;
    u?: 1;
    s?: 1;
    sup?: 1;
    sub?: 1;
    mono?: 1;
    /** #rrggbb */
    color?: string;
    /** #rrggbb - vurgu/arka plan */
    bg?: string;
    /** punto */
    size?: number;
    /** Kopyalanabilir baglanti hedefi; webview onu tiklanabilir yapmaz, yalnizca gosterir. */
    link?: string;
    /** Satir ici gorsel kimligi (Markdown). Varsa parca metin yerine gorsel cizilir. */
    img?: string;
}

export interface ListInfo {
    kind: 'bullet' | 'number';
    level: number;
    marker: string;
}

export interface TableCell {
    blocks: Block[];
    colSpan?: number;
    rowSpan?: number;
    header?: 1;
}

export type Block =
    | { t: 'heading'; level: number; runs: Run[] }
    | { t: 'para'; runs: Run[]; align?: 'left' | 'center' | 'right' | 'justify'; indent?: number; list?: ListInfo }
    | { t: 'table'; rows: TableCell[][] }
    | { t: 'image'; id: string; w?: number; h?: number; alt?: string }
    | { t: 'code'; text: string; lang?: string }
    | { t: 'quote'; blocks: Block[] }
    | { t: 'rule' }
    | { t: 'pagebreak' };

/** Hucre degeri. `v` her zaman gosterilecek metindir; `raw` siralama/hizalama icin. */
export interface SheetCell {
    v: string;
    /** number | string | bool | date | error | formula-sonucu */
    t?: 'n' | 's' | 'b' | 'd' | 'e';
    b?: 1;
    i?: 1;
    align?: 'l' | 'c' | 'r';
    color?: string;
    bg?: string;
    /** Formul metni (varsa), ipucu olarak gosterilir. */
    f?: string;
    /** Birlestirilmis hucre genisligi/yuksekligi. */
    cs?: number;
    rs?: number;
}

export interface SheetModel {
    name: string;
    rows: (SheetCell | null)[][];
    /** Dosyadaki gercek satir/sutun sayisi (kirpma oncesi). */
    totalRows: number;
    totalCols: number;
    truncated: boolean;
    /** Ilk satir baslik gibi davransin mi (CSV icin sezgisel). */
    headerRow?: 1;
    /** Sutun genislikleri (Excel karakter birimi). */
    colWidths?: number[];
}

/** PDF sayfasindaki tek bir metin satiri; koordinatlar PDF birimi (1/72 inc), sol-alt orijinli. */
export interface PdfLine {
    x: number;
    y: number;
    size: number;
    text: string;
}

export interface PdfPageModel {
    number: number;
    width: number;
    height: number;
    lines: PdfLine[];
    /** Sayfada gecen gomulu gorsellerin kimlikleri. */
    images: string[];
    /** Bu sayfa cozulemedi ise nedeni. */
    error?: string;
}

/** Satir-basina-JSON (JSONL/NDJSON) kayit kumesi. */
export interface JsonRecordSet {
    /** Ayristirilmis kayitlar. Webview agaci bunlardan cizer. */
    records: unknown[];
    totalRecords: number;
    truncated: boolean;
    /** Ayristirilamayan satirlarin 1 tabanli numaralari. */
    invalidLines: number[];
    /** Kayitlarda en sik gorulen ust duzey anahtarlar - ozet satiri icin. */
    labelKeys: string[];
}

export interface OutlineNode {
    title: string;
    page?: number;
    children: OutlineNode[];
}

export interface MetaEntry {
    key: string;
    value: string;
}

/** Gomulu gorsel. Veri base64'tur; webview data: URI olarak baglar. */
export interface EmbeddedImage {
    id: string;
    mime: string;
    base64: string;
    width?: number;
    height?: number;
    /** Disari cikarirken kullanilacak dosya adi onerisi. */
    name: string;
    /** Belgedeki alternatif metin (varsa). */
    alt?: string;
}

/** Webview'e gonderilen tam belge modeli. */
export interface DocModel {
    kind: DocKind;
    name: string;
    meta: MetaEntry[];
    warnings: string[];
    images: EmbeddedImage[];
    blocks?: Block[];
    sheets?: SheetModel[];
    pages?: PdfPageModel[];
    outline?: OutlineNode[];
    json?: JsonRecordSet;
}

/** "Hakkinda" panelinde gosterilen uygulama kimligi; package.json'dan okunur. */
export interface AppInfo {
    name: string;
    version: string;
    publisher: string;
    license: string;
    repository: string;
    /** Calisma anindaki ucuncu-parti bagimlilik sayisi - urun vaadi bu sayinin sifir olmasi. */
    runtimeDependencies: number;
    formats: string[];
}

export interface ViewerSettings {
    theme: 'auto' | 'paper' | 'sepia' | 'editor';
    showImages: boolean;
    pdfTextLayout: 'columns' | 'reading';
}

/** Webview -> host */
export type InboundMessage =
    | { type: 'ready' }
    | { type: 'openExternal' }
    | { type: 'extractImages' }
    | { type: 'extractText' }
    | { type: 'saveViewState'; state: unknown }
    | { type: 'setTheme'; theme: string }
    | { type: 'openLink'; url: string }
    | { type: 'openSettings' }
    | { type: 'error'; message: string };

/** Host -> webview */
export type OutboundMessage =
    | { type: 'loading'; strings: Record<string, string> }
    | { type: 'document'; model: DocModel; settings: ViewerSettings; app: AppInfo; strings: Record<string, string>; viewState: unknown }
    | { type: 'failure'; message: string; detail?: string; strings: Record<string, string> }
    | { type: 'settings'; settings: ViewerSettings; app: AppInfo; strings: Record<string, string> };

/** Ayristiricilarin firlattigi, kullaniciya gosterilebilir hata. */
export class DocumentError extends Error {
    constructor(message: string, readonly detail?: string) {
        super(message);
        this.name = 'DocumentError';
    }
}
