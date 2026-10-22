// src/exclusive-publish.ts
//
// Publish a fully written temp file at a destination only while that
// destination is still free — atomically, with EEXIST when it is taken.
//
// Primary primitive: hard link. It carries the content without copying and
// keeps the destination from ever being observable empty. Filesystems without
// hard-link support (exFAT/FAT32 volumes, RAMDisks, some network shares) answer
// link() with EISDIR/ENOTSUP/EOPNOTSUPP/EPERM instead, so those fall back to
// COPYFILE_EXCL — same create-if-absent contract, still content-atomic (unlike
// an exclusive create followed by a write, whose create→write gap readers would
// have to tolerate).

import fs from 'node:fs/promises';
import fsSync from 'node:fs';

const NO_HARDLINK_CODES = new Set(['EISDIR', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM']);

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

export async function publishExclusive(tmp: string, target: string): Promise<boolean> {
  try {
    await fs.link(tmp, target);
    return true;
  } catch (error) {
    const code = codeOf(error);
    if (code === 'EEXIST') return false;
    if (code === undefined || !NO_HARDLINK_CODES.has(code)) throw error;
  }
  try {
    await fs.copyFile(tmp, target, fsSync.constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return false;
    throw error;
  }
}
