# nLabs Document Viewer

Preview **PDF**, **Word**, **Excel**, **CSV**, **Markdown** and **JSON/JSONL** documents without leaving VS Code.

Built on a single rule: **zero runtime dependencies**. No PDF.js, no SheetJS, no
docx-preview - every parser in this extension is written from scratch on top of
Node's own `zlib` and `crypto`. Nothing is downloaded, nothing is uploaded, and
the webview has no network access at all.

## Install

From the Visual Studio Marketplace:

```bash
code --install-extension nlabs.nlabs-doc-viewer
```

Or search for **nLabs Document Viewer** in the Extensions view.

Or build the `.vsix` yourself:

```bash
git clone https://github.com/nlabs-vscode-extensions/doc-viewer.git
cd doc-viewer
pnpm install
pnpm run package
code --install-extension nlabs-doc-viewer-0.2.0.vsix
```

Then open any PDF, `.docx` or `.xlsx` - the viewer takes over automatically.

**Text-editable formats keep the text editor as their default.** CSV, TSV, Markdown, JSON and JSONL
are files you may want to *edit*, so clicking one opens the normal editor. To preview them,
right-click the file and choose **nLabs: Open Document Preview**, or use **Open With...**.

## Supported formats

| Format | Extensions | What you get |
|---|---|---|
| PDF | `.pdf` | Text with on-page positions, embedded images, metadata, bookmarks |
| Word | `.docx` `.dotx` `.docm` | Headings, lists, tables, formatting, embedded images |
| Excel | `.xlsx` `.xlsm` `.xltx` | Sheets, merged cells, number/date formats, cell styling |
| CSV | `.csv` `.tsv` | Auto-detected delimiter and encoding, header detection |
| Markdown | `.md` `.markdown` `.mdown` | Headings, lists, tables, code blocks, quotes, front matter, local images |
| JSON | `.json` `.geojson` | One collapsible tree; arrays become one record per element |
| JSONL | `.jsonl` `.ndjson` | One collapsible JSON tree per record, with a summary line |

## Markdown and JSONL

**Markdown** is rendered onto the same page surface as every other format, so the page-colour
picker, find, zoom and text extraction all work the same way. Raw HTML inside a Markdown file is
shown as literal text, never interpreted - this viewer has no HTML rendering path at all.
Images referenced with a relative path are loaded from disk, but only from inside the document's
own folder; `..`, absolute paths and remote URLs are refused.

**JSON** files are read as a single document: an object becomes one expanded tree, an array
becomes one record per element. **JSONL / NDJSON** is shown as one collapsible record per line.
Each mode falls back to the other, so a `.json` holding newline-delimited records still opens. Each record gets a summary line
built from whichever of `type`, `role`, `event`, `level`... it actually has, so a log or an
agent transcript is scannable without expanding anything. Malformed lines do not fail the file;
their line numbers are reported as a warning. Very large files are read as a prefix rather than
refused - a 500 MB transcript opens showing its first records.

## About PDF rendering

**PDF pages are not rendered pixel-for-pixel.** They are shown as extracted text
laid out at its real page position, plus the images embedded in the page.

This is a deliberate trade-off, not a missing feature. Pixel-accurate PDF rendering
needs font-program interpreters, JPEG 2000, CCITT/JBIG2 codecs and colour management -
historically some of the most vulnerability-prone code in any document stack. This
extension exists precisely to avoid shipping that surface. If you need an exact visual
copy of a page, use **Open In System App** from the toolbar.

Scanned PDFs with no text layer are detected and their page images are shown.

## Features

- **Extract embedded images** - one click writes every image in the document to a
  `<name>-images/` folder next to it. Formats that cannot be displayed in a webview
  (EMF, WMF, TIFF) are still extracted.
- **Extract text** - writes a `.txt` next to the document and opens it.
- Find-in-document with match navigation, zoom, page-colour picker (paper / sepia / auto / editor).
- Sidebar with outline, embedded images, document metadata and an About panel.
- Four UI languages: English, Turkish, German, French (`nlabsDoc.language`).
- Remembers scroll position, zoom and active sheet per file.

## Security posture

Documents are untrusted input. This extension treats them that way:

- **No network.** The webview's Content-Security-Policy has no `connect-src`,
  `frame-src` or remote `script-src`. It cannot make a request even if it wanted to.
- **No `innerHTML`.** Every piece of document text reaches the DOM through
  `textContent`, so document content can never be interpreted as markup or script.
- **No telemetry.** Nothing about your files leaves your machine.
- **Zip-bomb guards.** Office containers are rejected if total uncompressed size or
  per-entry compression ratio exceeds a configurable limit.
- **Path-traversal guards.** Archive entry names with `..`, absolute paths, drive
  letters or NUL bytes are rejected outright.
- **Size limits.** Files above `nlabsDoc.maxFileSizeMb` are refused before reading.
- **Encrypted PDFs are not opened** rather than decrypted with a guessed password.
- **No image codecs of our own.** JPEG passes through to the browser; raw samples
  are re-encoded as PNG. JPEG 2000, CCITT and JBIG2 images are skipped, not decoded.

The extension is enabled in untrusted workspaces because it never executes anything
from the documents it reads.

## Settings

| Setting | Default | Description |
|---|---|---|
| `nlabsDoc.language` | `auto` | UI language (`auto`, `tr`, `en`, `de`, `fr`) |
| `nlabsDoc.theme` | `paper` | Page colour: `paper`, `sepia`, `auto` (dim surface in dark themes) or `editor`. The toolbar picker writes back to this setting. |
| `nlabsDoc.maxFileSizeMb` | `100` | Refuse documents larger than this |
| `nlabsDoc.zip.maxUncompressedMb` | `512` | Zip-bomb guard: total uncompressed size |
| `nlabsDoc.zip.maxCompressionRatio` | `200` | Zip-bomb guard: per-entry ratio |
| `nlabsDoc.sheet.maxRows` | `5000` | Rows rendered per sheet |
| `nlabsDoc.sheet.maxColumns` | `200` | Columns rendered per sheet |
| `nlabsDoc.csv.delimiter` | `auto` | CSV field delimiter |
| `nlabsDoc.showImages` | `true` | Render embedded images |
| `nlabsDoc.pdf.textLayout` | `columns` | Keep page positions, or reflow into one column |

## Commands

| Command | Description |
|---|---|
| `nLabs: Open Document Preview` | Open the selected file in the viewer |
| `nLabs: Reload Document` | Re-read the file from disk |
| `nLabs: Extract Embedded Images` | Write all embedded images to a folder |
| `nLabs: Extract Text` | Write extracted text to a `.txt` file |
| `nLabs: Open In System App` | Hand the file to the OS default application |

## Known limits

- PDF: no pixel-accurate page rendering (see above); encrypted PDFs are not opened;
  JPEG 2000 / CCITT / JBIG2 images are skipped.
- Word: no headers/footers, footnotes, shapes or text boxes; revision marks are
  shown as accepted.
- Excel: formulas are shown as their last cached value; charts and pivot tables are
  not rendered; theme colours fall back to defaults.
- Legacy binary `.doc` and `.xls` are not supported - they are not OOXML.

## Development

```bash
pnpm install
pnpm run compile        # TypeScript -> out/
pnpm run package        # produces the .vsix

node scripts/smoke.mjs --dir "C:/some/folder"   # run parsers over real files
node scripts/make-icon.mjs                      # regenerate images/icon.png
```

Press <kbd>F5</kbd> to launch an Extension Development Host.

## License

MIT (c) nLabs - Cuma Kose
