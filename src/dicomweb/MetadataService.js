import EASI from '@xinonix/easi-js';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { ArchiveError } from '../archive/errors.js';

const binaryVRs = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'UN']);
const pixelTags = new Set(['7FE00010', '7FE00008', '7FE00009']);
const charsetLabels = { '': 'utf-8', ISO_IR_6: 'utf-8', ISO_IR_100: 'windows-1252', ISO_IR_192: 'utf-8', ISO_IR_101: 'iso-8859-2', ISO_IR_144: 'iso-8859-5', ISO_IR_127: 'iso-8859-6', ISO_IR_126: 'iso-8859-7', ISO_IR_138: 'iso-8859-8', ISO_IR_148: 'windows-1254', GB18030: 'gb18030', GBK: 'gbk' };
const nativeSyntaxes = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']);
const compressionTypes = new Map([
  ['1.2.840.10008.1.2.5', 'image/dicom-rle'],
  ...['50', '51', '57', '70'].map(suffix => [`1.2.840.10008.1.2.4.${suffix}`, 'image/jpeg']),
  ...['80', '81'].map(suffix => [`1.2.840.10008.1.2.4.${suffix}`, 'image/jls']),
  ...['90', '91'].map(suffix => [`1.2.840.10008.1.2.4.${suffix}`, 'image/jp2']),
  ...['92', '93'].map(suffix => [`1.2.840.10008.1.2.4.${suffix}`, 'image/jpx']),
  ...['201', '202', '203'].map(suffix => [`1.2.840.10008.1.2.4.${suffix}`, 'image/jphc']),
]);

function abort(signal) { signal?.throwIfAborted(); }
function tagId(attribute) { return attribute.tag.ID.replace(/[^0-9A-F]/gi, '').toUpperCase(); }
function rawText(bytes, charset) { return new TextDecoder(charset).decode(bytes).replace(/\0/g, '').trimEnd(); }
function numberValues(bytes, vr, littleEndian) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numeric = { US: [2, 'getUint16'], SS: [2, 'getInt16'], UL: [4, 'getUint32'], SL: [4, 'getInt32'], FL: [4, 'getFloat32'], FD: [8, 'getFloat64'], UV: [8, 'getBigUint64'], SV: [8, 'getBigInt64'] }[vr];
  if (!numeric || bytes.length % numeric[0]) throw new ArchiveError('A numeric DICOM attribute has an invalid value length.', 422, 'invalid-metadata');
  const result = [];
  for (let offset = 0; offset < bytes.length; offset += numeric[0]) {
    const value = view[numeric[1]](offset, littleEndian);
    // PS3.18 permits strings for integer values beyond JSON's exact range.
    result.push(typeof value === 'bigint' ? value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString() : Number.isFinite(value) ? value : String(value));
  }
  return result;
}
function serializeSet(dataset, inheritedCharset = 'utf-8') {
  const charsetId = dataset['00080005']?._raw ? rawText(dataset['00080005']._raw, 'ascii').trim().replace(/\s+/g, '_') : null;
  if (charsetId != null && !(charsetId in charsetLabels)) throw new ArchiveError('The DICOM metadata uses a character set this preview cannot decode.', 422, 'unsupported-character-set');
  const charset = charsetId == null ? inheritedCharset : charsetLabels[charsetId];
  const result = {};
  for (const id of Object.keys(dataset).sort()) {
    const item = dataset[id];
    if (item.vr === 'SQ') { result[id] = { vr: 'SQ', Value: item.Value.map(child => serializeSet(child, charset)) }; continue; }
    if (item.BulkDataURI) { result[id] = { vr: item.vr, BulkDataURI: item.BulkDataURI }; continue; }
    const bytes = item._raw;
    const out = { vr: item.vr };
    if (bytes?.length) {
      if (['US', 'SS', 'UL', 'SL', 'FL', 'FD', 'UV', 'SV'].includes(item.vr)) out.Value = numberValues(bytes, item.vr, item._littleEndian);
      else if (item.vr === 'AT') {
        if (bytes.length % 4) throw new ArchiveError('A DICOM attribute tag value has an invalid length.', 422, 'invalid-metadata');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        out.Value = Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint16(i * 4, item._littleEndian).toString(16).padStart(4, '0').toUpperCase() + view.getUint16(i * 4 + 2, item._littleEndian).toString(16).padStart(4, '0').toUpperCase());
      } else {
        const text = rawText(bytes, charset);
        // LT, ST, UT and UR are single-valued and may contain literal '\\'.
        const values = ['LT', 'ST', 'UT', 'UR'].includes(item.vr) ? [text] : text.split('\\');
        out.Value = values.map(value => {
          if (!value) return null;
          if (item.vr === 'PN') {
            const [Alphabetic, Ideographic, Phonetic] = value.split('=');
            return { ...(Alphabetic ? { Alphabetic } : {}), ...(Ideographic ? { Ideographic } : {}), ...(Phonetic ? { Phonetic } : {}) };
          }
          if (item.vr === 'DS' || item.vr === 'IS') {
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) throw new ArchiveError('A DICOM decimal or integer string is invalid.', 422, 'invalid-metadata');
            return Number.isSafeInteger(parsed) || item.vr === 'DS' && !Number.isInteger(parsed) ? parsed : value.trim();
          }
          return value;
        });
      }
    }
    result[id] = out;
  }
  return result;
}

/** Complete dataset metadata is extracted through EASI's streaming handler seam.
 * Binary values remain file ranges; no parser fork or pixel decoding is involved.
 * Metadata is bounded independently of the encoded object's upload limit. */
export class MetadataService {
  constructor({ maxMetadataBytes = 8 * 1024 * 1024, maxValueBytes = 65536, maxAttributes = 100000, maxDepth = 64, maxConcurrent = 4, maxFrameBytes = 64 * 1024 * 1024, maxFragments = 100000, maxCacheBytes = 32 * 1024 * 1024, maxCacheEntries = 128 } = {}) {
    Object.assign(this, { maxMetadataBytes, maxValueBytes, maxAttributes, maxDepth, maxConcurrent, maxFrameBytes, maxFragments, maxCacheBytes, maxCacheEntries });
    this.active = 0;
    this.activePixelResponses = 0;
    this.activeMetadataResponses = 0;
    this.cache = new Map();
    this.cacheBytes = 0;
  }

  acquirePixelResponse() {
    if (this.activePixelResponses >= this.maxConcurrent) throw new ArchiveError('Pixel readers are busy; retry this request.', 503, 'pixel-readers-busy');
    this.activePixelResponses++;
    let released = false;
    return () => { if (!released) { released = true; this.activePixelResponses--; } };
  }

  acquireMetadataResponse() {
    if (this.activeMetadataResponses >= this.maxConcurrent) throw new ArchiveError('Metadata responses are busy; retry this request.', 503, 'metadata-busy');
    this.activeMetadataResponses++;
    let released = false;
    return () => { if (!released) { released = true; this.activeMetadataResponses--; } };
  }

  async read(record, { basePath = '/dicomweb', signal } = {}) {
    abort(signal);
    const file = await stat(record.path);
    const cacheKey = JSON.stringify([record.path, basePath, file.size, file.mtimeMs, file.ctimeMs]);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      abort(signal);
      this.cache.delete(cacheKey); this.cache.set(cacheKey, cached);
      return cached.value;
    }
    if (this.active >= this.maxConcurrent) throw new ArchiveError('Metadata readers are busy; retry this request.', 503, 'metadata-busy');
    this.active++;
    const root = {}, bulk = new Map(), stack = [{ dataset: root, path: '' }], sequences = [];
    let pipeline, current, attributes = 0, metadataBytes = 0, inMeta = true;
    const count = bytes => {
      metadataBytes += bytes;
      if (++attributes > this.maxAttributes || metadataBytes > this.maxMetadataBytes) throw new ArchiveError('The instance metadata exceeds the configured bounded metadata profile.', 413, 'metadata-too-large');
      abort(signal);
    };
    const location = `${basePath}/studies/${record.studyUid}/series/${record.seriesUid}/instances/${record.sopUid}/bulkdata`;
    const handler = {
      onStartInstance: () => ({}),
      onStartDataSet: () => { inMeta = false; },
      onStartSequence: (_context, sequence) => {
        if (inMeta) throw new ArchiveError('A sequence is invalid in File Meta Information.', 422, 'invalid-metadata');
        const parent = stack.at(-1), id = tagId(sequence);
        if (sequences.length >= this.maxDepth) throw new ArchiveError('The DICOM sequence nesting exceeds the metadata limit.', 413, 'metadata-too-deep');
        if (Object.hasOwn(parent.dataset, id)) throw new ArchiveError('The dataset contains a duplicate attribute.', 422, 'invalid-metadata');
        count(32);
        const value = { vr: 'SQ', Value: [] };
        parent.dataset[id] = value;
        sequences.push({ value, path: `${parent.path}${id}/` });
      },
      onStartItem: () => {
        const sequence = sequences.at(-1);
        if (!sequence) throw new ArchiveError('The DICOM sequence item has no parent.', 422, 'invalid-metadata');
        count(8);
        const dataset = {};
        stack.push({ dataset, path: `${sequence.path}${sequence.value.Value.length + 1}/` });
        sequence.value.Value.push(dataset);
      },
      onEndItem: () => { stack.pop(); },
      onEndSequence: () => { sequences.pop(); },
      onStartAttribute: (_context, attribute) => {
        abort(signal);
        const id = tagId(attribute), vr = attribute.vr?.ID ?? attribute.tag.VR.ID;
        current = { id, vr, ignored: inMeta || id.endsWith('0000'), chunks: [], length: 0 };
        if (current.ignored) return;
        const parent = stack.at(-1), path = `${parent.path}${id}`;
        if (Object.hasOwn(parent.dataset, id)) throw new ArchiveError('The dataset contains a duplicate attribute.', 422, 'invalid-metadata');
        const isBulk = binaryVRs.has(vr) || pixelTags.has(id) || attribute.valueLength > this.maxValueBytes;
        if (!isBulk && attribute.valueLength === 0xFFFFFFFF) throw new ArchiveError('An undefined-length nonbinary attribute is outside the metadata profile.', 422, 'invalid-metadata');
        count(isBulk ? 128 : attribute.valueLength + 32);
        if (isBulk) {
          const descriptor = { offset: pipeline.parser.bytesRead - pipeline.parser.data.length(), length: attribute.valueLength, vr, littleEndian: attribute.transferSyntax?.IsLittleEndian !== false, undefinedLength: attribute.valueLength === 0xFFFFFFFF, path };
          bulk.set(path, descriptor);
          parent.dataset[id] = { vr, BulkDataURI: `${location}/${path}` };
          current.bulk = descriptor;
        } else parent.dataset[id] = current.target = { vr, _raw: null, _littleEndian: attribute.transferSyntax?.IsLittleEndian !== false };
      },
      onAttributeChunk: (_context, payload) => {
        abort(signal);
        if (current?.ignored || current?.bulk) return;
        current.length += payload.chunk.length;
        if (current.length > this.maxValueBytes) throw new ArchiveError('An inline metadata value exceeds the metadata limit.', 413, 'metadata-too-large');
        current.chunks.push(Buffer.from(payload.chunk));
      },
      onEndAttribute: (_context, attribute) => {
        if (current?.target) current.target._raw = attribute.isBulkStreamed ? Buffer.concat(current.chunks, current.length) : Buffer.from(attribute.access());
        if (current?.bulk?.undefinedLength) {
          // The sequence delimiter is consumed before onEndAttribute. It is not
          // part of an encapsulated bulk value returned by Retrieve Bulkdata.
          current.bulk.length = pipeline.parser.bytesRead - pipeline.parser.data.length() - current.bulk.offset - 8;
        }
        current = null;
      },
      onProgress: () => abort(signal),
      onEndInstance: () => root,
    };
    const source = createReadStream(record.path, { highWaterMark: 64 * 1024, ...(signal ? { signal } : {}) });
    try {
      pipeline = EASI.pipelineBuilder().fromNodeStreamAdapter().ofDicomData({ includePart10Header: true }).withHandler(handler).build();
      pipeline.parser.bulkDataPolicy = { mode: 'auto', knownLengthThreshold: 0, hardSafetyCap: this.maxValueBytes + 1 };
      await pipeline.process({ source, sourceOptions: { contentType: 'application/dicom', contentLength: file.size } });
      abort(signal);
      const metadata = serializeSet(root);
      const bytes = Buffer.byteLength(JSON.stringify(metadata));
      if (bytes > this.maxMetadataBytes) throw new ArchiveError('Serialized metadata exceeds the metadata profile.', 413, 'metadata-too-large');
      const result = { metadata, bulk, transferSyntaxUid: record.transferSyntaxUid, pixel: bulk.get('7FE00010') ?? bulk.get('7FE00008') ?? bulk.get('7FE00009') ?? null };
      const estimatedBytes = bytes * 2 + bulk.size * 256;
      if (estimatedBytes <= this.maxCacheBytes && this.maxCacheEntries > 0) {
        while (this.cache.size && (this.cacheBytes + estimatedBytes > this.maxCacheBytes || this.cache.size >= this.maxCacheEntries)) {
          const oldest = this.cache.keys().next().value;
          this.cacheBytes -= this.cache.get(oldest).bytes; this.cache.delete(oldest);
        }
        this.cache.set(cacheKey, { bytes: estimatedBytes, value: result }); this.cacheBytes += estimatedBytes;
      }
      return result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof ArchiveError) throw error;
      throw new ArchiveError('The original instance does not contain structurally readable metadata.', 422, 'invalid-metadata');
    } finally { source.destroy(); this.active--; }
  }

  async frames(record, frameNumbers, options = {}) {
    const result = await this.read(record, options);
    const value = id => result.metadata[id]?.Value?.[0];
    const count = Number(value('00280008') ?? 1);
    if (!Number.isSafeInteger(count) || count < 1 || !result.pixel) throw new ArchiveError('The requested instance has no valid image frames.', 422, 'invalid-pixel-data');
    if (!frameNumbers.length || frameNumbers.length > 1000 || frameNumbers.some(frame => !Number.isSafeInteger(frame) || frame < 1 || frame > count)) throw new ArchiveError('Requested frame numbers must be 1-based and within Number of Frames (at most 1000 per request).', 400, 'invalid-frame');
    if (nativeSyntaxes.has(record.transferSyntaxUid)) {
      const rows = Number(value('00280010')), columns = Number(value('00280011')), samples = Number(value('00280002') ?? 1), bits = Number(value('00280100'));
      const photometric = value('00280004');
      let frameBits = rows * columns * samples * bits;
      if (photometric === 'YBR_FULL_422' || photometric === 'YBR_PARTIAL_422') frameBits = rows * columns * 2 * bits;
      if (![1, 8, 16, 32, 64].includes(bits) || ![rows, columns, samples, frameBits].every(number => Number.isSafeInteger(number) && number > 0) || result.pixel.undefinedLength) throw new ArchiveError('The native frame geometry is not supported.', 422, 'invalid-pixel-data');
      const frameBytes = Math.ceil(frameBits / 8), total = Math.ceil(frameBits * count / 8);
      if (frameBytes > this.maxFrameBytes) throw new ArchiveError('A decoded native frame exceeds the configured frame limit.', 413, 'frame-too-large');
      if (result.pixel.length !== total && !(total % 2 && result.pixel.length === total + 1)) throw new ArchiveError('The native Pixel Data length does not match image geometry and frame count.', 422, 'invalid-pixel-data');
      const bigEndian = record.transferSyntaxUid === '1.2.840.10008.1.2.2';
      const wordBytes = bits === 1 ? 1 : bits / 8;
      return frameNumbers.map(frame => {
        const startByte = Math.floor((frame - 1) * frameBits / 8);
        const rangeBytes = Math.ceil((((frame - 1) * frameBits) % 8 + frameBits) / 8);
        const packedBigEndianWords = bigEndian && result.pixel.vr === 'OW' && bits <= 8;
        const alignedStart = packedBigEndianWords ? Math.floor(startByte / 2) * 2 : startByte;
        const alignedEnd = packedBigEndianWords ? Math.ceil((startByte + rangeBytes) / 2) * 2 : startByte + rangeBytes;
        return {
        frame, mediaType: 'application/octet-stream', transferSyntaxUid: '1.2.840.10008.1.2.1',
        ranges: [{ offset: result.pixel.offset + alignedStart, length: alignedEnd - alignedStart }],
        length: frameBytes, bitOffset: ((frame - 1) * frameBits) % 8, frameBits,
        trimStart: startByte - alignedStart, trimLength: rangeBytes,
        swapBytes: packedBigEndianWords ? 2 : bigEndian ? wordBytes : 1,
      }; });
    }
    const mediaType = compressionTypes.get(record.transferSyntaxUid);
    if (!mediaType || !result.pixel.undefinedLength) throw new ArchiveError('This transfer syntax is outside the original compressed frame retrieval profile.', 406, 'unsupported-transfer-syntax');
    const frameRanges = await this.encapsulatedRanges(record.path, result.pixel, count, options.signal);
    return frameNumbers.map(frame => ({ frame, mediaType, transferSyntaxUid: record.transferSyntaxUid, ranges: frameRanges[frame - 1], length: frameRanges[frame - 1].reduce((sum, range) => sum + range.length, 0), swapBytes: 1 }));
  }

  async encapsulatedRanges(path, pixel, frameCount, signal) {
    const handle = await open(path, 'r');
    try {
      const read = async (offset, length) => {
        abort(signal);
        const bytes = Buffer.alloc(length);
        const { bytesRead } = await handle.read(bytes, 0, length, offset);
        if (bytesRead !== length) throw new ArchiveError('The encapsulated Pixel Data is truncated.', 422, 'invalid-pixel-data');
        return bytes;
      };
      const item = async offset => {
        const bytes = await read(offset, 8);
        if (bytes.readUInt16LE(0) !== 0xFFFE || bytes.readUInt16LE(2) !== 0xE000) throw new ArchiveError('The encapsulated Pixel Data contains an invalid fragment item.', 422, 'invalid-pixel-data');
        const length = bytes.readUInt32LE(4);
        if (length === 0xFFFFFFFF || length % 2 || offset + 8 + length > pixel.offset + pixel.length) throw new ArchiveError('The encapsulated fragment length is invalid.', 422, 'invalid-pixel-data');
        return length;
      };
      const botLength = await item(pixel.offset);
      if (botLength % 4 || botLength > this.maxFragments * 4 || botLength && botLength / 4 !== frameCount) throw new ArchiveError('The Basic Offset Table does not match Number of Frames.', 422, 'invalid-pixel-data');
      const bot = await read(pixel.offset + 8, botLength);
      const offsets = Array.from({ length: botLength / 4 }, (_, i) => bot.readUInt32LE(i * 4));
      const start = pixel.offset + 8 + botLength, fragments = [];
      let offset = start;
      while (offset < pixel.offset + pixel.length) {
        if (fragments.length >= this.maxFragments) throw new ArchiveError('The image exceeds the fragment indexing limit.', 413, 'too-many-fragments');
        const length = await item(offset);
        if (!length) throw new ArchiveError('An image fragment is empty.', 422, 'invalid-pixel-data');
        fragments.push({ itemOffset: offset - start, offset: offset + 8, length });
        offset += length + 8;
      }
      if (!fragments.length) throw new ArchiveError('The image has no encoded frame fragments.', 422, 'invalid-pixel-data');
      if (!offsets.length) {
        if (frameCount === 1) {
          if (fragments.reduce((sum, range) => sum + range.length, 0) > this.maxFrameBytes) throw new ArchiveError('An encoded frame exceeds the frame limit.', 413, 'frame-too-large');
          return [fragments];
        }
        if (fragments.length === frameCount) {
          if (fragments.some(fragment => fragment.length > this.maxFrameBytes)) throw new ArchiveError('An encoded frame exceeds the frame limit.', 413, 'frame-too-large');
          return fragments.map(fragment => [fragment]);
        }
        throw new ArchiveError('An empty offset table with multiple fragments per frame requires frame indexing not yet supported by this preview.', 406, 'frame-index-unavailable');
      }
      if (offsets[0] !== 0 || offsets.some((value, i) => i && value <= offsets[i - 1])) throw new ArchiveError('The Basic Offset Table frame offsets are invalid.', 422, 'invalid-pixel-data');
      const positions = new Map(fragments.map((fragment, i) => [fragment.itemOffset, i]));
      const indices = offsets.map(value => positions.get(value) ?? -1);
      if (indices.some(index => index < 0)) throw new ArchiveError('The Basic Offset Table points inside a fragment.', 422, 'invalid-pixel-data');
      return indices.map((index, i) => {
        const ranges = fragments.slice(index, indices[i + 1] ?? fragments.length);
        if (ranges.reduce((sum, range) => sum + range.length, 0) > this.maxFrameBytes) throw new ArchiveError('An encoded frame exceeds the frame limit.', 413, 'frame-too-large');
        return ranges;
      });
    } finally { await handle.close(); }
  }

  async *frameChunks(record, frame, { signal } = {}) {
    // Byte swapping and bit unpack/repack are bounded to one requested frame.
    // Encoded frames and ordinary native little-endian frames stream directly.
    if (frame.swapBytes > 1 || frame.bitOffset || frame.frameBits % 8) {
      const encodedLength = frame.ranges.reduce((sum, range) => sum + range.length, 0);
      if (encodedLength > this.maxFrameBytes + 2) throw new ArchiveError('The native frame exceeds the frame conversion limit.', 413, 'frame-too-large');
      let bytes = Buffer.allocUnsafe(encodedLength), offset = 0;
      for (const range of frame.ranges) for await (const chunk of createReadStream(record.path, { start: range.offset, end: range.offset + range.length - 1, ...(signal ? { signal } : {}) })) {
        bytes.set(chunk, offset); offset += chunk.length;
      }
      if (offset !== encodedLength) throw new ArchiveError('The original frame bytes are truncated.', 422, 'invalid-pixel-data');
      if (frame.swapBytes === 2) bytes.swap16();
      else if (frame.swapBytes === 4) bytes.swap32();
      else if (frame.swapBytes === 8) bytes.swap64();
      if (frame.trimStart || frame.trimLength < bytes.length) bytes = bytes.subarray(frame.trimStart, frame.trimStart + frame.trimLength);
      if (frame.bitOffset || frame.frameBits % 8) {
        if (frame.bitOffset) for (let i = 0; i < frame.length; i++) bytes[i] = (bytes[i] >>> frame.bitOffset) | ((bytes[i + 1] ?? 0) << (8 - frame.bitOffset));
        bytes = bytes.subarray(0, frame.length);
        if (frame.frameBits % 8) bytes[bytes.length - 1] &= (1 << (frame.frameBits % 8)) - 1;
      }
      abort(signal); yield bytes; return;
    }
    for (const range of frame.ranges) {
      abort(signal);
      const stream = createReadStream(record.path, { start: range.offset, end: range.offset + range.length - 1, ...(signal ? { signal } : {}) });
      let consumed = 0;
      try {
        for await (const chunk of stream) { consumed += chunk.length; yield chunk; }
        if (consumed !== range.length) throw new ArchiveError('The original frame bytes are truncated.', 422, 'invalid-pixel-data');
      } finally { stream.destroy(); }
    }
  }
}

export const metadataService = new MetadataService();
