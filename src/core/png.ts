import * as zlib from 'node:zlib';

/**
 * Kucuk PNG kodlayici.
 *
 * PDF'ten cikan ham ornekleri (sample) tarayicida gosterilebilir bir bicime
 * cevirmek icin gerekir. Yalnizca gri, gri+alfa, RGB ve RGBA, 8 bit derinlik.
 */

export type PngColorType = 0 | 2 | 4 | 6;

export const PNG_GRAY: PngColorType = 0;
export const PNG_RGB: PngColorType = 2;
export const PNG_GRAY_ALPHA: PngColorType = 4;
export const PNG_RGBA: PngColorType = 6;

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    return table;
})();

function crc32(buf: Buffer): number {
    let c = -1;
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function channelsFor(colorType: PngColorType): number {
    switch (colorType) {
        case PNG_GRAY: return 1;
        case PNG_RGB: return 3;
        case PNG_GRAY_ALPHA: return 2;
        default: return 4;
    }
}

/**
 * 8 bit derinlikli, suzgecsiz (filter 0) PNG uretir.
 * `samples` satir satir sikistirilmamis veri olmalidir.
 */
export function encodePng(samples: Buffer, width: number, height: number, colorType: PngColorType): Buffer {
    const channels = channelsFor(colorType);
    const rowLength = width * channels;
    const expected = rowLength * height;
    if (width <= 0 || height <= 0 || samples.length < expected) {
        throw new Error('PNG: ornek verisi eksik');
    }

    // Her satirin basina suzgec baytini (0 = None) ekle.
    const raw = Buffer.alloc((rowLength + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (rowLength + 1)] = 0;
        samples.copy(raw, y * (rowLength + 1) + 1, y * rowLength, (y + 1) * rowLength);
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;            // bit derinligi
    header[9] = colorType;
    header[10] = 0;           // sikistirma: deflate
    header[11] = 0;           // suzgec yontemi
    header[12] = 0;           // ic ice gecme yok

    return Buffer.concat([
        SIGNATURE,
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
