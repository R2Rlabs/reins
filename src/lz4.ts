/**
 * An LZ4 frame decoder: enough to read Hyperliquid's published data files
 * (`*.csv.lz4`), with no dependency. Checksums are skipped — the files arrive
 * over TLS — and dictionaries are refused, since those files use none.
 *
 * Format: https://github.com/lz4/lz4/blob/dev/doc/lz4_Frame_format.md and
 * https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md
 */

const FRAME_MAGIC = 0x184d2204;

/** A byte buffer that grows as it is written, and can copy from its own past. */
class Output {
  private bytes = new Uint8Array(1 << 16);
  length = 0;

  private reserve(extra: number): void {
    if (this.length + extra <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + extra) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  append(source: Uint8Array, start: number, count: number): void {
    this.reserve(count);
    this.bytes.set(source.subarray(start, start + count), this.length);
    this.length += count;
  }

  /** Copies `count` bytes from `offset` back; the ranges may overlap. */
  repeat(offset: number, count: number): void {
    if (offset === 0 || offset > this.length) throw new Error("LZ4: a match points outside the data.");
    this.reserve(count);
    for (let i = 0; i < count; i++) {
      this.bytes[this.length] = this.bytes[this.length - offset]!;
      this.length++;
    }
  }

  result(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

function readLength(input: Uint8Array, at: { pos: number }, initial: number): number {
  let length = initial;
  if (initial === 15) {
    let byte: number;
    do {
      byte = input[at.pos++]!;
      length += byte;
    } while (byte === 255);
  }
  return length;
}

function decodeBlock(input: Uint8Array, start: number, end: number, out: Output): void {
  const at = { pos: start };
  while (at.pos < end) {
    const token = input[at.pos++]!;
    const literals = readLength(input, at, token >> 4);
    out.append(input, at.pos, literals);
    at.pos += literals;
    if (at.pos >= end) break; // the last sequence is literals only
    const offset = input[at.pos]! | (input[at.pos + 1]! << 8);
    at.pos += 2;
    out.repeat(offset, readLength(input, at, token & 15) + 4);
  }
}

export function decompressLz4Frame(input: Uint8Array): Uint8Array {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input.length < 7 || view.getUint32(0, true) !== FRAME_MAGIC) {
    throw new Error("Not an LZ4 frame.");
  }
  const flags = input[4]!;
  if (flags >> 6 !== 1) throw new Error("Unsupported LZ4 frame version.");
  if (flags & 0x01) throw new Error("LZ4 frames with a dictionary are not supported.");
  const blockChecksums = (flags & 0x10) !== 0;
  const hasContentSize = (flags & 0x08) !== 0;
  // Magic (4), flags (1), block descriptor (1), content size, header checksum (1).
  let pos = 6 + (hasContentSize ? 8 : 0) + 1;

  const out = new Output();
  for (;;) {
    if (pos + 4 > input.length) throw new Error("LZ4: the frame ends early.");
    const word = view.getUint32(pos, true);
    pos += 4;
    if (word === 0) break; // end mark; a content checksum may follow
    const size = word & 0x7fffffff;
    if (pos + size > input.length) throw new Error("LZ4: a block runs past the end.");
    if (word & 0x80000000) out.append(input, pos, size);
    else decodeBlock(input, pos, pos + size, out);
    pos += size + (blockChecksums ? 4 : 0);
  }
  return out.result();
}
