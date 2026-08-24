import * as vscode from 'vscode';
import * as crypto from 'node:crypto';

/**
 * Webview kabugu.
 *
 * Icerik burada URETILMEZ - govde bostur, her sey `media/viewer.js` icinde DOM
 * API'si ile olusturulur (`innerHTML` yasak). Boylece belgeden gelen metin hicbir
 * asamada HTML olarak yorumlanmaz.
 *
 * CSP'de `connect-src` ve `frame-src` YOKTUR: sayfa aga hicbir istek atamaz.
 */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const asset = (...parts: string[]) =>
        webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', ...parts)).toString();

    const csp = [
        "default-src 'none'",
        `img-src ${webview.cspSource} data:`,
        `style-src ${webview.cspSource}`,
        `font-src ${webview.cspSource}`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${asset('viewer.css')}">
<title>${escapeHtml(title)}</title>
</head>
<body>
<div id="app" class="app"></div>
<script nonce="${nonce}" src="${asset('viewer.js')}"></script>
</body>
</html>`;
}

/** Yalnizca <title> icin - govde metni hicbir zaman HTML'e gomulmez. */
function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (ch) => {
        switch (ch) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            default: return '&#39;';
        }
    });
}
