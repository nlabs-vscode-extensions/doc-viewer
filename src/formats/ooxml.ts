import { ZipArchive } from '../zip/zip';
import { parseXml, attr, descendants, type XmlNode } from '../xml/xml';
import { imageSize } from '../core/imageinfo';
import type { ParseLimits } from '../core/limits';
import { MAX_IMAGE_BYTES, MAX_IMAGE_COUNT, MAX_TOTAL_IMAGE_BYTES } from '../core/limits';
import type { EmbeddedImage } from '../core/types';
import { DocumentError } from '../core/types';

/** Word ve Excel ayristiricilarinin paylastigi OOXML yardimcilari. */

const IMAGE_MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    bmp: 'image/bmp',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    emf: 'image/emf',
    wmf: 'image/wmf',
};

/** Webview'de gosterilebilen bicimler; digerleri yalnizca disari cikarilabilir. */
export const RENDERABLE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp']);

export function openContainer(buf: Buffer, limits: ParseLimits): ZipArchive {
    const looksZip = buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b;
    if (looksZip && buf.length < 100) {
        throw new DocumentError('Dosya kesik veya bos bir ZIP kapsayicisi (' + buf.length + ' bayt).');
    }
    if (!looksZip) {
        throw new DocumentError('Bu dosya bir OOXML (ZIP) kapsayicisi degil. Eski .doc/.xls bicimi desteklenmiyor.');
    }
    return ZipArchive.open(buf, {
        maxTotalUncompressed: limits.maxTotalUncompressed,
        maxRatio: limits.maxRatio,
    });
}

export function readXml(zip: ZipArchive, path: string): XmlNode | undefined {
    const text = zip.readText(path);
    return text === undefined ? undefined : parseXml(text);
}

/** `_rels/*.rels` dosyasindan rId -> hedef yol esleme. Hedefler kaynak klasore gore cozulur. */
export function readRelationships(zip: ZipArchive, partPath: string): Map<string, string> {
    const slash = partPath.lastIndexOf('/');
    const dir = slash < 0 ? '' : partPath.slice(0, slash);
    const relPath = `${dir ? dir + '/' : ''}_rels/${partPath.slice(slash + 1)}.rels`;
    const map = new Map<string, string>();
    const root = readXml(zip, relPath);
    if (!root) { return map; }
    for (const rel of descendants(root, 'Relationship')) {
        const id = attr(rel, 'Id');
        const target = attr(rel, 'Target');
        const mode = attr(rel, 'TargetMode');
        if (!id || !target) { continue; }
        // Harici hedefler (TargetMode="External") dosya icermez; yalnizca URL olarak tasinir.
        map.set(id, mode === 'External' ? target : resolvePart(dir, target));
    }
    return map;
}

/** Goreli parca yolunu arsiv kokune gore normalize eder; `..` disari cikamaz. */
export function resolvePart(baseDir: string, target: string): string {
    if (target.startsWith('/')) { return target.slice(1); }
    const parts = (baseDir ? baseDir.split('/') : []).concat(target.split('/'));
    const out: string[] = [];
    for (const part of parts) {
        if (part === '' || part === '.') { continue; }
        if (part === '..') { out.pop(); continue; }
        out.push(part);
    }
    return out.join('/');
}

export function mimeForPath(path: string): string {
    const dot = path.lastIndexOf('.');
    const ext = dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
    return IMAGE_MIME[ext] ?? 'application/octet-stream';
}

export interface ImageCollection {
    images: EmbeddedImage[];
    /** Arsiv yolu -> gorsel kimligi. */
    byPath: Map<string, string>;
    warnings: string[];
}

/**
 * Kapsayicidaki gomulu gorselleri toplar.
 *
 * Gomulu gorsel cikarma bu urunun birinci sinif ozelligidir: gosterilemeyen
 * bicimler (EMF/WMF/TIFF) de modele alinir, yalnizca cizilmez - "Gorselleri
 * disari aktar" komutu onlari da diske yazar.
 */
export function collectImages(zip: ZipArchive, mediaPrefix: string, limits: ParseLimits): ImageCollection {
    const images: EmbeddedImage[] = [];
    const byPath = new Map<string, string>();
    const warnings: string[] = [];
    if (!limits.showImages) { return { images, byPath, warnings }; }

    let total = 0;
    let index = 0;
    for (const path of zip.names().sort()) {
        if (!path.startsWith(mediaPrefix)) { continue; }
        const mime = mimeForPath(path);
        if (mime === 'application/octet-stream') { continue; }

        const entry = zip.entry(path);
        if (!entry) { continue; }
        if (entry.uncompressedSize > MAX_IMAGE_BYTES) {
            warnings.push(`Gorsel atlandi (cok buyuk): ${path}`);
            continue;
        }
        if (total + entry.uncompressedSize > MAX_TOTAL_IMAGE_BYTES || images.length >= MAX_IMAGE_COUNT) {
            warnings.push('Gorsel siniri asildi; kalan gorseller atlandi.');
            break;
        }

        const data = zip.read(path);
        if (!data || data.length === 0) { continue; }
        total += data.length;

        const id = `img${++index}`;
        const size = imageSize(data);
        images.push({
            id,
            mime,
            base64: data.toString('base64'),
            width: size?.width,
            height: size?.height,
            name: path.slice(path.lastIndexOf('/') + 1),
        });
        byPath.set(path, id);
    }
    return { images, byPath, warnings };
}
