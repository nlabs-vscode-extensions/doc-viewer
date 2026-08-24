/**
 * media/viewer.js'i Node icinde calistirmaya yetecek kadar kucuk bir DOM taklidi.
 *
 * Amac tarayiciyi taklit etmek DEGIL; cizim yollarinda cokme (tanimsiz fonksiyon,
 * yanlis ozellik, null erisimi) yakalamak. Gercek gorsel dogrulama VS Code'da yapilir.
 */

class ClassList {
    constructor(node) { this.node = node; }
    get set() { return new Set((this.node.className || '').split(/\s+/).filter(Boolean)); }
    write(set) { this.node.className = [...set].join(' '); }
    add(...names) { const s = this.set; names.forEach((n) => s.add(n)); this.write(s); }
    remove(...names) { const s = this.set; names.forEach((n) => s.delete(n)); this.write(s); }
    contains(name) { return this.set.has(name); }
    toggle(name, force) {
        const has = this.contains(name);
        const next = force === undefined ? !has : force;
        if (next) { this.add(name); } else { this.remove(name); }
        return next;
    }
}

/** style nesnesi: hem ozellik atamasi hem setProperty kullanilir. */
function makeStyle() {
    const store = {};
    store.setProperty = (name, value) => { store[name] = value; };
    store.getPropertyValue = (name) => store[name] ?? "";
    store.removeProperty = (name) => { delete store[name]; };
    return store;
}

class Node {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.attributes = {};
        this.className = '';
        this.style = makeStyle();
        this.listeners = {};
        this.parentNode = null;
        this._text = '';
        this.classList = new ClassList(this);
    }
    get firstChild() { return this.children[0] ?? null; }
    get textContent() {
        return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
    }
    set textContent(value) { this.children = []; this._text = String(value); }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) { this.children.splice(index, 1); child.parentNode = null; }
        return child;
    }
    replaceChild(next, old) {
        const index = this.children.indexOf(old);
        if (index >= 0) { this.children[index] = next; next.parentNode = this; }
        return old;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') { this.id = String(value); } }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); }
    removeEventListener() { /* gerekmiyor */ }
    normalize() { /* gerekmiyor */ }
    scrollIntoView() { /* gerekmiyor */ }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    querySelectorAll(selector) {
        const matchers = selector.split(',').map((part) => part.trim()).filter(Boolean);
        const out = [];
        const visit = (node) => {
            for (const child of node.children) {
                if (matchers.some((m) => matches(child, m))) { out.push(child); }
                visit(child);
            }
        };
        visit(this);
        return out;
    }
    /** Sadece test amacli: agactaki tum dugumler. */
    walk(fn) { for (const child of this.children) { fn(child); child.walk(fn); } }
}

class TextNode {
    constructor(value) { this.nodeValue = String(value); this.parentNode = null; this.children = []; }
    get textContent() { return this.nodeValue; }
    walk() { /* yaprak */ }
}

function matches(node, selector) {
    // Desteklenen: "tag", ".class", "tag.class" ve bunlarin bosluksuz birlesimi.
    const parts = selector.split('.');
    const tag = parts.shift();
    if (tag && node.tagName !== tag.toUpperCase()) { return false; }
    return parts.every((cls) => node.classList && node.classList.contains(cls));
}

export function createDom() {
    const root = new Node('div');
    root.setAttribute('id', 'app');

    const document = {
        body: Object.assign(new Node('body'), { classList: undefined }),
        createElement: (tag) => new Node(tag),
        createTextNode: (value) => new TextNode(value),
        getElementById: (id) => (id === 'app' ? root : root.querySelectorAll('*').find((n) => n.id === id) ?? null),
        querySelector: (selector) => root.querySelector(selector),
        querySelectorAll: (selector) => root.querySelectorAll(selector),
        createTreeWalker: () => ({ nextNode: () => null }),
    };
    document.body.classList = new ClassList(document.body);
    document.body.className = 'vscode-light';

    const posted = [];
    const globals = {
        document,
        window: {
            addEventListener: (type, handler) => {
                if (type === (String.fromCharCode(109) + "essage")) { globals.window.__messageListener = handler; }
            },
        },
        requestAnimationFrame: (fn) => fn(),
        setTimeout: (fn) => fn,
        clearTimeout: () => {},
        NodeFilter: { SHOW_TEXT: 4 },
        acquireVsCodeApi: () => ({
            postMessage: (message) => posted.push(message),
            setState: () => {},
            getState: () => null,
        }),
    };
    return { root, document, globals, posted };
}
