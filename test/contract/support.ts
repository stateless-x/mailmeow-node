import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Resend } from 'resend';
import { MailMeow } from '../../src';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Run this suite with \`bun run test:contract\`.`);
  return v;
}

export const stack = {
  baseUrl: need('MAILMEOW_CONTRACT_BASE_URL'),
  liveKey: need('MAILMEOW_CONTRACT_LIVE_KEY'),
  from: need('MAILMEOW_CONTRACT_FROM'),
  orgId: need('MAILMEOW_CONTRACT_ORG_ID'),
  databaseUrl: need('MAILMEOW_CONTRACT_DATABASE_URL'),
  mmctl: need('MAILMEOW_CONTRACT_MMCTL'),
};

/** What both SDKs share. Both return `{ data, error, headers }`. */
export interface Result<T> {
  data: T | null;
  error: { name: string; message: string; statusCode: number | null } | null;
  headers: Record<string, string> | null;
}
export interface Sdk {
  send(payload: Record<string, unknown>, idempotencyKey?: string): Promise<Result<{ id: string }>>;
  get(id: string): Promise<Result<Record<string, any>>>;
  list(opts: { limit?: number; after?: string }): Promise<Result<{ has_more: boolean; data: { id: string; subject: string }[] }>>;
}

export function resendSdk(): Sdk {
  const r = new Resend(stack.liveKey, { baseUrl: stack.baseUrl });
  return {
    send: (p, idempotencyKey) => r.emails.send(p as never, idempotencyKey ? { idempotencyKey } : {}) as never,
    get: (id) => r.emails.get(id) as never,
    list: (o) => r.emails.list(o as never) as never,
  };
}

export function mailmeowSdk(): Sdk {
  const m = new MailMeow(stack.liveKey, { baseUrl: stack.baseUrl });
  return {
    send: (p, idempotencyKey) => m.emails.send(p as never, idempotencyKey ? { idempotencyKey } : {}) as never,
    get: (id) => m.emails.get(id) as never,
    list: (o) => m.emails.list(o) as never,
  };
}

export const unique = (label: string) => `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function payload(subject: string): Record<string, unknown> {
  return { from: stack.from, to: ['you@example.com'], subject, html: '<p>hi</p>', text: 'hi' };
}

export async function until<T>(what: string, fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export interface Received {
  body: string;
  headers: IncomingMessage['headers'];
}

/** A local receiver for webhook deliveries; answers 200 to everything. */
export async function receiver(): Promise<{ url: string; received: Received[]; close(): Promise<void> }> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ body: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    // mailmeow's webhook sender keeps connections open for reuse; close() alone
    // waits for those idle sockets, so drop them first.
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** `mmctl webhook add` against the contract database only. Returns the whsec_ secret. */
export function addWebhook(url: string, events: string): string {
  const out = execFileSync(stack.mmctl, ['webhook', 'add', '--org', stack.orgId, '--url', url, '--events', events], {
    env: { PATH: process.env.PATH ?? '', DATABASE_URL: stack.databaseUrl, MAILMEOW_EMAIL_PROVIDER: 'fake' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const secret = /secret:\s+(whsec_\S+)/.exec(out)?.[1];
  if (!secret) throw new Error(`no secret in mmctl output: ${out}`);
  return secret;
}
