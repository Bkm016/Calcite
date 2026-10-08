import { open, type FileHandle } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

async function centralDirectory(handle: FileHandle, file: string): Promise<Entry[]> {
  const { size } = await handle.stat();
  const tailSize = Math.min(size, 65_557);
  const tail = Buffer.alloc(tailSize);
  await handle.read(tail, 0, tailSize, size - tailSize);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error(`Not a zip file: ${file}`);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  const cd = Buffer.alloc(cdSize);
  await handle.read(cd, 0, cdSize, cdOffset);
  const entries: Entry[] = [];
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    entries.push({
      name: cd.toString('utf8', p + 46, p + 46 + nameLen),
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      localOffset: cd.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Names of all entries (from the central directory, nothing is extracted). */
export async function zipEntries(file: string): Promise<string[]> {
  const handle = await open(file, 'r');
  try {
    return (await centralDirectory(handle, file)).map((e) => e.name);
  } finally {
    await handle.close();
  }
}

export async function zipContains(file: string, entry: string): Promise<boolean> {
  return (await zipEntries(file)).includes(entry);
}

/** Contents of one entry (stored or deflated), or null when the zip has no such entry. */
export async function readZipEntry(file: string, entry: string): Promise<Buffer | null> {
  const handle = await open(file, 'r');
  try {
    const found = (await centralDirectory(handle, file)).find((e) => e.name === entry);
    if (!found) return null;
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, found.localOffset);
    const dataStart = found.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const data = Buffer.alloc(found.compressedSize);
    await handle.read(data, 0, found.compressedSize, dataStart);
    if (found.method === 0) return data;
    if (found.method === 8) return inflateRawSync(data);
    throw new Error(`Unsupported compression method ${found.method} for ${entry} in ${file}`);
  } finally {
    await handle.close();
  }
}
