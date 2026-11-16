import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MailMeow, WebhookVerificationError } from '../../src';

// Same vector as mailmeow-be internal/core/signature_test.go (from the Svix library tests).
const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const id = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const ts = '1614265330';
const payload = '{"test": 2432232314}';
const sig = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';

const meow = new MailMeow('mm_test_x');
const now = Number(ts) * 1000;
// verify() reads the clock; pin it for the shared vector.
const verifyAt = (nowMs: number, over: Record<string, unknown> = {}) => {
  const real = Date.now;
  Date.now = () => nowMs;
  try {
    return meow.webhooks.verify({ payload, secret, headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig }, ...over });
  } finally {
    Date.now = real;
  }
};

describe('webhooks.verify', () => {
  it('accepts the shared vector and returns the parsed event', () => {
    expect(verifyAt(now)).toEqual({ test: 2432232314 });
  });
  it('accepts webhook-* headers and a Headers object', () => {
    const headers = new Headers({ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sig });
    expect(verifyAt(now, { headers })).toEqual({ test: 2432232314 });
  });
  it('accepts one good signature among several', () => {
    const headers = { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,AAAA ${sig} v2,zzz` };
    expect(verifyAt(now, { headers })).toBeTruthy();
  });
  it('allows exactly 5 minutes, rejects more (old and future)', () => {
    expect(verifyAt(now + 300_000)).toBeTruthy();
    expect(() => verifyAt(now + 301_000)).toThrow(WebhookVerificationError);
    expect(() => verifyAt(now - 301_000)).toThrow(WebhookVerificationError);
  });
  it('rejects a tampered body, a wrong signature, a bad secret and missing headers', () => {
    expect(() => verifyAt(now, { payload: '{"test": 1}' })).toThrow('No matching');
    expect(() => verifyAt(now, { headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': 'v1,AAAA' } })).toThrow('No matching');
    expect(() => verifyAt(now, { secret: 'nope' })).toThrow('Invalid webhook secret');
    expect(() => verifyAt(now, { headers: {} })).toThrow('Missing');
    expect(() => verifyAt(now, { headers: { 'svix-id': id, 'svix-timestamp': 'abc', 'svix-signature': sig } })).toThrow('timestamp');
  });
  it('agrees with node:crypto on a fresh signature', () => {
    const t = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(secret.slice(6), 'base64');
    const s = 'v1,' + createHmac('sha256', key).update(`${id}.${t}.${payload}`).digest('base64');
    expect(meow.webhooks.verify({ payload, secret, headers: { 'webhook-id': id, 'webhook-timestamp': t, 'webhook-signature': s } })).toBeTruthy();
  });
});
