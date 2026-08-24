import * as vscode from 'vscode';
import type { ParseLimits } from './limits';
import type { ViewerSettings } from './types';

const SECTION = 'nlabsDoc';

function config(scope?: vscode.Uri): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SECTION, scope ?? null);
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) { return fallback; }
    return Math.min(max, Math.max(min, value));
}

export function readViewerSettings(scope?: vscode.Uri): ViewerSettings {
    const cfg = config(scope);
    return {
        theme: cfg.get<ViewerSettings['theme']>('theme', 'paper'),
        showImages: cfg.get<boolean>('showImages', true),
        pdfTextLayout: cfg.get<ViewerSettings['pdfTextLayout']>('pdf.textLayout', 'columns'),
    };
}

export function readParseLimits(scope?: vscode.Uri): ParseLimits {
    const cfg = config(scope);
    return {
        maxTotalUncompressed: clamp(cfg.get<number>('zip.maxUncompressedMb'), 1, 4096, 512) * 1024 * 1024,
        maxRatio: clamp(cfg.get<number>('zip.maxCompressionRatio'), 10, 10000, 200),
        maxRows: clamp(cfg.get<number>('sheet.maxRows'), 100, 200000, 5000),
        maxColumns: clamp(cfg.get<number>('sheet.maxColumns'), 10, 16384, 200),
        csvDelimiter: cfg.get<ParseLimits['csvDelimiter']>('csv.delimiter', 'auto'),
        showImages: cfg.get<boolean>('showImages', true),
    };
}

/** Acilabilecek en buyuk dosya (bayt). Bellek tukenmesine karsi ilk bariyer. */
export function maxFileSizeBytes(scope?: vscode.Uri): number {
    return clamp(config(scope).get<number>('maxFileSizeMb'), 1, 2048, 100) * 1024 * 1024;
}

export function configuredLanguage(): string {
    return config().get<string>('language', 'auto');
}

export function onSettingsChanged(handler: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(SECTION)) { handler(); }
    });
}
