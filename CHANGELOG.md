# Changelog

All notable changes to nLabs Document Viewer are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.1] - 2026-08-28

### Fixed

- The published JavaScript no longer carries `sourceMappingURL` comments pointing at map files
  that are not shipped with the package. Source maps are disabled for the published build only;
  `pnpm run compile` still produces them for local debugging.

## [0.2.0] - 2026-08-28

### Added

- **Markdown** (`.md`, `.markdown`, `.mdown`): headings, nested lists, GFM tables, fenced and
  indented code blocks, blockquotes, inline formatting, links, and YAML front matter (surfaced in
  the metadata panel). Relative images are loaded from disk, but only from inside the document's
  own folder. Raw HTML is shown as literal text, never interpreted.
- **JSON** (`.json`, `.geojson`): read as a single document - an object opens as one expanded
  tree, an array becomes one record per element.
- **JSONL / NDJSON** (`.jsonl`, `.ndjson`): one collapsible JSON tree per record, with a summary
  line built from whichever of `type`, `role`, `event`, `level`... the records actually carry.
  Malformed lines are reported instead of failing the file.
- Large line-oriented files are read as a prefix instead of being refused, so a multi-hundred-MB
  log or transcript opens showing its first records.
- Page-colour picker in the toolbar: paper, sepia, follow theme, or editor background. The choice
  is written back to `nlabsDoc.theme`, so it persists and applies to every open tab.
- **About** sidebar tab: version, publisher, licence, runtime dependency count, supported formats,
  and a link to the repository.

### Changed

- Muted text on the page (list markers, page labels, empty-page notes) now follows the page
  colour instead of the editor theme. On a white page in a dark theme it was unreadable.
- Page surfaces get a border and a stronger shadow so the page edge stays visible on any backdrop.
- JSON syntax colours adapt to the page colour rather than being fixed.

### Security

- Markdown image paths are treated as untrusted input: absolute paths, drive letters, `..`
  segments and remote URLs are refused; only files under the document's own folder are read.
- Links opened from the About panel are restricted to `https` on known project hosts.

## [0.1.0] - 2026-08-24

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
- Find-in-document, zoom, and a sidebar with outline, images and metadata tabs.
- Documents render on a white page by default in every theme.
- UI in English, Turkish, German and French.
- Security guards: file size limit, zip-bomb limits (total size and per-entry ratio),
  archive path-traversal rejection, XML depth and node limits, no-network CSP,
  `innerHTML`-free rendering.

### Notes

- PDF pages are shown as extracted text plus embedded images, not as a pixel-accurate
  rendering. This is a deliberate design decision - see the README.
- Encrypted PDFs are reported rather than opened.
