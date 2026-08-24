import { DocumentError } from '../core/types';

/**
 * Kucuk, bagimliliksiz XML ayristirici (OOXML parcalari icin).
 *
 * Bilerek desteklenmeyenler - hepsi guvenlik gerekcesiyle:
 *  - DTD / harici varlik (external entity) cozumleme  -> XXE yok
 *  - Ic varlik tanimi (ENTITY)                        -> "milyar kahkaha" (billion laughs) yok
 * `<!DOCTYPE ...>` ve `<!-- -->` yalnizca atlanir, islenmez.
 */

export interface XmlNode {
    /** Nitelenmis ad, or. "w:p" */
    name: string;
    /** On ek atilmis ad, or. "p" */
    local: string;
    attrs: Record<string, string>;
    children: XmlNode[];
    /** Dogrudan metin cocuklarinin birlesimi. */
    text: string;
}

const MAX_DEPTH = 256;
const MAX_NODES = 2_000_000;

export function parseXml(source: string): XmlNode {
    const parser = new Parser(source);
    return parser.parse();
}

class Parser {
    private pos = 0;
    private nodes = 0;

    constructor(private readonly src: string) {}

    parse(): XmlNode {
        const stack: XmlNode[] = [];
        let root: XmlNode | undefined;

        while (this.pos < this.src.length) {
            const lt = this.src.indexOf('<', this.pos);
            if (lt < 0) { break; }

            if (lt > this.pos && stack.length > 0) {
                const raw = this.src.slice(this.pos, lt);
                stack[stack.length - 1].text += decodeEntities(raw);
            }
            this.pos = lt;

            if (this.src.startsWith('<!--', this.pos)) { this.skipTo('-->'); continue; }
            if (this.src.startsWith('<![CDATA[', this.pos)) {
                const end = this.src.indexOf(']]>', this.pos);
                const stop = end < 0 ? this.src.length : end;
                if (stack.length > 0) {
                    stack[stack.length - 1].text += this.src.slice(this.pos + 9, stop);
                }
                this.pos = end < 0 ? this.src.length : end + 3;
                continue;
            }
            if (this.src.startsWith('<?', this.pos)) { this.skipTo('?>'); continue; }
            if (this.src.startsWith('<!', this.pos)) { this.skipDeclaration(); continue; }

            if (this.src.startsWith('</', this.pos)) {
                const end = this.src.indexOf('>', this.pos);
                this.pos = end < 0 ? this.src.length : end + 1;
                stack.pop();
                continue;
            }

            const node = this.readStartTag();
            if (++this.nodes > MAX_NODES) {
                throw new DocumentError('XML: dugum sayisi siniri asildi - belge bozuk veya asiri buyuk.');
            }
            if (stack.length > 0) {
                stack[stack.length - 1].children.push(node);
            } else if (!root) {
                root = node;
            }
            if (!node.selfClosing) {
                if (stack.length >= MAX_DEPTH) {
                    throw new DocumentError('XML: ic ice gecme derinligi siniri asildi.');
                }
                stack.push(node);
            }
        }

        if (!root) { throw new DocumentError('XML: kok eleman bulunamadi.'); }
        return root;
    }

    /** Ac etiketi okur. `selfClosing` yalnizca ayristirma sirasinda kullanilan ic bilgidir. */
    private readStartTag(): XmlNode & { selfClosing: boolean } {
        this.pos++; // '<'
        const nameStart = this.pos;
        while (this.pos < this.src.length && !isNameEnd(this.src.charCodeAt(this.pos))) { this.pos++; }
        const name = this.src.slice(nameStart, this.pos);
        const colon = name.indexOf(':');
        const node: XmlNode & { selfClosing: boolean } = {
            name,
            local: colon < 0 ? name : name.slice(colon + 1),
            attrs: {},
            children: [],
            text: '',
            selfClosing: false,
        };

        while (this.pos < this.src.length) {
            this.skipSpace();
            const ch = this.src[this.pos];
            if (ch === undefined) { break; }
            if (ch === '/') { node.selfClosing = true; this.pos++; continue; }
            if (ch === '>') { this.pos++; break; }

            const attrStart = this.pos;
            while (this.pos < this.src.length && !isAttrNameEnd(this.src.charCodeAt(this.pos))) { this.pos++; }
            const attrName = this.src.slice(attrStart, this.pos);
            if (!attrName) { this.pos++; continue; }
            this.skipSpace();
            if (this.src[this.pos] !== '=') { node.attrs[attrName] = ''; continue; }
            this.pos++;
            this.skipSpace();
            const quote = this.src[this.pos];
            if (quote === '"' || quote === "'") {
                this.pos++;
                const valueStart = this.pos;
                const end = this.src.indexOf(quote, this.pos);
                const stop = end < 0 ? this.src.length : end;
                node.attrs[attrName] = decodeEntities(this.src.slice(valueStart, stop));
                this.pos = stop + 1;
            } else {
                const valueStart = this.pos;
                while (this.pos < this.src.length && !isNameEnd(this.src.charCodeAt(this.pos))) { this.pos++; }
                node.attrs[attrName] = decodeEntities(this.src.slice(valueStart, this.pos));
            }
        }
        return node;
    }

    private skipSpace(): void {
        while (this.pos < this.src.length && isSpace(this.src.charCodeAt(this.pos))) { this.pos++; }
    }

    private skipTo(marker: string): void {
        const end = this.src.indexOf(marker, this.pos);
        this.pos = end < 0 ? this.src.length : end + marker.length;
    }

    /** `<!DOCTYPE ...>` ve benzeri bildirimleri, ic koseli parantez blogu dahil atlar. */
    private skipDeclaration(): void {
        let depth = 0;
        while (this.pos < this.src.length) {
            const ch = this.src[this.pos];
            if (ch === '[') { depth++; }
            else if (ch === ']') { depth--; }
            else if (ch === '>' && depth <= 0) { this.pos++; return; }
            this.pos++;
        }
    }
}

function isSpace(code: number): boolean {
    return code === 32 || code === 9 || code === 10 || code === 13;
}

function isNameEnd(code: number): boolean {
    return isSpace(code) || code === 62 /* > */ || code === 47 /* / */;
}

function isAttrNameEnd(code: number): boolean {
    return isNameEnd(code) || code === 61 /* = */;
}

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

/**
 * XML varliklarini cozer. Yalnizca bes yerlesik ad ve sayisal kacislar desteklenir;
 * tanimsiz varlik adlari oldugu gibi birakilir (harici varlik cozumleme YOK).
 */
export function decodeEntities(raw: string): string {
    if (!raw.includes('&')) { return raw; }
    return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
        if (body.charCodeAt(0) === 35 /* # */) {
            const hex = body[1] === 'x' || body[1] === 'X';
            const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
            if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) { return match; }
            try {
                return String.fromCodePoint(code);
            } catch {
                return match;
            }
        }
        return NAMED_ENTITIES[body] ?? match;
    });
}

/** Verilen yerel ada sahip ilk dogrudan cocuk. */
export function child(node: XmlNode | undefined, local: string): XmlNode | undefined {
    return node?.children.find((c) => c.local === local);
}

/** Verilen yerel ada sahip tum dogrudan cocuklar. */
export function childrenOf(node: XmlNode | undefined, local: string): XmlNode[] {
    return node ? node.children.filter((c) => c.local === local) : [];
}

/** Nitelenmis veya yerel ada gore oznitelik degeri. */
export function attr(node: XmlNode | undefined, local: string): string | undefined {
    if (!node) { return undefined; }
    const direct = node.attrs[local];
    if (direct !== undefined) { return direct; }
    for (const key of Object.keys(node.attrs)) {
        const colon = key.indexOf(':');
        if (colon >= 0 && key.slice(colon + 1) === local) { return node.attrs[key]; }
    }
    return undefined;
}

/** Alt agactaki tum metin. */
export function textOf(node: XmlNode | undefined): string {
    if (!node) { return ''; }
    let out = node.text;
    for (const c of node.children) { out += textOf(c); }
    return out;
}

/** Alt agacta verilen yerel ada sahip tum dugumler (derinlik oncelikli). */
export function descendants(node: XmlNode, local: string, out: XmlNode[] = []): XmlNode[] {
    for (const c of node.children) {
        if (c.local === local) { out.push(c); }
        descendants(c, local, out);
    }
    return out;
}
