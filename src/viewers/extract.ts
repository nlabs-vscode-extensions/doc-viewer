import type { Block, DocModel, Run, SheetModel } from '../core/types';

/** Belge modelini duz metne cevirir (metin disa aktarimi ve panoya kopyalama icin). */
export function modelToText(model: DocModel): string {
    if (model.pages) { return pdfToText(model); }
    if (model.blocks) { return blocksToText(model.blocks, 0).join('\n'); }
    if (model.sheets) { return model.sheets.map(sheetToText).join('\n\n'); }
    // JSONL: her kayit tek satir JSON olarak geri yazilir - kaynak bicimle ayni.
    if (model.json) { return model.json.records.map((record) => JSON.stringify(record)).join('\n'); }
    return '';
}

function pdfToText(model: DocModel): string {
    const parts: string[] = [];
    for (const page of model.pages ?? []) {
        parts.push(`--- ${page.number} ---`);
        for (const line of page.lines) { parts.push(line.text); }
        parts.push('');
    }
    return parts.join('\n');
}

function blocksToText(blocks: Block[], depth: number): string[] {
    const out: string[] = [];
    const indent = '  '.repeat(depth);
    for (const block of blocks) {
        switch (block.t) {
            case 'heading':
                out.push('', `${'#'.repeat(Math.min(6, block.level))} ${runsToText(block.runs)}`, '');
                break;
            case 'para': {
                const marker = block.list ? `${block.list.marker} ` : '';
                out.push(indent + marker + runsToText(block.runs));
                break;
            }
            case 'table':
                for (const row of block.rows) {
                    out.push(indent + row.map((cell) => blocksToText(cell.blocks, 0).join(' ').trim()).join('\t'));
                }
                out.push('');
                break;
            case 'image':
                out.push(`${indent}[${block.alt ?? 'gorsel'}]`);
                break;
            case 'rule':
                out.push(`${indent}---`);
                break;
            case 'pagebreak':
                out.push('', '---', '');
                break;
        }
    }
    return out;
}

function runsToText(runs: Run[]): string {
    return runs.map((run) => run.text).join('').replace(/\s+$/, '');
}

function sheetToText(sheet: SheetModel): string {
    const header = `# ${sheet.name}`;
    const rows = sheet.rows.map((row) => row.map((cell) => cell?.v ?? '').join('\t').replace(/\t+$/, ''));
    return [header, ...rows].join('\n');
}
