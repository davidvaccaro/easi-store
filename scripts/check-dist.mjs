import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
for (const file of manifest.files) {
    const bytes = await readFile(`dist/public/${file.path}`);
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Integrity mismatch: ${file.path}`);
}
const html = await readFile('dist/public/index.html', 'utf8');
if (/(?:src|href)\s*=\s*["']https?:\/\//i.test(html)) throw new Error('Initial UI must not load external resources.');
console.log(`Verified ${manifest.files.length} distribution files.`);
