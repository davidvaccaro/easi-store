// Small independent test-only ZIP/ZIP64 reader. Production uses yazl; tests
// inspect central-directory fields and CRCs without sharing its implementation.
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';

export function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

export function readZip(bytes) {
    const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(end >= 0 && end + 22 <= bytes.length, 'a complete ZIP requires its end record');
    assert.equal(bytes.readUInt16LE(end + 4), 0); assert.equal(bytes.readUInt16LE(end + 6), 0);
    assert.equal(end + 22 + bytes.readUInt16LE(end + 20), bytes.length, 'no unexpected trailing bytes');
    let count = bytes.readUInt16LE(end + 10), directoryLength = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16), zip64 = false;
    if (count === 0xffff || directoryLength === 0xffffffff || offset === 0xffffffff) {
        zip64 = true;
        assert.equal(bytes.readUInt32LE(end - 20), 0x07064b50);
        assert.equal(bytes.readUInt32LE(end - 16), 0); assert.equal(bytes.readUInt32LE(end - 4), 1);
        const record = Number(bytes.readBigUInt64LE(end - 12));
        assert.equal(bytes.readUInt32LE(record), 0x06064b50); assert.equal(bytes.readUInt32LE(record + 16), 0);
        count = Number(bytes.readBigUInt64LE(record + 32)); directoryLength = Number(bytes.readBigUInt64LE(record + 40)); offset = Number(bytes.readBigUInt64LE(record + 48));
    }
    const directoryEnd = offset + directoryLength, entries = new Map();
    for (let index = 0; index < count; index++) {
        assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
        const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16);
        let compressedSize = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24), local = bytes.readUInt32LE(offset + 42);
        const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
        const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
        assert.equal(flags & 1, 0, 'entries are not encrypted'); assert.ok(!entries.has(name));
        let extension = offset + 46 + nameLength;
        while (extension < offset + 46 + nameLength + extraLength) {
            const type = bytes.readUInt16LE(extension), length = bytes.readUInt16LE(extension + 2); extension += 4;
            if (type === 1) {
                let field = extension;
                if (size === 0xffffffff) { size = Number(bytes.readBigUInt64LE(field)); field += 8; }
                if (compressedSize === 0xffffffff) { compressedSize = Number(bytes.readBigUInt64LE(field)); field += 8; }
                if (local === 0xffffffff) local = Number(bytes.readBigUInt64LE(field));
            }
            extension += length;
        }
        assert.equal(bytes.readUInt32LE(local), 0x04034b50);
        const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28), encoded = bytes.subarray(start, start + compressedSize);
        assert.equal(encoded.length, compressedSize);
        const data = method === 0 ? encoded : method === 8 ? inflateRawSync(encoded) : assert.fail('unsupported test ZIP compression');
        assert.equal(data.length, size); assert.equal(crc32(data), crc, `CRC32 of ${name}`);
        entries.set(name, { data, method, size, compressedSize });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    assert.equal(offset, directoryEnd); return { zip64, entries };
}
