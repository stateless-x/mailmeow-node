import { hmacSha256 } from './sha256';

export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** Thrown by `webhooks.verify` when the request cannot be trusted. */
export class WebhookVerificationError extends Error {
  override name = 'WebhookVerificationError';
}

export type WebhookHeaders =
  | Headers
  | Record<string, string | string[] | undefined>;

export interface VerifyWebhookOptions {
  /** The exact request body string. Not re-serialized JSON. */
  payload: string | Uint8Array;
  /** Request headers: `svix-*` or `webhook-*` (a `Headers` object or a plain object). */
  headers: WebhookHeaders;
  /** The `whsec_` signing secret. */
  secret: string;
}

/** Event types listed in docs/user/webhooks.md. */
export type WebhookEventType =
  | 'email.sent'
  | 'email.delivered'
  | 'email.delivery_delayed'
  | 'email.bounced'
  | 'email.complained'
  | 'email.failed'
  | 'email.suppressed';

export interface WebhookEvent {
  type: WebhookEventType;
  created_at: string;
  data: {
    email_id: string;
    from: string;
    to: string[];
    subject: string;
    tags?: { name: string; value: string }[];
    created_at: string;
    bounce?: { type: string; message: string };
  } & Record<string, unknown>;
}

const encoder = new TextEncoder();

function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name) ?? undefined;
  const plain = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(plain).find((k) => k.toLowerCase() === name);
  const v = key === undefined ? undefined : plain[key];
  return Array.isArray(v) ? v[0] : v;
}

function decodeSecret(secret: string): Uint8Array {
  if (!secret.startsWith('whsec_')) throw new WebhookVerificationError('Invalid webhook secret.');
  try {
    const bin = atob(secret.slice('whsec_'.length));
    if (bin.length === 0) throw new Error('empty');
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    throw new WebhookVerificationError('Invalid webhook secret.');
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Checks the signature and returns the parsed event. Pure: no network, no I/O.
 * Throws `WebhookVerificationError` for a missing header, a bad or expired
 * signature (more than 5 minutes from now), or an invalid secret.
 */
export function verifyWebhook(opts: VerifyWebhookOptions, nowMs: number = Date.now()): WebhookEvent {
  const key = decodeSecret(opts.secret);
  const id = header(opts.headers, 'svix-id') ?? header(opts.headers, 'webhook-id');
  const ts = header(opts.headers, 'svix-timestamp') ?? header(opts.headers, 'webhook-timestamp');
  const sigHeader = header(opts.headers, 'svix-signature') ?? header(opts.headers, 'webhook-signature');
  if (!id || !ts || !sigHeader) throw new WebhookVerificationError('Missing webhook signature headers.');

  const seconds = Number(ts);
  if (!Number.isInteger(seconds)) throw new WebhookVerificationError('Invalid webhook timestamp.');
  if (Math.abs(nowMs / 1000 - seconds) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new WebhookVerificationError('Webhook timestamp is too old or too far in the future.');
  }

  const body = typeof opts.payload === 'string' ? encoder.encode(opts.payload) : opts.payload;
  const prefix = encoder.encode(`${id}.${ts}.`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  const expected = toBase64(hmacSha256(key, message));

  // The header can hold several signatures ("v1,abc v1,def") while a secret rotates.
  const ok = sigHeader.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    return version === 'v1' && sig !== undefined && equal(sig, expected);
  });
  if (!ok) throw new WebhookVerificationError('No matching webhook signature.');

  try {
    return JSON.parse(typeof opts.payload === 'string' ? opts.payload : new TextDecoder().decode(opts.payload)) as WebhookEvent;
  } catch {
    throw new WebhookVerificationError('Webhook payload is not valid JSON.');
  }
}
