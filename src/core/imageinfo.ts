/** Gorsel basliklarindan boyut okuma (bagimliliksiz). Cozulemezse undefined doner. */
export interface ImageSize {
    width: number;
    height: number;
}

export function imageSize(buf: Buffer): ImageSize | undefined {
    return png(buf) ?? jpeg(buf) ?? gif(buf) ?? bmp(buf) ?? webp(buf);
}

function png(buf: Buffer): ImageSize | undefined {
    if (buf.length < 24) { return undefined; }
    if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) { return undefined; }
    if (buf.toString('latin1', 12, 16) !== 'IHDR') { return undefined; }
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpeg(buf: Buffer): ImageSize | undefined {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) { return undefined; }
    let pos = 2;
    while (pos + 9 < buf.length) {
        if (buf[pos] !== 0xff) { pos++; continue; }
        const marker = buf[pos + 1];
        // SOF0..SOF15, yeniden baslatma (D0-D9) ve APP disi cerceve basliklari boyut tasir.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { pos += 2; continue; }
        const length = buf.readUInt16BE(pos + 2);
        if (length < 2) { return undefined; }
        pos += 2 + length;
    }
    return undefined;
}

function gif(buf: Buffer): ImageSize | undefined {
    if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'GIF') { return undefined; }
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function bmp(buf: Buffer): ImageSize | undefined {
    if (buf.length < 26 || buf[0] !== 0x42 || buf[1] !== 0x4d) { return undefined; }
    return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
}

function webp(buf: Buffer): ImageSize | undefined {
    if (buf.length < 30 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
        return undefined;
    }
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
        const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
        const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
        return { width: w + 1, height: h + 1 };
    }
    return undefined;
}
