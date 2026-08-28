# Changelog

All notable changes to nLabs Document Viewer are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-08-24

### Formats

- **Markdown** (`.md`, `.markdown`, `.mdown`): headings, lists, GFM tables, fenced and indented
  code, blockquotes, inline formatting, links, YAML front matter, and relative images loaded from
  the document's own folder. Raw HTML is shown as literal text, never interpreted.
- **JSONL / NDJSON** (`.jsonl`, `.ndjson`): one collapsible JSON tree per record with a generated
  summary line. Malformed lines are reported instead of failing the file. Oversized files are read
  as a prefix rather than refused.
- Both open through **right-click / Open With**, not on plain click, so the text editor stays the
  default for files you may want to edit.

First release.

### Added

- PDF viewer: text extraction with on-page positioning, embedded image extraction,
  document metadata and bookmark outline. Handles damaged cross-reference tables by
  scanning the file for objects, and expands compressed object streams.
- Word viewer (`.docx` `.dotx` `.docm`): headings, paragraphs, lists with real
  numbering, tables with merged cells, character formatting, hyperlinks, images.
- Excel viewer (`.xlsx` `.xlsm` `.xltx`): multiple sheets, shared strings, number and
  date formats, merged cells, fonts and fills, column widths.
- CSV/TSV viewer with delimiter detection, header detection and encoding detection
  (UTF-8, UTF-16, windows-1254).
- `Extract Embedded Images` and `Extract Text` commands.
- Find-in-document, zoom, and a page-colour picker in the toolbar (paper / sepia / follow theme /
  editor background) that persists to `nlabsDoc.theme`.
- Documents render on a white page by default in every theme, so a dark editor theme does not
  turn the document itself dark. Muted text on the page follows the page colour, not the editor theme.
- Sidebar tabs: outline, images, metadata, and About (version, licence, repository, format list).
- UI in English, Turkish, German and French.
- Security guards: file size limit, zip-bomb limits (total size and per-entry ratio),
  archive path-traversal rejection, XML depth and node limits, no-network CSP,
  `innerHTML`-free rendering.

### Notes

- PDF pages are shown as extracted text plus embedded images, not as a pixel-accurate
  rendering. This is a deliberate design decision - see the README.
- Encrypted PDFs are reported rather than opened.
