import * as vscode from 'vscode';
import * as path from 'node:path';
import { maxFileSizeBytes, readParseLimits } from './core/config';
import { t } from './core/i18n';
import { DocumentError, VIEW_TYPE, kindForPath, type DocModel } from './core/types';
import { parseDocument } from './formats/parse';
import { DocumentViewerProvider, type OpenViewer } from './viewers/provider';
import { modelToText } from './viewers/extract';

export function activate(context: vscode.ExtensionContext): void {
    const provider = DocumentViewerProvider.register(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('nlabs-doc.open', (uri?: vscode.Uri) => openPreview(uri)),

        vscode.commands.registerCommand('nlabs-doc.reload', () => {
            const viewer = provider.activeViewer();
            if (viewer) { provider.reload(viewer); }
        }),

        vscode.commands.registerCommand('nlabs-doc.openInDefaultApp', async (uri?: vscode.Uri) => {
            const target = uri ?? provider.activeViewer()?.uri;
            if (target) { await vscode.env.openExternal(target); }
        }),

        vscode.commands.registerCommand('nlabs-doc.extractImages', async (uri?: vscode.Uri) => {
            await runExtraction(provider, uri, extractImages);
        }),

        vscode.commands.registerCommand('nlabs-doc.extractText', async (uri?: vscode.Uri) => {
            await runExtraction(provider, uri, extractText);
        })
    );
}

export function deactivate(): void { /* tutulan kaynak yok */ }

async function openPreview(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
        void vscode.window.showWarningMessage(t('selectDocument'));
        return;
    }
    const kind = kindForPath(target.fsPath);
    if (!kind) {
        void vscode.window.showWarningMessage(t('errorUnsupported'));
        return;
    }
    await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE[kind]);
}

type Extraction = (uri: vscode.Uri, model: DocModel) => Promise<void>;

/**
 * Disa aktarim komutlarinin ortak kabugu: modeli etkin goruntuleyiciden alir,
 * yoksa (Gezgin'den cagrildiysa) dosyayi ayristirir.
 */
async function runExtraction(provider: DocumentViewerProvider, uri: vscode.Uri | undefined, run: Extraction): Promise<void> {
    const viewer = provider.activeViewer();
    const target = uri ?? viewer?.uri;
    if (!target) {
        void vscode.window.showWarningMessage(t('selectDocument'));
        return;
    }

    try {
        const model = (!uri || uri.toString() === viewer?.uri.toString())
            ? viewer?.model ?? await parseFile(target)
            : await parseFile(target);
        await run(target, model);
    } catch (err) {
        const message = err instanceof DocumentError ? err.message : (err as Error).message;
        void vscode.window.showErrorMessage(`nLabs Document Viewer: ${message}`);
    }
}

async function parseFile(uri: vscode.Uri): Promise<DocModel> {
    const stat = await vscode.workspace.fs.stat(uri);
    const limit = maxFileSizeBytes(uri);
    if (stat.size > limit) {
        throw new DocumentError(t('errorTooLarge', (stat.size / 1048576).toFixed(1), (limit / 1048576).toFixed(1)));
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    return parseDocument(
        Buffer.from(bytes),
        path.basename(uri.fsPath),
        path.extname(uri.fsPath).toLowerCase(),
        readParseLimits(uri)
    );
}

/** Gomulu gorselleri belgenin yanindaki `<ad>-images` klasorune yazar. */
async function extractImages(uri: vscode.Uri, model: DocModel): Promise<void> {
    if (model.images.length === 0) {
        void vscode.window.showInformationMessage(t('nothingToExtract'));
        return;
    }

    const base = path.basename(uri.fsPath, path.extname(uri.fsPath));
    const folder = vscode.Uri.joinPath(uri.with({ path: path.dirname(uri.path) }), `${base}-images`);
    await vscode.workspace.fs.createDirectory(folder);

    const width = String(model.images.length).length;
    let index = 0;
    for (const image of model.images) {
        index++;
        const suffix = path.extname(image.name) || extensionForMime(image.mime);
        const name = `${String(index).padStart(width, '0')}-${path.basename(image.name, path.extname(image.name))}${suffix}`;
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(folder, name),
            Buffer.from(image.base64, 'base64')
        );
    }

    const choice = await vscode.window.showInformationMessage(
        t('extractedImages', model.images.length, path.basename(folder.fsPath)),
        t('details')
    );
    if (choice) { await vscode.commands.executeCommand('revealFileInOS', folder); }
}

/** Cikarilan metni `<ad>.txt` olarak yazar ve editorde acar. */
async function extractText(uri: vscode.Uri, model: DocModel): Promise<void> {
    const text = modelToText(model).trimEnd();
    if (!text) {
        void vscode.window.showInformationMessage(t('noContent'));
        return;
    }
    const base = path.basename(uri.fsPath, path.extname(uri.fsPath));
    const target = vscode.Uri.joinPath(uri.with({ path: path.dirname(uri.path) }), `${base}.txt`);
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    void vscode.window.showInformationMessage(t('extractedText', path.basename(target.fsPath)));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
}

function extensionForMime(mime: string): string {
    switch (mime) {
        case 'image/jpeg': return '.jpg';
        case 'image/gif': return '.gif';
        case 'image/bmp': return '.bmp';
        case 'image/webp': return '.webp';
        case 'image/tiff': return '.tif';
        case 'image/emf': return '.emf';
        case 'image/wmf': return '.wmf';
        case 'image/svg+xml': return '.svg';
        default: return '.png';
    }
}

export type { OpenViewer };
