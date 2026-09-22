import { randomBytes } from 'node:crypto';

/**
 * UUIDv7: a 48-bit millisecond timestamp followed by randomness, so ids sort
 * by creation time. That keeps B-tree inserts at the right edge of the index
 * instead of scattering them the way UUIDv4 does, and it means `ORDER BY id`
 * is a usable proxy for `ORDER BY created_at`.
 *
 * Prisma generates these itself via `@default(uuid(7))`. This helper exists for
 * the raw `INSERT ... ON CONFLICT` in the receiving path, which bypasses the
 * Prisma model API and so has to supply its own id.
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);

  // Bytes 0-5: big-endian unix milliseconds.
  bytes.writeUIntBE(Date.now(), 0, 6);
  // Byte 6 high nibble: version 7.
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  // Byte 8 high bits: RFC 4122 variant.
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
