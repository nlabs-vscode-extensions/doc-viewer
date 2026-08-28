/**
 * nLabs Document Viewer - webview arayuzu.
 *
 * KURAL: `innerHTML` KULLANILMAZ. Belgeden gelen her metin `textContent` ile
 * yazilir; boylece icerik hicbir kosulda HTML/JS olarak yorumlanamaz.
 */
(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    const state = {
        model: null,
        settings: { theme: 'auto', showImages: true, pdfTextLayout: 'columns' },
        strings: {},
        zoom: 1,
        sheetIndex: 0,
        rowLimit: 1000,
        sidebarTab: 'outline',
        app: null,
        sidebarVisible: true,
        find: { term: '', nodes: [], index: 0 },
    };

    const app = document.getElementById('app');

    // ---------- yardimcilar ----------

    function t(key) {
        let text = state.strings[key] || key;
        for (let i = 1; i < arguments.length; i++) {
            text = text.split('{' + (i - 1) + '}').join(String(arguments[i]));
        }
        return text;
    }

    /** el('div', {class:'x', onclick:fn}, [cocuk|metin]) */
    function el(tag, props, children) {
        const node = document.createElement(tag);
        if (props) {
            for (const key of Object.keys(props)) {
                const value = props[key];
                if (value === undefined || value === null) { continue; }
                if (key === 'class') { node.className = value; }
                else if (key === 'text') { node.textContent = value; }
                else if (key === 'style') { Object.assign(node.style, value); }
                else if (key.startsWith('on')) { node.addEventListener(key.slice(2), value); }
                else { node.setAttribute(key, value); }
            }
        }
        if (children) {
            for (const child of children) {
                if (child === null || child === undefined || child === false) { continue; }
                node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
            }
        }
        return node;
    }

    function clear(node) {
        while (node.firstChild) { node.removeChild(node.firstChild); }
    }

    function dataUri(image) {
        return 'data:' + image.mime + ';base64,' + image.base64;
    }

    function imageById(id) {
        if (!state.model) { return undefined; }
        return state.model.images.find(function (image) { return image.id === id; });
    }

    // ---------- durum ekranlari ----------

    function showLoading() {
        clear(app);
        app.appendChild(el('div', { class: 'state' }, [
            el('div', { class: 'spinner' }),
            el('p', { text: t('loading') }),
        ]));
    }

    function showFailure(message, detail) {
        clear(app);
        const actions = el('div', { class: 'actions' }, [
            el('button', { class: 'btn', text: t('reload'), onclick: function () { vscode.postMessage({ type: 'ready' }); } }),
            el('button', { class: 'btn', text: t('openExternal'), onclick: function () { vscode.postMessage({ type: 'openExternal' }); } }),
        ]);
        app.appendChild(el('div', { class: 'state' }, [
            el('h2', { text: t('errorTitle') }),
            el('p', { text: message }),
            detail ? el('p', { text: detail }) : null,
            actions,
        ]));
    }

    // ---------- tema ----------

    function isDarkHost() {
        return document.body.classList.contains('vscode-dark')
            || document.body.classList.contains('vscode-high-contrast');
    }

    /** Acik ve koyu yuzeyler icin JSON sozdizimi renkleri. */
    const SYNTAX = {
        light: { key: '#9c5d9e', string: '#2a7a4b', number: '#2060c0', bool: '#b06000' },
        dark: { key: '#d7a3d9', string: '#7fd18f', number: '#79b8ff', bool: '#ffab5e' },
    };

    function setSyntax(root, set) {
        root.style.setProperty('--json-key', set.key);
        root.style.setProperty('--json-string', set.string);
        root.style.setProperty('--json-number', set.number);
        root.style.setProperty('--json-bool', set.bool);
    }

    /** Sayfa yuzeyi rengini uygular. Doner deger: zemin notr gri olsun mu. */
    function applyTheme(root) {
        const dark = isDarkHost();
        const mode = state.settings.theme;

        if (mode === 'editor') {
            root.style.setProperty('--doc-bg', 'var(--vscode-editor-background)');
            root.style.setProperty('--doc-fg', 'var(--vscode-editor-foreground)');
            root.style.setProperty('--doc-muted', 'var(--vscode-descriptionForeground)');
            setSyntax(root, dark ? SYNTAX.dark : SYNTAX.light);
        } else if (mode === 'sepia') {
            root.style.setProperty('--doc-bg', '#f6ecd9');
            root.style.setProperty('--doc-fg', '#3b2f21');
            root.style.setProperty('--doc-muted', '#7a6a55');
            setSyntax(root, SYNTAX.light);
        } else if (mode === 'paper' || (mode === 'auto' && !dark)) {
            root.style.setProperty('--doc-bg', '#ffffff');
            root.style.setProperty('--doc-fg', '#1f1f1f');
            root.style.setProperty('--doc-muted', '#6b6b6b');
            setSyntax(root, SYNTAX.light);
        } else {
            // Koyu yuzey editor arka planindan AYRILMALI, yoksa sayfa siniri kaybolur.
            root.style.setProperty('--doc-bg', '#2d2d30');
            root.style.setProperty('--doc-fg', '#e8e8e8');
            root.style.setProperty('--doc-muted', '#9d9d9d');
            setSyntax(root, SYNTAX.dark);
        }
        return !dark && mode !== 'editor';
    }

    const THEME_OPTIONS = ['paper', 'sepia', 'auto', 'editor'];
    let openMenu = null;

    function closeMenu() {
        if (openMenu && openMenu.parentNode) { openMenu.parentNode.removeChild(openMenu); }
        openMenu = null;
        document.removeEventListener('mousedown', onMenuOutside, true);
    }

    function onMenuOutside(event) {
        if (openMenu && !openMenu.contains(event.target)) { closeMenu(); }
    }

    /** Arac cubugundaki sayfa rengi secicisi. Secim ayara yazilir, tum sekmelere yayilir. */
    function openThemeMenu(anchor) {
        if (openMenu) { closeMenu(); return; }
        const rect = anchor.getBoundingClientRect();
        const menu = el('div', { class: 'menu' }, THEME_OPTIONS.map(function (option) {
            const active = state.settings.theme === option;
            return el('div', {
                class: 'menu-item' + (active ? ' active' : ''),
                onclick: function () {
                    closeMenu();
                    if (option === state.settings.theme) { return; }
                    state.settings.theme = option;
                    vscode.postMessage({ type: 'setTheme', theme: option });
                    render();
                },
            }, [
                el('span', { class: 'menu-check', text: active ? '\u2713' : '' }),
                el('span', { class: 'menu-swatch swatch-' + option }),
                el('span', { text: t('theme' + option.charAt(0).toUpperCase() + option.slice(1)) }),
            ]);
        }));
        menu.style.top = Math.round(rect.bottom + 4) + 'px';
        menu.style.right = Math.max(4, window.innerWidth - Math.round(rect.right)) + 'px';
        document.body.appendChild(menu);
        openMenu = menu;
        document.addEventListener('mousedown', onMenuOutside, true);
    }

    // ---------- ana cizim ----------

    function render() {
        const model = state.model;
        if (!model) { return; }

        clear(app);
        const content = el('div', { class: 'content' });
        const usePaper = applyTheme(app);
        if (usePaper) { content.classList.add('paper'); }

        const sidebar = buildSidebar();
        const body = el('div', { class: 'body' }, [sidebar, content]);
        app.appendChild(buildToolbar());
        app.appendChild(body);

        renderContent(content);
        restoreScroll(content);
        content.addEventListener('scroll', saveScroll(content), { passive: true });
    }

    // ---------- arac cubugu ----------

    function buildToolbar() {
        const model = state.model;
        const findInput = el('input', {
            type: 'text',
            placeholder: t('findPlaceholder'),
            value: state.find.term,
            oninput: function (event) { runFind(event.target.value); },
            onkeydown: function (event) {
                if (event.key === 'Enter') { stepFind(event.shiftKey ? -1 : 1); event.preventDefault(); }
                if (event.key === 'Escape') { event.target.value = ''; runFind(''); }
            },
        });
        const findCount = el('span', { class: 'count', id: 'findCount' });

        const zoomLabel = el('span', { class: 'zoom-level', id: 'zoomLevel', text: Math.round(state.zoom * 100) + '%' });

        return el('div', { class: 'toolbar' }, [
            el('button', {
                class: 'btn' + (state.sidebarVisible ? ' active' : ''),
                title: t('outline'),
                text: '\u2630',
                onclick: toggleSidebar,
            }),
            el('div', { class: 'find' }, [findInput, findCount]),
            el('button', { class: 'btn', title: t('findPrev'), text: '\u2191', onclick: function () { stepFind(-1); } }),
            el('button', { class: 'btn', title: t('findNext'), text: '\u2193', onclick: function () { stepFind(1); } }),
            el('span', { class: 'spacer' }),
            el('button', { class: 'btn', title: t('zoomOut'), text: '\u2212', onclick: function () { setZoom(state.zoom - 0.1); } }),
            el('button', { class: 'btn', title: t('resetZoom'), onclick: function () { setZoom(1); } }, [zoomLabel]),
            el('button', { class: 'btn', title: t('zoomIn'), text: '+', onclick: function () { setZoom(state.zoom + 0.1); } }),
            el('button', {
                class: 'btn', title: t('pageTint'), text: '\u25d1',
                onclick: function (event) { openThemeMenu(event.currentTarget); },
            }),
            el('span', { class: 'spacer' }),
            model.images.length
                ? el('button', {
                    class: 'btn', text: t('extractImages'),
                    onclick: function () { vscode.postMessage({ type: 'extractImages' }); },
                })
                : null,
            el('button', {
                class: 'btn', text: t('extractText'),
                onclick: function () { vscode.postMessage({ type: 'extractText' }); },
            }),
            el('button', {
                class: 'btn', title: t('openExternal'), text: '\u2197',
                onclick: function () { vscode.postMessage({ type: 'openExternal' }); },
            }),
        ]);
    }

    function toggleSidebar() {
        state.sidebarVisible = !state.sidebarVisible;
        render();
    }

    function setZoom(value) {
        state.zoom = Math.min(3, Math.max(0.4, Math.round(value * 20) / 20));
        render();
    }

    // ---------- kenar cubugu ----------

    function buildSidebar() {
        const sidebar = el('div', { class: 'sidebar' + (state.sidebarVisible ? '' : ' hidden') });
        const tabs = [
            { id: 'outline', label: t('outline') },
            { id: 'images', label: t('images') },
            { id: 'info', label: t('info') },
            { id: 'about', label: t('about') },
        ];

        const panel = el('div', { class: 'sidebar-panel' });
        const tabBar = el('div', { class: 'sidebar-tabs' }, tabs.map(function (tab) {
            return el('div', {
                class: 'sidebar-tab' + (state.sidebarTab === tab.id ? ' active' : ''),
                text: tab.label,
                onclick: function () { state.sidebarTab = tab.id; fillSidebar(panel); syncTabs(tabBar, tab.id); },
            });
        }));

        sidebar.appendChild(tabBar);
        sidebar.appendChild(panel);
        fillSidebar(panel);
        return sidebar;
    }

    function syncTabs(tabBar, activeId) {
        const ids = ['outline', 'images', 'info', 'about'];
        Array.prototype.forEach.call(tabBar.children, function (child, index) {
            child.classList.toggle('active', ids[index] === activeId);
        });
    }

    function fillSidebar(panel) {
        clear(panel);
        const model = state.model;
        if (state.sidebarTab === 'outline') {
            if (model.outline && model.outline.length) {
                panel.appendChild(buildOutline(model.outline));
            } else {
                panel.appendChild(el('div', { class: 'sidebar-empty', text: t('noOutline') }));
            }
            return;
        }
        if (state.sidebarTab === 'images') {
            if (!model.images.length) {
                panel.appendChild(el('div', { class: 'sidebar-empty', text: t('noImages') }));
                return;
            }
            panel.appendChild(el('div', { class: 'thumb-grid' }, model.images.map(function (image) {
                const thumb = el('div', { class: 'thumb', title: image.name });
                if (isRenderable(image.mime)) {
                    thumb.appendChild(el('img', { src: dataUri(image), alt: image.name }));
                } else {
                    thumb.appendChild(el('div', { class: 'sidebar-empty', text: image.mime }));
                }
                thumb.addEventListener('click', function () { scrollToImage(image.id); });
                return thumb;
            })));
            return;
        }
        if (state.sidebarTab === 'about') {
            panel.appendChild(buildAbout());
            return;
        }
        if (!model.meta.length) {
            panel.appendChild(el('div', { class: 'sidebar-empty', text: '-' }));
            return;
        }
        for (const entry of model.meta) {
            panel.appendChild(el('div', { class: 'info-row' }, [
                el('span', { class: 'info-key', text: entry.key }),
                el('span', { class: 'info-value', text: entry.value }),
            ]));
        }
    }

    function buildAbout() {
        const app = state.app;
        if (!app) { return el('div', { class: 'sidebar-empty', text: '-' }); }

        const row = function (key, value) {
            return el('div', { class: 'info-row' }, [
                el('span', { class: 'info-key', text: key }),
                el('span', { class: 'info-value', text: value }),
            ]);
        };

        const rows = [
            el('div', { class: 'about-title', text: app.name }),
            row(t('version'), app.version),
            row(t('publisher'), app.publisher),
            row(t('license'), app.license),
            row(t('dependencies'), app.runtimeDependencies === 0
                ? t('zeroDeps')
                : String(app.runtimeDependencies)),
            row(t('formats'), app.formats.join(', ')),
        ];

        if (app.repository) {
            rows.push(el('div', { class: 'info-row' }, [
                el('span', { class: 'info-key', text: t('repository') }),
                el('span', {
                    class: 'info-value link',
                    text: app.repository.replace(/^https:[/][/]/, ''),
                    title: app.repository,
                    onclick: function () { vscode.postMessage({ type: 'openLink', url: app.repository }); },
                }),
            ]));
        }

        rows.push(el('div', { class: 'about-note', text: t('privacy') }));
        rows.push(el('button', {
            class: 'btn about-btn',
            text: t('openSettings'),
            onclick: function () { vscode.postMessage({ type: 'openSettings' }); },
        }));

        return el('div', { class: 'about' }, rows);
    }

    function buildOutline(nodes) {
        return el('div', {}, nodes.map(function (node) {
            const item = el('div', {
                class: 'outline-item',
                text: node.title,
                title: node.title,
                onclick: function () { if (node.page) { scrollToPage(node.page); } },
            });
            const children = node.children && node.children.length
                ? el('div', { class: 'outline-children' }, [buildOutline(node.children)])
                : null;
            return el('div', {}, [item, children]);
        }));
    }

    function isRenderable(mime) {
        return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif'
            || mime === 'image/bmp' || mime === 'image/webp';
    }

    // ---------- icerik ----------

    function renderContent(content) {
        const model = state.model;

        if (model.kind === 'pdf') {
            content.appendChild(el('div', { class: 'notice', text: t('pdfNotice') }));
        }
        if (model.warnings.length) {
            content.appendChild(el('div', { class: 'notice warning' }, [
                el('div', { text: t('warnings') }),
                el('ul', {}, model.warnings.slice(0, 8).map(function (warning) {
                    return el('li', { text: warning });
                })),
            ]));
        }

        if (model.json) { renderJson(content, model); }
        else if (model.pages) { renderPdf(content, model); }
        else if (model.blocks) { renderWord(content, model); }
        else if (model.sheets) { renderSheets(content, model); }

        if (!content.querySelector('.doc, .page, .grid-wrap, .records')) {
            content.appendChild(el('div', { class: 'state' }, [el('p', { text: t('noContent') })]));
        }
    }

    // ---------- Word ----------

    function renderWord(content, model) {
        const doc = el('div', { class: 'doc', style: { fontSize: (state.zoom * 100) + '%' } });
        appendBlocks(doc, model.blocks);
        content.appendChild(doc);
    }

    function appendBlocks(parent, blocks) {
        for (const block of blocks) {
            const node = buildBlock(block);
            if (node) { parent.appendChild(node); }
        }
    }

    function buildBlock(block) {
        switch (block.t) {
            case 'heading': {
                const level = Math.min(6, Math.max(1, block.level));
                return el('h' + level, {}, buildRuns(block.runs));
            }
            case 'para': {
                const props = { class: block.list ? 'list' : undefined };
                if (block.align) { props.style = { textAlign: block.align }; }
                if (block.indent) {
                    props.style = Object.assign(props.style || {}, { marginLeft: (block.indent * 1.6) + 'em' });
                }
                const children = block.list
                    ? [el('span', { class: 'marker', text: block.list.marker })].concat([el('span', {}, buildRuns(block.runs))])
                    : buildRuns(block.runs);
                return el('p', props, children);
            }
            case 'table': {
                const rows = block.rows.map(function (row) {
                    return el('tr', {}, row.map(function (cell) {
                        const props = {};
                        if (cell.colSpan) { props.colspan = String(cell.colSpan); }
                        if (cell.rowSpan) { props.rowspan = String(cell.rowSpan); }
                        const target = el(cell.header ? 'th' : 'td', props);
                        appendBlocks(target, cell.blocks);
                        return target;
                    }));
                });
                return el('table', {}, [el('tbody', {}, rows)]);
            }
            case 'image': {
                if (!state.settings.showImages) { return null; }
                const image = imageById(block.id);
                if (!image || !isRenderable(image.mime)) { return null; }
                const props = { src: dataUri(image), alt: block.alt || image.name };
                if (block.w) { props.style = { width: Math.round(block.w * state.zoom) + 'px' }; }
                return el('img', props);
            }
            case 'code': {
                const pre = el('pre', { class: 'code' });
                if (block.lang) { pre.appendChild(el('div', { class: 'code-lang', text: block.lang })); }
                pre.appendChild(el('code', { text: block.text }));
                return pre;
            }
            case 'quote': {
                const quote = el('blockquote', {});
                appendBlocks(quote, block.blocks);
                return quote;
            }
            case 'rule':
                return el('hr');
            case 'pagebreak':
                return el('div', { class: 'pagebreak' });
            default:
                return null;
        }
    }

    function buildRuns(runs) {
        return runs.map(function (run) {
            const classes = [];
            if (run.mono) { classes.push('run-mono'); }
            if (run.sup) { classes.push('run-sup'); }
            if (run.sub) { classes.push('run-sub'); }
            if (run.link) { classes.push('run-link'); }

            const style = {};
            if (run.b) { style.fontWeight = '700'; }
            if (run.i) { style.fontStyle = 'italic'; }
            if (run.u && !run.s) { style.textDecoration = 'underline'; }
            if (run.s) { style.textDecoration = run.u ? 'underline line-through' : 'line-through'; }
            if (run.color) { style.color = run.color; }
            if (run.bg) { style.backgroundColor = run.bg; }
            if (run.size) { style.fontSize = run.size + 'pt'; }

            if (run.img) {
                const image = imageById(run.img);
                if (image && isRenderable(image.mime) && state.settings.showImages) {
                    return el('img', {
                        class: 'run-img',
                        src: dataUri(image),
                        alt: run.text || image.name,
                        title: run.text || image.name,
                    });
                }
                return el('span', { class: 'run-link', text: '[' + (run.text || image && image.name || '') + ']' });
            }

            return el('span', {
                class: classes.length ? classes.join(' ') : undefined,
                style: style,
                title: run.link || undefined,
                text: run.text,
            });
        });
    }

    // ---------- PDF ----------

    function renderPdf(content, model) {
        const columns = state.settings.pdfTextLayout === 'columns';
        for (const page of model.pages) {
            const scale = state.zoom;
            const node = el('div', {
                class: 'page ' + (columns ? 'columns' : 'reading'),
                id: 'page-' + page.number,
                style: {
                    width: Math.round(page.width * scale) + 'px',
                    minHeight: columns ? Math.round(page.height * scale) + 'px' : 'auto',
                },
            });
            node.appendChild(el('div', { class: 'page-label', text: t('page') + ' ' + page.number }));

            if (columns) {
                for (const line of page.lines) {
                    node.appendChild(el('div', {
                        class: 'line',
                        text: line.text,
                        style: {
                            left: (line.x * scale) + 'px',
                            top: ((line.y - line.size) * scale) + 'px',
                            fontSize: (line.size * scale) + 'px',
                        },
                    }));
                }
            } else {
                for (const line of page.lines) {
                    node.appendChild(el('div', { class: 'line', text: line.text }));
                }
            }

            const images = state.settings.showImages
                ? page.images.map(imageById).filter(function (image) { return image && isRenderable(image.mime); })
                : [];
            if (images.length) {
                node.appendChild(el('div', { class: 'page-images' }, images.map(function (image) {
                    return el('img', { src: dataUri(image), alt: image.name, id: 'image-' + image.id });
                })));
            }

            if (!page.lines.length) {
                node.appendChild(el('div', {
                    class: 'page-empty',
                    text: page.error ? page.error : (images.length ? t('scannedHint') : t('emptyPage')),
                }));
            }
            content.appendChild(node);
        }
    }

    function scrollToPage(number) {
        const target = document.getElementById('page-' + number);
        if (target) { target.scrollIntoView({ block: 'start' }); }
    }

    function scrollToImage(id) {
        const target = document.getElementById('image-' + id);
        if (target) { target.scrollIntoView({ block: 'center' }); }
    }

    // ---------- Excel / CSV ----------

    function renderSheets(content, model) {
        if (state.sheetIndex >= model.sheets.length) { state.sheetIndex = 0; }

        if (model.sheets.length > 1) {
            const tabs = el('div', { class: 'sheet-tabs' }, model.sheets.map(function (sheet, index) {
                return el('div', {
                    class: 'sheet-tab' + (index === state.sheetIndex ? ' active' : ''),
                    text: sheet.name,
                    onclick: function () { state.sheetIndex = index; state.rowLimit = INITIAL_ROWS; render(); },
                });
            }));
            content.appendChild(tabs);
        }

        const sheet = model.sheets[state.sheetIndex];
        if (!sheet) { return; }

        const shown = sheet.rows.length;
        const shownCols = sheet.rows.length ? sheet.rows[0].length : 0;
        if (sheet.truncated) {
            const notes = [];
            if (shown < sheet.totalRows) { notes.push(t('rowsTruncated', shown, sheet.totalRows)); }
            if (shownCols < sheet.totalCols) { notes.push(t('colsTruncated', shownCols, sheet.totalCols)); }
            content.appendChild(el('div', { class: 'notice', text: notes.join(' ') }));
        }

        content.appendChild(buildGrid(sheet));

        // Cok satirli sayfalar webview'i yormasin: kalan satirlar istek uzerine cizilir.
        if (sheet.rows.length > state.rowLimit) {
            const remaining = sheet.rows.length - state.rowLimit;
            content.appendChild(el("button", {
                class: "btn",
                text: t("showMoreRows", Math.min(remaining, ROW_STEP), remaining),
                onclick: function () { state.rowLimit += ROW_STEP; render(); },
            }));
        }
    }

    const INITIAL_ROWS = 1000;
    const ROW_STEP = 2000;

    function buildGrid(sheet) {
        const columnCount = sheet.rows.length ? sheet.rows[0].length : 0;
        const rowCount = Math.min(sheet.rows.length, state.rowLimit);
        const table = el('table', { class: 'grid', style: { fontSize: (12 * state.zoom) + 'px' } });

        const headCells = [el('th', { text: '' })];
        for (let c = 0; c < columnCount; c++) {
            headCells.push(el('th', { text: columnName(c) }));
        }
        table.appendChild(el('thead', {}, [el('tr', {}, headCells)]));

        const body = el('tbody');
        const skip = {};
        for (let r = 0; r < rowCount; r++) {
            const cells = [el('th', { class: 'rowhead', text: String(r + 1) })];
            for (let c = 0; c < columnCount; c++) {
                if (skip[r + ':' + c]) { continue; }
                const cell = sheet.rows[r][c];
                cells.push(buildCell(cell, r, c, skip, sheet.headerRow && r === 0));
            }
            body.appendChild(el('tr', {}, cells));
        }
        table.appendChild(body);
        return el('div', { class: 'grid-wrap' }, [table]);
    }

    function buildCell(cell, row, column, skip, isHeaderRow) {
        const props = { class: '' };
        if (!cell) { return el('td', {}); }

        const classes = [];
        if (cell.align === 'r' || cell.t === 'n' || cell.t === 'd') { classes.push('n'); }
        if (cell.align === 'c') { classes.push('c'); }
        if (cell.f) { classes.push('formula'); }
        if (isHeaderRow) { classes.push('header-cell'); }
        props.class = classes.join(' ') || undefined;

        if (cell.cs && cell.cs > 1) { props.colspan = String(cell.cs); }
        if (cell.rs && cell.rs > 1) { props.rowspan = String(cell.rs); }
        // Birlestirilmis alanin kapsadigi hucreler tekrar cizilmez.
        for (let dr = 0; dr < (cell.rs || 1); dr++) {
            for (let dc = 0; dc < (cell.cs || 1); dc++) {
                if (dr || dc) { skip[(row + dr) + ':' + (column + dc)] = true; }
            }
        }

        const style = {};
        if (cell.b) { style.fontWeight = '700'; }
        if (cell.i) { style.fontStyle = 'italic'; }
        if (cell.color) { style.color = cell.color; }
        if (cell.bg) { style.backgroundColor = cell.bg; }
        props.style = style;
        props.title = cell.f ? cell.f : (cell.v.length > 40 ? cell.v : undefined);
        props.text = cell.v;

        return el(isHeaderRow ? 'th' : 'td', props);
    }

    /** 0 -> A, 25 -> Z, 26 -> AA */
    function columnName(index) {
        let name = '';
        let n = index + 1;
        while (n > 0) {
            const rem = (n - 1) % 26;
            name = String.fromCharCode(65 + rem) + name;
            n = Math.floor((n - 1) / 26);
        }
        return name;
    }


    // ---------- JSONL ----------

    const JSON_RECORD_STEP = 200;

    function renderJson(content, model) {
        const set = model.json;
        const wrap = el('div', { class: 'records' });
        const shown = Math.min(state.rowLimit, set.records.length);

        for (let i = 0; i < shown; i++) {
            wrap.appendChild(buildRecord(set.records[i], i + 1, set.labelKeys));
        }
        content.appendChild(wrap);

        if (shown < set.records.length) {
            content.appendChild(el('div', { class: 'more' }, [
                el('button', {
                    class: 'btn',
                    text: t('showMoreRows', Math.min(JSON_RECORD_STEP, set.records.length - shown), set.records.length - shown),
                    onclick: function () { state.rowLimit += JSON_RECORD_STEP; render(); },
                }),
            ]));
        }
        if (set.truncated) {
            content.appendChild(el('div', { class: 'notice', text: t('recordsTruncated', set.records.length, set.totalRecords) }));
        }
    }

    /** Tek kayit: katlanabilir baslik + JSON agaci. */
    function buildRecord(value, index, labelKeys) {
        const box = el('div', { class: 'record' });
        const summary = summarize(value, labelKeys);
        const caret = el('span', { class: 'caret', text: '\u25b8' });
        const body = el('div', { class: 'record-body hidden' });

        const head = el('div', { class: 'record-head' }, [
            caret,
            el('span', { class: 'record-index', text: String(index) }),
            el('span', { class: 'record-summary', text: summary }),
        ]);
        head.addEventListener('click', function () {
            const open = body.classList.toggle('hidden');
            caret.textContent = open ? '\u25b8' : '\u25be';
            if (!open && !body.firstChild) { body.appendChild(buildJsonNode(value, 0)); }
        });

        box.appendChild(head);
        box.appendChild(body);
        return box;
    }

    /** Katli kaydin basliginda gorunecek tek satirlik ozet. */
    function summarize(value, labelKeys) {
        if (value === null || typeof value !== 'object') { return String(value); }
        if (Array.isArray(value)) { return '[' + value.length + ']'; }

        const parts = [];
        for (const key of labelKeys) {
            if (value[key] !== undefined && typeof value[key] !== 'object') {
                parts.push(key + '=' + String(value[key]));
            }
        }
        if (!parts.length) {
            for (const key of Object.keys(value).slice(0, 3)) {
                const item = value[key];
                parts.push(key + '=' + (item === null || typeof item !== 'object' ? String(item) : Array.isArray(item) ? '[...]' : '{...}'));
            }
        }
        const text = parts.join('  ');
        return text.length > 220 ? text.slice(0, 220) + '...' : text;
    }

    /** JSON degerini ic ice katlanabilir dugumlere cevirir. */
    function buildJsonNode(value, depth) {
        if (value === null) { return el('span', { class: 'json-null', text: 'null' }); }
        const type = typeof value;
        if (type === 'string') { return el('span', { class: 'json-string', text: value }); }
        if (type === 'number') { return el('span', { class: 'json-number', text: String(value) }); }
        if (type === 'boolean') { return el('span', { class: 'json-bool', text: String(value) }); }

        const isArray = Array.isArray(value);
        const entries = isArray
            ? value.map(function (item, i) { return [String(i), item]; })
            : Object.entries(value);

        if (!entries.length) { return el('span', { class: 'json-null', text: isArray ? '[]' : '{}' }); }

        return el('div', { class: 'json-branch' }, entries.map(function (pair) {
            const key = pair[0];
            const item = pair[1];
            const nested = item !== null && typeof item === 'object';
            const row = el('div', { class: 'json-row' });
            const label = el('span', { class: isArray ? 'json-index' : 'json-key', text: key });

            if (!nested) {
                row.appendChild(label);
                row.appendChild(buildJsonNode(item, depth + 1));
                return row;
            }

            const count = Array.isArray(item) ? item.length : Object.keys(item).length;
            const caret = el('span', { class: 'caret', text: depth < 1 ? '\u25be' : '\u25b8' });
            const child = el('div', { class: 'json-children' + (depth < 1 ? '' : ' hidden') });
            if (depth < 1) { child.appendChild(buildJsonNode(item, depth + 1)); }

            const head = el('div', { class: 'json-head' }, [
                caret,
                label,
                el('span', { class: 'json-meta', text: (Array.isArray(item) ? '[' + count + ']' : '{' + count + '}') }),
            ]);
            head.addEventListener('click', function () {
                const open = child.classList.toggle('hidden');
                caret.textContent = open ? '\u25b8' : '\u25be';
                if (!open && !child.firstChild) { child.appendChild(buildJsonNode(item, depth + 1)); }
            });

            row.appendChild(head);
            row.appendChild(child);
            return row;
        }));
    }

    // ---------- arama ----------

    const MAX_HITS = 2000;

    function clearMarks(root) {
        const marks = root.querySelectorAll('mark.hit');
        for (let i = 0; i < marks.length; i++) {
            const mark = marks[i];
            const parent = mark.parentNode;
            parent.replaceChild(document.createTextNode(mark.textContent), mark);
            parent.normalize();
        }
    }

    function runFind(term) {
        state.find.term = term;
        state.find.nodes = [];
        state.find.index = 0;

        const content = document.querySelector('.content');
        if (!content) { return; }
        clearMarks(content);

        const needle = term.toLocaleLowerCase();
        if (needle.length < 2) { updateFindCount(); return; }

        // Once eslesen metin dugumleri toplanir; DOM yalnizca sonra degistirilir.
        const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null);
        const targets = [];
        let node = walker.nextNode();
        while (node) {
            if (node.nodeValue && node.nodeValue.toLocaleLowerCase().indexOf(needle) >= 0) {
                targets.push(node);
            }
            node = walker.nextNode();
        }

        for (const target of targets) {
            if (state.find.nodes.length >= MAX_HITS) { break; }
            highlightNode(target, needle);
        }
        updateFindCount();
        if (state.find.nodes.length) { focusHit(0); }
    }

    function highlightNode(textNode, needle) {
        let current = textNode;
        let value = current.nodeValue.toLocaleLowerCase();
        let offset = value.indexOf(needle);
        while (offset >= 0 && state.find.nodes.length < MAX_HITS) {
            const tail = current.splitText(offset);
            const rest = tail.splitText(needle.length);
            const mark = document.createElement('mark');
            mark.className = 'hit';
            mark.textContent = tail.nodeValue;
            tail.parentNode.replaceChild(mark, tail);
            state.find.nodes.push(mark);

            current = rest;
            value = current.nodeValue.toLocaleLowerCase();
            offset = value.indexOf(needle);
        }
    }

    function stepFind(delta) {
        if (!state.find.nodes.length) { return; }
        const next = (state.find.index + delta + state.find.nodes.length) % state.find.nodes.length;
        focusHit(next);
    }

    function focusHit(index) {
        const nodes = state.find.nodes;
        if (!nodes.length) { return; }
        if (nodes[state.find.index]) { nodes[state.find.index].classList.remove('current'); }
        state.find.index = index;
        const target = nodes[index];
        target.classList.add('current');
        target.scrollIntoView({ block: 'center' });
        updateFindCount();
    }

    function updateFindCount() {
        const label = document.getElementById('findCount');
        if (!label) { return; }
        const total = state.find.nodes.length;
        if (!state.find.term || state.find.term.length < 2) { label.textContent = ''; return; }
        label.textContent = total ? t('findMatches', state.find.index + 1, total) : t('findNoResults');
    }

    // ---------- gorunum durumu ----------

    let saveTimer = null;
    let pendingView = null;

    function saveScroll(content) {
        return function () {
            if (saveTimer) { clearTimeout(saveTimer); }
            saveTimer = setTimeout(function () {
                const view = {
                    scrollTop: content.scrollTop,
                    zoom: state.zoom,
                    sheetIndex: state.sheetIndex,
                    sidebarVisible: state.sidebarVisible,
                    sidebarTab: state.sidebarTab,
                };
                vscode.setState(view);
                vscode.postMessage({ type: 'saveViewState', state: view });
            }, 300);
        };
    }

    function restoreScroll(content) {
        const view = pendingView || vscode.getState();
        pendingView = null;
        if (!view) { return; }
        if (typeof view.scrollTop === 'number') {
            requestAnimationFrame(function () { content.scrollTop = view.scrollTop; });
        }
    }

    function applyViewState(view) {
        if (!view) { return; }
        if (typeof view.zoom === 'number') { state.zoom = Math.min(3, Math.max(0.4, view.zoom)); }
        if (typeof view.sheetIndex === 'number') { state.sheetIndex = view.sheetIndex; }
        if (typeof view.sidebarVisible === 'boolean') { state.sidebarVisible = view.sidebarVisible; }
        if (typeof view.sidebarTab === 'string') { state.sidebarTab = view.sidebarTab; }
        pendingView = view;
    }

    // ---------- mesajlar ----------

    window.addEventListener('message', function (event) {
        const message = event.data;
        try {
            switch (message.type) {
                case 'loading':
                    if (message.strings) { state.strings = message.strings; }
                    showLoading();
                    break;
                case 'document':
                    state.model = message.model;
                    state.settings = message.settings;
                    state.app = message.app || state.app;
                    state.strings = message.strings;
                    applyViewState(message.viewState || vscode.getState());
                    render();
                    break;
                case 'failure':
                    state.model = null;
                    if (message.strings) { state.strings = message.strings; }
                    showFailure(message.message, message.detail);
                    break;
                case 'settings':
                    state.settings = message.settings;
                    state.app = message.app || state.app;
                    state.strings = message.strings;
                    if (state.model) { render(); }
                    break;
                default:
                    break;
            }
        } catch (err) {
            vscode.postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
        }
    });

    window.addEventListener('keydown', function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
            const input = document.querySelector('.find input');
            if (input) { input.focus(); input.select(); event.preventDefault(); }
        }
    });

    showLoading();
    vscode.postMessage({ type: 'ready' });
})();
