import { PngRgbaEncoder, JpegDecoder } from '@xinonix/easi-js/codecs';

const value = (set, tag, fallback) => set[tag]?.Value?.[0] ?? fallback;
const number = (set, tag, fallback) => Number(value(set, tag, fallback));
const unsupported = message => Object.assign(new Error(message), { statusCode: 415 });

function validateJpeg(bytes, rows, columns, samples, photometric) {
    if (bytes[0] !== 255 || bytes[1] !== 216) throw unsupported('Missing JPEG start marker.');
    let offset = 2, found = false;
    while (offset < bytes.length) {
        if (bytes[offset++] !== 255) throw unsupported('Invalid JPEG header.');
        while (bytes[offset] === 255) offset++;
        const marker = bytes[offset++];
        if (marker === 0xDA) break;
        if ([0xD9, 0xD8, 0x00].includes(marker) || offset + 2 > bytes.length) throw unsupported('Invalid JPEG marker.');
        const length = (bytes[offset] << 8) | bytes[offset + 1];
        if (length < 2 || offset + length > bytes.length) throw unsupported('Truncated JPEG header.');
        if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
            if (marker !== 0xC0 || length < 8 || bytes[offset + 2] !== 8 || ((bytes[offset + 3] << 8) | bytes[offset + 4]) !== rows || ((bytes[offset + 5] << 8) | bytes[offset + 6]) !== columns || bytes[offset + 7] !== samples) throw unsupported('JPEG header does not match the supported image geometry.');
            found = true;
        }
        if (marker === 0xE2 && Buffer.from(bytes.subarray(offset + 2, offset + Math.min(length, 14))).toString('ascii').startsWith('ICC_PROFILE')) throw unsupported('JPEG ICC profiles are outside the thumbnail profile.');
        if (marker === 0xEE && length >= 14 && Buffer.from(bytes.subarray(offset + 2, offset + 7)).toString('ascii') === 'Adobe' && bytes[offset + 13] !== (photometric.startsWith('YBR') ? 1 : 0)) throw unsupported('JPEG color transform conflicts with DICOM metadata.');
        offset += length;
    }
    if (!found) throw unsupported('Missing baseline JPEG frame header.');
}

/** Bounded representative previews. This is a declared thumbnail display
 * profile, separate from preservation and the EASI View image profiles. */
export function renderThumbnail(bytes, metadata, transferSyntaxUid, frameNumber = 1, size = 128) {
    if (!Number.isInteger(size) || size < 1 || size > 512) throw unsupported('Thumbnail size must be an integer from 1 to 512.');
    const rows = number(metadata, '00280010'), columns = number(metadata, '00280011');
    const samples = number(metadata, '00280002', 1), allocated = number(metadata, '00280100');
    const stored = number(metadata, '00280101', allocated), high = number(metadata, '00280102', stored - 1);
    const signed = number(metadata, '00280103', 0), planar = number(metadata, '00280006', 0);
    const photometric = value(metadata, '00280004', '');
    if (![rows, columns].every(v => Number.isSafeInteger(v) && v > 0 && v <= 8192) || rows * columns > 16 * 1024 * 1024) throw unsupported('The thumbnail image dimensions exceed the supported profile.');
    const perFrame = metadata['52009230']?.Value?.[frameNumber - 1] || {}, shared = metadata['52009229']?.Value?.[0] || {};
    const transform = perFrame['00289145']?.Value?.[0] || shared['00289145']?.Value?.[0] || metadata;
    const voi = perFrame['00289132']?.Value?.[0] || shared['00289132']?.Value?.[0] || metadata;
    if (metadata['00283000'] || metadata['00283010'] || transform['00283000'] || voi['00283010'] || metadata['00282000'] || metadata['20500010']) throw unsupported('This image requires a LUT or color profile outside the thumbnail profile.');
    const presentation = value(metadata, '20500020', null);
    if (presentation != null && !['IDENTITY', 'INVERSE'].includes(presentation)) throw unsupported('This presentation LUT shape is unsupported by thumbnails.');
    // Presentation LUT Shape already accounts for Photometric Interpretation
    // (e.g. DX MONOCHROME1 requires INVERSE). Applying both would invert twice.
    const inverse = presentation == null ? photometric === 'MONOCHROME1' : presentation === 'INVERSE';
    let rgb, scalar;
    if (transferSyntaxUid === '1.2.840.10008.1.2.4.50') {
        if (allocated !== 8 || stored !== 8 || high !== 7 || signed !== 0 || !(samples === 1 && ['MONOCHROME1', 'MONOCHROME2'].includes(photometric) || samples === 3 && planar === 0 && ['YBR_FULL', 'YBR_FULL_422'].includes(photometric))) throw unsupported('This JPEG image is outside the 8-bit thumbnail profile.');
        validateJpeg(bytes, rows, columns, samples, photometric);
        // EASI supplies the JPEG codec and PNG encoder; no second image toolkit.
        const decoded = new JpegDecoder(null).decodeImage(bytes);
        if (decoded.width !== columns || decoded.height !== rows || decoded.bytes.length !== rows * columns * 4) throw unsupported('JPEG dimensions do not match DICOM metadata.');
        if (samples === 1) scalar = Float64Array.from({ length: rows * columns }, (_, i) => decoded.bytes[i * 4]);
        else rgb = decoded.bytes;
    } else {
        if (!['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2'].includes(transferSyntaxUid)) throw unsupported('Thumbnails currently support native pixels and 8-bit baseline JPEG. Open the original in EASI View for other supported encodings.');
        // MetadataService.frameChunks normalizes native words to little endian.
        if (![8, 16].includes(allocated) || !Number.isInteger(stored) || stored < 1 || stored > allocated || !Number.isInteger(high) || high < stored - 1 || high >= allocated || ![0, 1].includes(signed)) throw unsupported('Unsupported native thumbnail sample layout.');
        const count = rows * columns;
        if (samples === 1 && ['MONOCHROME1', 'MONOCHROME2'].includes(photometric)) {
            if (bytes.length !== count * allocated / 8) throw unsupported('Native frame byte count does not match its dimensions.');
            const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), shift = high + 1 - stored, mask = 2 ** stored - 1;
            scalar = Float64Array.from({ length: count }, (_, i) => {
                let raw = ((allocated === 8 ? bytes[i] : data.getUint16(i * 2, true)) >>> shift) & mask;
                if (signed && raw >= 2 ** (stored - 1)) raw -= 2 ** stored;
                return raw;
            });
        } else if (samples === 3 && allocated === 8 && stored === 8 && !signed && [0, 1].includes(planar) && ['RGB', 'YBR_FULL', 'YBR_FULL_422'].includes(photometric)) {
            const packed = photometric === 'YBR_FULL_422';
            if (packed && (columns % 2 || planar) || bytes.length !== count * (packed ? 2 : 3)) throw unsupported('Unsupported native color frame layout.');
            rgb = new Uint8Array(count * 4);
            const clamp = n => Math.max(0, Math.min(255, Math.round(n)));
            for (let i = 0; i < count; i++) {
                const p = packed ? Math.floor(i / 2) * 4 : i * 3;
                const a = packed ? bytes[p + i % 2] : planar ? bytes[i] : bytes[p];
                const b = packed ? bytes[p + 2] : planar ? bytes[count + i] : bytes[p + 1];
                const c = packed ? bytes[p + 3] : planar ? bytes[count * 2 + i] : bytes[p + 2];
                rgb.set(photometric === 'RGB' ? [a, b, c, 255] : [clamp(a + 1.402 * (c - 128)), clamp(a - .344136 * (b - 128) - .714136 * (c - 128)), clamp(a + 1.772 * (b - 128)), 255], i * 4);
            }
        } else throw unsupported('This photometric interpretation requires a different thumbnail profile.');
    }
    let center = number(voi, '00281050', NaN), width = number(voi, '00281051', NaN);
    const slope = number(transform, '00281053', 1), intercept = number(transform, '00281052', 0);
    const functionName = value(voi, '00281056', 'LINEAR');
    let paddingLow = NaN, paddingHigh = NaN;
    if (scalar) {
        if (!Number.isFinite(slope) || slope === 0 || !Number.isFinite(intercept) || !['LINEAR', 'LINEAR_EXACT', 'SIGMOID'].includes(functionName)) throw unsupported('Invalid scalar display transformation.');
        let min = Infinity, max = -Infinity;
        const padding = number(metadata, '00280120', NaN), paddingEnd = number(metadata, '00280121', padding);
        paddingLow = Math.min(padding * slope + intercept, paddingEnd * slope + intercept);
        paddingHigh = Math.max(padding * slope + intercept, paddingEnd * slope + intercept);
        for (let i = 0; i < scalar.length; i++) {
            const raw = scalar[i]; scalar[i] = raw * slope + intercept;
            if (!(raw >= Math.min(padding, paddingEnd) && raw <= Math.max(padding, paddingEnd))) { min = Math.min(min, scalar[i]); max = Math.max(max, scalar[i]); }
        }
        const hasWindow = Boolean(voi['00281050']?.Value?.length || voi['00281051']?.Value?.length);
        if (hasWindow && (!Number.isFinite(center) || !Number.isFinite(width) || width < (functionName === 'LINEAR' ? 1 : Number.MIN_VALUE))) throw unsupported('The declared window center or width is invalid.');
        if (!hasWindow) {
            if (!Number.isFinite(min)) { min = 0; max = 1; }
            center = (min + max + (functionName === 'LINEAR' ? 1 : 0)) / 2; width = Math.max(1, max - min + (functionName === 'LINEAR' ? 1 : 0));
        }
    }
    const spacing = (perFrame['00289110']?.Value?.[0] || shared['00289110']?.Value?.[0] || metadata)['00280030']?.Value ?? metadata['00181164']?.Value ?? metadata['00182010']?.Value ?? metadata['00280034']?.Value;
    const ratio = spacing?.length === 2 && spacing.every(n => Number.isFinite(Number(n)) && Number(n) > 0) ? Number(spacing[0]) / Number(spacing[1]) : 1;
    const scale = Math.min(size / columns, size / (rows * ratio));
    const outputWidth = Math.max(1, Math.min(size, Math.round(columns * scale))), outputHeight = Math.max(1, Math.min(size, Math.round(rows * ratio * scale)));
    const rgba = new Uint8Array(outputWidth * outputHeight * 4);
    for (let y = 0; y < outputHeight; y++) for (let x = 0; x < outputWidth; x++) {
        const source = Math.min(rows - 1, Math.floor(y * rows / outputHeight)) * columns + Math.min(columns - 1, Math.floor(x * columns / outputWidth));
        const target = (y * outputWidth + x) * 4;
        if (rgb) rgba.set(rgb.subarray(source * 4, source * 4 + 4), target);
        else {
            const input = scalar[source]; let intensity;
            if (functionName === 'SIGMOID') intensity = 255 / (1 + Math.exp(-4 * (input - center) / width));
            else if (functionName === 'LINEAR_EXACT') intensity = ((input - center) / width + .5) * 255;
            else intensity = width <= 1 ? input <= center - .5 ? 0 : 255 : ((input - (center - .5)) / (width - 1) + .5) * 255;
            intensity = Math.max(0, Math.min(255, Math.round(intensity)));
            if (input >= paddingLow && input <= paddingHigh) intensity = 0;
            else if (inverse) intensity = 255 - intensity;
            rgba.set([intensity, intensity, intensity, 255], target);
        }
    }
    return new PngRgbaEncoder().encode(rgba, outputWidth, outputHeight).bytes;
}
