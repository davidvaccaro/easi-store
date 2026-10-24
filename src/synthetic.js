// Independent generated fixtures. No patient source data or external imaging assets.
import { randomUUID } from 'node:crypto';

export const uid = () => `2.25.${BigInt('0x' + randomUUID().replaceAll('-', ''))}`;
const longVR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UC', 'UN', 'UR', 'UT']);
export function element(tag, vr, value) {
    let bytes;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) bytes = Buffer.from(value);
    else if (vr === 'US') { bytes = Buffer.alloc(2); bytes.writeUInt16LE(Number(value)); }
    else if (vr === 'UL') { bytes = Buffer.alloc(4); bytes.writeUInt32LE(Number(value)); }
    else bytes = Buffer.from(String(value), 'utf8');
    if (bytes.length % 2) bytes = Buffer.concat([bytes, Buffer.from([vr === 'UI' || vr === 'OB' || vr === 'OW' ? 0 : 32])]);
    const head = Buffer.alloc(longVR.has(vr) ? 12 : 8);
    head.writeUInt16LE(parseInt(tag.slice(0, 4), 16));
    head.writeUInt16LE(parseInt(tag.slice(4), 16), 2);
    head.write(vr, 4, 2, 'ascii');
    if (head.length === 12) head.writeUInt32LE(bytes.length, 8);
    else head.writeUInt16LE(bytes.length, 6);
    return Buffer.concat([head, bytes]);
}
export function part10Header({ sopUid, sopClassUid, transferSyntaxUid = '1.2.840.10008.1.2.1' }) {
    const meta = Buffer.concat([
        element('00020001', 'OB', Buffer.from([0, 1])),
        element('00020002', 'UI', sopClassUid), element('00020003', 'UI', sopUid),
        element('00020010', 'UI', transferSyntaxUid),
        element('00020012', 'UI', '2.25.90504590600459060045906004590600459'),
        element('00020013', 'SH', 'EASI_STORE_010')
    ]);
    const preamble = Buffer.alloc(132); preamble.write('DICM', 128);
    return Buffer.concat([preamble, element('00020000', 'UL', meta.length), meta]);
}
export function createDicom(options = {}) {
    const o = { sopUid: uid(), sopClassUid: '1.2.840.10008.5.1.4.1.1.2', studyUid: uid(), seriesUid: uid(),
        patientId: 'EASI-SYNTHETIC-001', issuer: 'EASI-DEMO', patientName: 'Synthetic^Research',
        studyDescription: 'Generated imaging sandbox', seriesDescription: 'Axial CT · generated',
        studyDate: '20261024', modality: 'CT', instanceNumber: 1, rows: 128, columns: 128, frames: 1,
        ...options };
    const pixels = Buffer.alloc(o.rows * o.columns * o.frames * 2);
    for (let f = 0; f < o.frames; f++) for (let y = 0; y < o.rows; y++) for (let x = 0; x < o.columns; x++) {
        const a = (x - o.columns / 2) / (o.columns * .43), b = (y - o.rows / 2) / (o.rows * .39);
        const body = a * a + b * b < 1;
        const lung = ((a + .40) ** 2 / .09 + b * b / .43 < 1) || ((a - .40) ** 2 / .09 + b * b / .43 < 1);
        const bone = a * a / .03 + (b - .57) ** 2 / .05 < 1;
        const value = !body ? 0 : lung ? 270 + ((x + y + f) % 17) : bone ? 1900 : 1050 + ((x * 3 + y * 7 + f * 11 + o.instanceNumber * 5) % 90);
        pixels.writeUInt16LE(value, ((f * o.rows + y) * o.columns + x) * 2);
    }
    const entries = [
        ['00080005','CS','ISO_IR 192'], ['00080016','UI',o.sopClassUid], ['00080018','UI',o.sopUid],
        ['00080020','DA',o.studyDate], ['00080030','TM','120000'], ['00080050','SH','SYNTHETIC'],
        ['00080060','CS',o.modality], ['00081030','LO',o.studyDescription], ['0008103E','LO',o.seriesDescription],
        ['00100010','PN',o.patientName], ['00100020','LO',o.patientId], ['00100021','LO',o.issuer],
        ['00100030','DA','20000101'], ['00100040','CS','O'],
        ['00180050','DS','2.5'], ['0020000D','UI',o.studyUid], ['0020000E','UI',o.seriesUid],
        ['00200010','SH','DEMO'], ['00200011','IS',o.seriesNumber ?? 1], ['00200013','IS',o.instanceNumber],
        ['00200032','DS',`0\\0\\${(o.instanceNumber - 1) * 2.5}`], ['00200037','DS','1\\0\\0\\0\\1\\0'],
        ['00200052','UI',o.frameOfReferenceUid ?? o.studyUid],
        ['00280002','US',1], ['00280004','CS','MONOCHROME2'], ['00280008','IS',o.frames],
        ['00280010','US',o.rows], ['00280011','US',o.columns], ['00280030','DS','1\\1'],
        ['00280100','US',16], ['00280101','US',12], ['00280102','US',11], ['00280103','US',0],
        ['00281050','DS','40'], ['00281051','DS','400'], ['00281052','DS','-1024'], ['00281053','DS','1'],
        ['7FE00010','OW',pixels]
    ];
    return Buffer.concat([part10Header(o), ...entries.map(([tag,vr,value]) => element(tag,vr,value))]);
}
export function createDemoStudy() {
    const studyUid = uid(), seriesUid = uid();
    return Array.from({ length: 12 }, (_, i) => createDicom({ studyUid, seriesUid, instanceNumber: i + 1 }));
}
