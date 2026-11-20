import { Resend } from 'resend';
import { afterAll, describe, expect, it } from 'vitest';
import { MailMeow } from '../../src';
import { addWebhook, mailmeowSdk, payload, receiver, resendSdk, stack, unique, until, type Sdk } from './support';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUSES = ['queued', 'sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'failed', 'suppressed'];

const sdks: [string, () => Sdk][] = [
  ['resend', resendSdk],
  ['mailmeow', mailmeowSdk],
];

describe.each(sdks)('%s package against the API', (name, make) => {
  const sdk = make();

  it('send returns { data: { id } }', async () => {
    const res = await sdk.send(payload(unique('send')));
    expect(res.error).toBeNull();
    expect(res.data?.id).toMatch(UUID);
    expect(Object.keys(res.data!)).toEqual(['id']);
    expect(res.headers).toBeTruthy();
  });

  it('get returns the email with last_event', async () => {
    const subject = unique('get');
    const { data } = await sdk.send({ ...payload(subject), replyTo: 'reply@example.com', tags: [{ name: 'k', value: 'v' }] });
    const res = await sdk.get(data!.id);
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({
      object: 'email',
      id: data!.id,
      from: stack.from,
      to: ['you@example.com'],
      subject,
      reply_to: ['reply@example.com'],
      tags: [{ name: 'k', value: 'v' }],
    });
    expect(STATUSES).toContain(res.data!.last_event);
    // the worker runs with the fake provider, so the email leaves "queued"
    const settled = await until('last_event to leave queued', async () => {
      const r = await sdk.get(data!.id);
      return r.data!.last_event !== 'queued' ? r.data!.last_event : undefined;
    });
    expect(['sent', 'delivered']).toContain(settled);
  });

  it('list paginates with limit + after', async () => {
    const tag = unique('page');
    for (let i = 0; i < 3; i++) expect((await sdk.send(payload(`${tag} #${i}`))).error).toBeNull();
    const first = await sdk.list({ limit: 2 });
    expect(first.error).toBeNull();
    expect(first.data!.data).toHaveLength(2);
    expect(first.data!.has_more).toBe(true);
    const next = await sdk.list({ limit: 2, after: first.data!.data[1]!.id });
    expect(next.error).toBeNull();
    const firstIds = first.data!.data.map((e) => e.id);
    expect(next.data!.data.length).toBeGreaterThan(0);
    for (const e of next.data!.data) expect(firstIds).not.toContain(e.id);
  });

  it('parses a 422 into error.name and error.message', async () => {
    const res = await sdk.send({ ...payload(unique('bad')), subject: '' });
    expect(res.data).toBeNull();
    expect(res.error).toMatchObject({ name: 'validation_error', statusCode: 422 });
    expect(res.error!.message).toContain('`subject`');
  });

  it('the same Idempotency-Key twice gives the same id and one message', async () => {
    const subject = unique('idem');
    const key = unique('key');
    const a = await sdk.send(payload(subject), key);
    const b = await sdk.send(payload(subject), key);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(b.data!.id).toBe(a.data!.id);
    const page = await sdk.list({ limit: 100 });
    expect(page.data!.data.filter((e) => e.subject === subject)).toHaveLength(1);
  });

  it('sends a PDF attachment and lists it on the email, without content', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
    // Both clients take a Buffer and send it as base64, as the Resend SDK does.
    const sent = await sdk.send({ ...payload(unique('pdf')), attachments: [{ filename: 'invoice.pdf', content: pdf }] });
    expect(sent.error).toBeNull();
    expect(sent.data?.id).toMatch(UUID);
    const got = await sdk.get(sent.data!.id);
    expect(got.error).toBeNull();
    expect(got.data!.attachments).toEqual([{ filename: 'invoice.pdf', content_type: 'application/pdf', size: pdf.length }]);
  });

  it('an email without files has attachments: []', async () => {
    const sent = await sdk.send(payload(unique('nofile')));
    expect((await sdk.get(sent.data!.id)).data!.attachments).toEqual([]);
  });

  if (name === 'resend') {
    it('an unsupported field (scheduledAt) is a 422 validation_error naming it', async () => {
      const res = await sdk.send({ ...payload(unique('sched')), scheduledAt: '2026-12-01T00:00:00Z' });
      expect(res.data).toBeNull();
      expect(res.error).toMatchObject({ name: 'validation_error', statusCode: 422 });
      expect(res.error!.message).toContain('scheduled_at');
    });

    it('reads RESEND_BASE_URL and RESEND_API_KEY from the environment', async () => {
      const saved = { url: process.env.RESEND_BASE_URL, key: process.env.RESEND_API_KEY };
      process.env.RESEND_BASE_URL = stack.baseUrl;
      process.env.RESEND_API_KEY = stack.liveKey;
      try {
        const res = await new Resend().emails.send(payload(unique('env')) as never);
        expect(res.error).toBeNull();
        expect(res.data?.id).toMatch(UUID);
      } finally {
        for (const [k, v] of [['RESEND_BASE_URL', saved.url], ['RESEND_API_KEY', saved.key]] as const) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  }
});

describe('webhook signature from a real delivery', () => {
  const hook = receiver();
  afterAll(async () => (await hook).close());

  it('verifies with mailmeow webhooks.verify (and with resend webhooks.verify)', async () => {
    const { url, received } = await hook;
    const secret = addWebhook(url, 'email.sent,email.delivered');
    const meow = new MailMeow(stack.liveKey, { baseUrl: stack.baseUrl });
    const sent = await meow.emails.send(payload(unique('hook')) as never);
    const id = sent.data!.id;

    const delivery = await until('a webhook delivery', async () =>
      received.find((r) => (JSON.parse(r.body) as { data: { email_id: string } }).data.email_id === id),
    );

    const event = meow.webhooks.verify({ payload: delivery.body, headers: delivery.headers, secret });
    expect(event.type).toMatch(/^email\.(sent|delivered)$/);
    expect(event.data.email_id).toBe(id);

    // docs/user/migrate-from-resend.md: "your verifier keeps working"
    const h = delivery.headers;
    const viaResend = new Resend('re_unused').webhooks.verify({
      payload: delivery.body,
      headers: { id: String(h['svix-id']), timestamp: String(h['svix-timestamp']), signature: String(h['svix-signature']) },
      webhookSecret: secret,
    });
    expect(viaResend).toMatchObject({ type: event.type });

    expect(() => meow.webhooks.verify({ payload: delivery.body + ' ', headers: delivery.headers, secret })).toThrow();
  });
});
