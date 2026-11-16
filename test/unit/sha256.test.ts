import { createHmac, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacSha256, sha256 } from '../../src/sha256';

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);

describe('sha256 / hmac match node:crypto', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    it(`sha256 of ${n} bytes`, () => {
      expect(Buffer.from(sha256(bytes(n)))).toEqual(createHash('sha256').update(bytes(n)).digest());
    });
  }
  for (const k of [1, 32, 64, 65, 200]) {
    it(`hmac with a ${k} byte key`, () => {
      expect(Buffer.from(hmacSha256(bytes(k), bytes(150)))).toEqual(createHmac('sha256', bytes(k)).update(bytes(150)).digest());
    });
  }
});
