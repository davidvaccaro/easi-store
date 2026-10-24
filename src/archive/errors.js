export class ArchiveError extends Error {
  constructor(message, statusCode = 400, code = 'invalid-dicom') {
    super(message);
    this.name = 'ArchiveError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function validUid(value) {
  return typeof value === 'string' && value.length <= 64 && /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))+$/.test(value);
}
