import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readPrivateJson(path, limit) {
  let handle;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('Invalid private health record.');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > limit || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error('Invalid private health record.');
    const buffer = Buffer.alloc(limit+1); let position = 0;
    while (position < buffer.length) {
      const {bytesRead} = await handle.read(buffer,position,buffer.length-position,position);
      if (!bytesRead) break; position += bytesRead;
    }
    if (position > limit) throw new Error('Invalid private health record.');
    return JSON.parse(buffer.subarray(0,position).toString('utf8'));
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  finally { await handle?.close(); }
}

export async function writePrivateJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle, renamed = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, path); renamed = true;
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) { error.healthWriteRenamed = renamed; throw error; }
  finally { await handle?.close(); if (!renamed) await rm(temporary, { force:true }); }
}
