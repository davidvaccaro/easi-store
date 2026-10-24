import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
const ignored = new Set(['.git', 'node_modules', 'dist', 'artifacts', '.data', 'data', 'coverage']);
let checked = 0;
async function check(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const p = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Source may not include symbolic links: ${p}`);
        if (entry.isDirectory()) { await check(p); continue; }
        if (/\.(?:dcm|dicom|dicm|sqlite|db|pem|key|p12|pfx)(?:$|-)/i.test(entry.name) || /^\.env/i.test(entry.name) || /^(?:DICOMDIR|auth\.json|bootstrap-token)$/i.test(entry.name)) throw new Error(`Private or imaging asset in source: ${p}`);
        const file = await open(p, 'r');
        try {
            const header = Buffer.alloc(132); const { bytesRead } = await file.read(header, 0, 132, 0);
            if (bytesRead === 132 && header.toString('ascii', 128) === 'DICM') throw new Error(`Original imaging bytes in source: ${p}`);
        } finally { await file.close(); }
        checked++;
    }
}
await check('.');
console.log(`Source asset check passed (${checked} files; synthetic generators, no imaging corpus or credential files).`);
