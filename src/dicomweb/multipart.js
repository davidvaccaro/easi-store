import { ArchiveError } from '../archive/errors.js';

// Streaming RFC 2046 multipart/related reader. Only delimiter/header tails are
// retained; each body is consumed with the archive's disk-backed backpressure.
export class RelatedReader {
  constructor(readable, boundary, { maxBytes = 1073741824, maxParts = 128 } = {}) {
    this.iterator = readable[Symbol.asyncIterator]();
    this.boundary = Buffer.from(`\r\n--${boundary}`);
    this.firstBoundary = Buffer.from(`--${boundary}\r\n`);
    this.buffer = Buffer.alloc(0);
    this.done = false;
    this.finished = false;
    this.bytes = 0;
    this.maxBytes = maxBytes;
    this.maxParts = maxParts;
  }
  async fill() {
    if (this.done) return false;
    const { value, done } = await this.iterator.next();
    if (done) { this.done = true; return false; }
    const chunk = Buffer.from(value);
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) throw new ArchiveError('The STOW request exceeds the preview request limit.', 413, 'request-too-large');
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    return true;
  }
  async *body() {
    const keep = this.boundary.length + 2;
    for (;;) {
      const index = this.buffer.indexOf(this.boundary);
      if (index >= 0) {
        while (this.buffer.length < index + keep && await this.fill()) {}
        if (this.buffer.length < index + keep) throw new ArchiveError('The multipart DICOM request is truncated.');
        const suffix = this.buffer.subarray(index + this.boundary.length, index + keep).toString('ascii');
        if (suffix === '\r\n' || suffix === '--') {
          if (index) yield this.buffer.subarray(0, index);
          this.buffer = this.buffer.subarray(index + keep);
          this.finished = suffix === '--';
          return;
        }
        // A matching prefix inside a binary value is data unless followed by
        // the CRLF or closing '--' delimiter suffix.
        const end = index + this.boundary.length;
        yield this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end);
        continue;
      }
      if (this.buffer.length > keep) {
        yield this.buffer.subarray(0, this.buffer.length - keep);
        this.buffer = this.buffer.subarray(this.buffer.length - keep);
      }
      if (!await this.fill()) throw new ArchiveError('The multipart DICOM request has no closing boundary.');
    }
  }
  async *parts() {
    while (this.buffer.length < this.firstBoundary.length && await this.fill()) {}
    if (!this.buffer.subarray(0, this.firstBoundary.length).equals(this.firstBoundary)) throw new ArchiveError('The multipart DICOM request has an invalid opening boundary.');
    this.buffer = this.buffer.subarray(this.firstBoundary.length);
    let count = 0;
    while (!this.finished) {
      if (++count > this.maxParts) throw new ArchiveError('A STOW request may contain at most 128 instances in this preview.', 413, 'too-many-parts');
      let separator;
      while ((separator = this.buffer.indexOf('\r\n\r\n')) < 0) {
        if (this.buffer.length > 16384 || !await this.fill()) throw new ArchiveError('The multipart headers are invalid or too large.');
      }
      if (separator > 16384) throw new ArchiveError('The multipart headers exceed the preview limit.');
      const headers = {};
      for (const line of this.buffer.subarray(0, separator).toString('ascii').split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon < 1) throw new ArchiveError('A multipart header is invalid.');
        const key = line.slice(0, colon).toLowerCase().trim();
        if (headers[key]) throw new ArchiveError('A multipart header is duplicated.');
        headers[key] = line.slice(colon + 1).trim();
      }
      this.buffer = this.buffer.subarray(separator + 4);
      const inner = this.body();
      // An archive limit/error exits its for-await loop and invokes return().
      // Preserve the underlying parser so the enclosing reader can drain the
      // remainder to the next boundary without treating body bytes as headers.
      const body = {
        next: () => inner.next(),
        return: async () => ({ done: true }),
        [Symbol.asyncIterator]() { return this; },
      };
      yield { headers, body };
      // The consumer can reject a part early. Drain it before interpreting the
      // next headers so one invalid object cannot desynchronize the request.
      for await (const _chunk of body) {}
    }
    while (await this.fill()) {
      if (this.buffer.length > 16384) throw new ArchiveError('The multipart epilogue exceeds the preview limit.');
    }
    if (this.buffer.length > 16384) throw new ArchiveError('The multipart epilogue exceeds the preview limit.');
  }
}

export function parseRelatedType(value = '') {
  const type = value.match(/^multipart\/related(?:\s*;|\s*$)/i);
  const boundary = value.match(/;\s*boundary\s*=\s*(?:"([^"\r\n]+)"|([^;\s]+))/i)?.slice(1).find(Boolean);
  const partType = value.match(/;\s*type\s*=\s*(?:"([^"\r\n]+)"|([^;\s]+))/i)?.slice(1).find(Boolean);
  if (!type || !boundary || boundary.length > 70 || !/^[0-9A-Za-z'()+_,\-./:=? ]+$/.test(boundary) || boundary.endsWith(' ') || partType?.toLowerCase() !== 'application/dicom') throw new ArchiveError('STOW requires multipart/related; type="application/dicom" with a valid boundary.', 415, 'unsupported-media-type');
  return boundary;
}
