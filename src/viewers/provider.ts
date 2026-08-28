import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { maxFileSizeBytes, onSettingsChanged, readParseLimits, readViewerSettings } from '../core/config';
import { webviewHtml } from '../core/html';
import { bundle, t } from '../core/i18n';
import { DocumentError, VIEW_TYPE, type AppInfo, type DocKind, type DocModel, type InboundMessage, type OutboundMessage } from '../core/types';
import { parseDocument } from '../formats/parse';

/** Acik bir goruntuleyici sekmesi. */
export interface OpenViewer {
    uri: vscode.Uri;
    panel: vscode.WebviewPanel;
    model?: DocModel;
}

const CONTEXT_KEY = 'nlabsDoc.viewerFocused';

/** Salt-okunur belge tanitici; icerik her zaman diskten taze okunur. */
class DocumentHandle implements vscode.CustomDocument {
    constructor(readonly uri: vscode.Uri) {}
    dispose(): void { /* tutulan kaynak yok */ }
}

export class DocumentViewerProvider implements vscode.CustomReadonlyEditorProvider<DocumentHandle> {
    private readonly viewers = new Set<OpenViewer>();
    private active?: OpenViewer;

    constructor(private readonly context: vscode.ExtensionContext) {
        context.subscriptions.push(onSettingsChanged(() => this.pushSettings()));
    }

    /** Tum belge turleri icin custom editor kaydi. */
    static register(context: vscode.ExtensionContext): DocumentViewerProvider {
        const provider = new DocumentViewerProvider(context);
        for (const viewType of Object.values(VIEW_TYPE)) {
            context.subscriptions.push(
                vscode.window.registerCustomEditorProvider(viewType, provider, {
                    webviewOptions: { retainContextWhenHidden: true },
                    supportsMultipleEditorsPerDocument: false,
                })
            );
        }
        return provider;
    }

    activeViewer(): OpenViewer | undefined {
        return this.active?.panel.visible ? this.active : undefined;
    }

    openCustomDocument(uri: vscode.Uri): DocumentHandle {
        return new DocumentHandle(uri);
    }

    async resolveCustomEditor(document: DocumentHandle, panel: vscode.WebviewPanel): Promise<void> {
        const viewer: OpenViewer = { uri: document.uri, panel };
        this.viewers.add(viewer);

        panel.webview.options = {
            enableScripts: true,
            // Yalnizca eklentinin kendi media/ klasoru okunabilir; belge baytlari
            // mesajla gonderilir, dosya sistemi webview'e hic acilmaz.
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        };
        panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri, path.basename(document.uri.fsPath));

        panel.webview.onDidReceiveMessage(
            (message: InboundMessage) => this.onMessage(viewer, message),
            undefined,
            this.context.subscriptions
        );

        panel.onDidChangeViewState(() => {
            if (panel.active) { this.setActive(viewer); }
            else if (this.active === viewer) { this.setActive(undefined); }
        }, undefined, this.context.subscriptions);

        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(path.dirname(document.uri.fsPath)), path.basename(document.uri.fsPath))
        );
        watcher.onDidChange(() => void this.load(viewer));
        watcher.onDidCreate(() => void this.load(viewer));

        panel.onDidDispose(() => {
            watcher.dispose();
            this.viewers.delete(viewer);
            if (this.active === viewer) { this.setActive(undefined); }
        });

        if (panel.active) { this.setActive(viewer); }
    }

    private setActive(viewer: OpenViewer | undefined): void {
        this.active = viewer;
        void vscode.commands.executeCommand('setContext', CONTEXT_KEY, viewer !== undefined);
    }

    private onMessage(viewer: OpenViewer, message: InboundMessage): void {
        switch (message.type) {
            case 'ready':
                void this.load(viewer);
                break;
            case 'openExternal':
                void vscode.env.openExternal(viewer.uri);
                break;
            case 'extractImages':
                void vscode.commands.executeCommand('nlabs-doc.extractImages');
                break;
            case 'extractText':
                void vscode.commands.executeCommand('nlabs-doc.extractText');
                break;
            case 'saveViewState':
                void this.context.workspaceState.update(stateKey(viewer.uri), message.state);
                break;
            case 'setTheme':
                void this.setTheme(message.theme);
                break;
            case 'openLink':
                void this.openLink(message.url);
                break;
            case 'openSettings':
                void vscode.commands.executeCommand('workbench.action.openSettings', 'nlabsDoc');
                break;
            case 'error':
                console.error('nLabs Document Viewer (webview):', message.message);
                break;
        }
    }

    /** Etkin goruntuleyiciyi yeniden yukler (komut veya dosya degisikligi). */
    reload(viewer: OpenViewer): void {
        void this.load(viewer);
    }

    private async load(viewer: OpenViewer): Promise<void> {
        const post = (message: OutboundMessage) => viewer.panel.webview.postMessage(message);
        post({ type: 'loading', strings: bundle() });

        try {
            const stat = await vscode.workspace.fs.stat(viewer.uri);
            const limit = maxFileSizeBytes(viewer.uri);
            const extension = path.extname(viewer.uri.fsPath).toLowerCase();
            const lineOriented = extension === '.jsonl' || extension === '.ndjson';

            // Satir tabanli bicimlerde buyuk dosya reddedilmez: bastan bir dilim okunur.
            // Boylece yuz megabaytlik bir gunluk dosyasi da acilir, ilk kayitlari gorunur.
            let prefixBytes: number | undefined;
            if (stat.size > limit) {
                if (!lineOriented) {
                    throw new DocumentError(t('errorTooLarge', mb(stat.size), mb(limit)));
                }
                prefixBytes = limit;
            }

            const bytes = prefixBytes !== undefined
                ? readPrefix(viewer.uri, prefixBytes)
                : await vscode.workspace.fs.readFile(viewer.uri);
            const model = parseDocument(
                Buffer.from(bytes),
                path.basename(viewer.uri.fsPath),
                extension,
                readParseLimits(viewer.uri),
                assetReader(viewer.uri)
            );

            if (prefixBytes !== undefined) {
                model.warnings.unshift(t('warnPrefixRead', mb(prefixBytes), mb(stat.size)));
            }
            viewer.model = model;
            post({
                type: 'document',
                model,
                settings: readViewerSettings(viewer.uri),
                app: this.appInfo(),
                strings: bundle(),
                viewState: this.context.workspaceState.get(stateKey(viewer.uri)) ?? null,
            });
        } catch (err) {
            viewer.model = undefined;
            const isKnown = err instanceof DocumentError;
            post({
                type: 'failure',
                message: isKnown ? err.message : t('errorTitle'),
                detail: isKnown ? err.detail : (err as Error).message,
                strings: bundle(),
            });
            if (!isKnown) {
                console.error('nLabs Document Viewer:', err);
            }
        }
    }

    /** Arac cubugundaki secim kalici olsun diye ayara yazilir; degisiklik tum sekmelere yayilir. */
    private async setTheme(theme: string): Promise<void> {
        const allowed = ['paper', 'sepia', 'auto', 'editor'];
        if (!allowed.includes(theme)) { return; }
        await vscode.workspace.getConfiguration('nlabsDoc')
            .update('theme', theme, vscode.ConfigurationTarget.Global);
    }

    /**
     * "Hakkinda" panelindeki baglantiyi acar.
     *
     * Adres webview'den gelir, yani guvenilmez girdidir: yalnizca https ve yalnizca
     * bu urune ait alan adlari acilir. Boylece bir belgeden gelen metin hicbir zaman
     * rastgele bir adrese donusemez.
     */
    private async openLink(url: string): Promise<void> {
        const ALLOWED_HOSTS = ['github.com', 'marketplace.visualstudio.com'];
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.includes(parsed.hostname)) { return; }
            await vscode.env.openExternal(vscode.Uri.parse(parsed.toString()));
        } catch {
            // Bicimsiz adres: sessizce yok sayilir.
        }
    }

    /** package.json'dan okunan urun kimligi - "Hakkinda" panelini besler. */
    private appInfo(): AppInfo {
        const meta = this.context.extension.packageJSON as Record<string, unknown>;
        const repository = meta.repository as { url?: string } | undefined;
        const runtime = meta.dependencies as Record<string, string> | undefined;
        return {
            name: String(meta.displayName ?? 'nLabs Document Viewer'),
            version: String(meta.version ?? '0.0.0'),
            publisher: String(meta.publisher ?? 'nlabs'),
            license: String(meta.license ?? 'MIT'),
            repository: (repository?.url ?? '').replace(/[.]git$/, ''),
            runtimeDependencies: runtime ? Object.keys(runtime).length : 0,
            formats: ['PDF', 'Word (docx)', 'Excel (xlsx)', 'CSV / TSV'],
        };
    }

    private pushSettings(): void {
        for (const viewer of this.viewers) {
            void viewer.panel.webview.postMessage({
                type: 'settings',
                settings: readViewerSettings(viewer.uri),
                app: this.appInfo(),
                strings: bundle(),
            } satisfies OutboundMessage);
        }
    }
}

/**
 * Markdown'in basvurdugu goreli gorselleri okur.
 *
 * Yalniz `file` semasinda calisir (sanal calisma alaninda gorseller atlanir) ve
 * yalniz belgenin kendi klasoru altindan okur - cozulen yol o klasorun disina
 * cikiyorsa istek reddedilir.
 */
/**
 * Dosyanin ilk `limit` baytini okur ve yarim kalan son satiri atar.
 *
 * Yalniz satir tabanli bicimler icin kullanilir; yarim bir JSON satiri
 * ayristirilamaz hata uretecegi icin bilerek kesilir.
 */
function readPrefix(uri: vscode.Uri, limit: number): Buffer {
    const handle = fs.openSync(uri.fsPath, 'r');
    try {
        const buffer = Buffer.alloc(limit);
        const read = fs.readSync(handle, buffer, 0, limit, 0);
        const slice = buffer.subarray(0, read);
        const lastNewline = slice.lastIndexOf(0x0a);
        return lastNewline > 0 ? slice.subarray(0, lastNewline) : slice;
    } finally {
        fs.closeSync(handle);
    }
}

function assetReader(uri: vscode.Uri): ((relativePath: string) => Buffer | undefined) | undefined {
    if (uri.scheme !== 'file') { return undefined; }
    const base = path.dirname(uri.fsPath);
    return (relativePath: string) => {
        try {
            const target = path.resolve(base, relativePath);
            const relative = path.relative(base, target);
            if (relative.startsWith('..') || path.isAbsolute(relative)) { return undefined; }
            const stat = fs.statSync(target);
            if (!stat.isFile() || stat.size > 32 * 1024 * 1024) { return undefined; }
            return fs.readFileSync(target);
        } catch {
            return undefined;
        }
    };
}

function stateKey(uri: vscode.Uri): string {
    return `viewState:${uri.toString()}`;
}

function mb(bytes: number): string {
    return (bytes / (1024 * 1024)).toFixed(1);
}

export type { DocKind };
