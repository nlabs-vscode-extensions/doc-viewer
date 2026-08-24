import type { ZipArchive } from '../zip/zip';
import { child, textOf } from '../xml/xml';
import type { MetaEntry } from '../core/types';
import { readXml } from './ooxml';

/** `docProps/core.xml` ve `docProps/app.xml` icindeki belge ustverisi. */

const CORE_FIELDS: [string, string][] = [
    ['title', 'title'],
    ['subject', 'subject'],
    ['creator', 'author'],
    ['lastModifiedBy', 'lastModifiedBy'],
    ['keywords', 'keywords'],
    ['description', 'description'],
    ['created', 'created'],
    ['modified', 'modified'],
];

const APP_FIELDS: [string, string][] = [
    ['Application', 'application'],
    ['Company', 'company'],
    ['Pages', 'pages'],
    ['Words', 'words'],
    ['Paragraphs', 'paragraphs'],
];

export function readCoreProperties(zip: ZipArchive): MetaEntry[] {
    const out: MetaEntry[] = [];
    const core = readXml(zip, 'docProps/core.xml');
    if (core) {
        for (const [tag, key] of CORE_FIELDS) {
            const value = textOf(child(core, tag)).trim();
            if (value) { out.push({ key, value: normalizeDate(key, value) }); }
        }
    }
    const app = readXml(zip, 'docProps/app.xml');
    if (app) {
        for (const [tag, key] of APP_FIELDS) {
            const value = textOf(child(app, tag)).trim();
            if (value && value !== '0') { out.push({ key, value }); }
        }
    }
    return out;
}

/** ISO zaman damgasini saniye hassasiyetinde, saat dilimi eki olmadan gosterir. */
function normalizeDate(key: string, value: string): string {
    if (key !== 'created' && key !== 'modified') { return value; }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) { return value; }
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
