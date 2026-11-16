import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailMeow } from '../../src';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const payload = { from: 'a@b.co', to: 'c@d.co', subject: 's', text: 't', replyTo: 'r@d.co' };
const boom = { statusCode: 500, name: 'application_error', message: 'boom' };

function setup(...responses: Array<Response | Error>) {
  const queue = [...responses];
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error('no more stubbed responses');
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetchMock, meow: new MailMeow('mm_test_k', { baseUrl: 'http://api.test/', fetch: fetchMock as unknown as typeof fetch }) };
}
const keyOf = (c: unknown[]) => ((c[1] as RequestInit).headers as Record<string, string>)['Idempotency-Key'];

describe('construction', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it('needs a key', () => {
    delete process.env.MAILMEOW_API_KEY;
    expect(() => new MailMeow()).toThrow('Missing API key');
  });
  it('reads MAILMEOW_API_KEY and MAILMEOW_BASE_URL', async () => {
    process.env.MAILMEOW_API_KEY = 'mm_test_env';
    process.env.MAILMEOW_BASE_URL = 'http://env.test';
    const fetchMock = vi.fn(async () => json(200, { id: 'x' }));
    const meow = new MailMeow(undefined, { fetch: fetchMock as unknown as typeof fetch });
    await meow.emails.get('abc');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://env.test/emails/abc');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer mm_test_env');
  });
});

describe('send', () => {
  it('sends snake_case and returns { data, error, headers }', async () => {
    const { fetchMock, meow } = setup(json(200, { id: 'e1' }, { 'x-test': '1' }));
    const res = await meow.emails.send(payload);
    expect(res.data).toEqual({ id: 'e1' });
    expect(res.error).toBeNull();
    expect(res.headers?.['x-test']).toBe('1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/emails');
    expect(JSON.parse(init.body as string)).toEqual({ from: 'a@b.co', to: 'c@d.co', subject: 's', text: 't', reply_to: 'r@d.co' });
  });
  it('adds an Idempotency-Key when none is given, and uses the caller key when given', async () => {
    const { fetchMock, meow } = setup(json(200, { id: 'a' }), json(200, { id: 'b' }), json(200, { id: 'c' }));
    await meow.emails.send(payload);
    await meow.emails.send(payload);
    await meow.emails.send(payload, { idempotencyKey: 'mine' });
    const keys = fetchMock.mock.calls.map(keyOf);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe('mine');
  });
  it('returns API errors instead of throwing', async () => {
    const e = { statusCode: 422, name: 'validation_error', message: 'The `attachments` field is not supported yet.' };
    const { fetchMock, meow } = setup(json(422, e));
    const res = await meow.emails.send({ ...payload, attachments: [] } as never);
    expect(res).toMatchObject({ data: null, error: e });
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toHaveProperty('attachments');
  });
  it('turns a non-JSON error body into application_error', async () => {
    const { meow } = setup(new Response('<html>bad gateway</html>', { status: 400 }));
    const res = await meow.emails.get('x');
    expect(res.error).toMatchObject({ statusCode: 400, name: 'application_error' });
  });
});

describe('retries', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries 5xx and 429 with the same key, then succeeds', async () => {
    const { fetchMock, meow } = setup(json(500, boom), json(429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'slow' }, { 'retry-after': '2' }), json(200, { id: 'ok' }));
    const p = meow.emails.send(payload);
    await vi.advanceTimersByTimeAsync(500); // first backoff
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999); // retry-after: 2s, not the 1s backoff
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).data).toEqual({ id: 'ok' });
    const keys = fetchMock.mock.calls.map(keyOf);
    expect(new Set(keys).size).toBe(1);
  });
  it('retries network errors, and gives up after 2 retries with an error result', async () => {
    const { fetchMock, meow } = setup(new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed'));
    const p = meow.emails.send(payload);
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await p;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res).toMatchObject({ data: null, error: { name: 'application_error', statusCode: null }, headers: null });
  });
  it('returns the last 5xx error after 2 retries', async () => {
    const { fetchMock, meow } = setup(json(500, boom), json(500, boom), json(500, boom));
    const p = meow.emails.get('x');
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await p).error).toMatchObject({ name: 'application_error', statusCode: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('does not retry other 4xx', async () => {
    const { fetchMock, meow } = setup(json(409, { statusCode: 409, name: 'invalid_idempotent_request', message: 'm' }));
    const res = await meow.emails.send(payload);
    expect(res.error?.name).toBe('invalid_idempotent_request');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('list', () => {
  it('builds the query string', async () => {
    const { fetchMock, meow } = setup(json(200, { object: 'list', has_more: false, data: [] }), json(200, { object: 'list', has_more: false, data: [] }));
    await meow.emails.list();
    await meow.emails.list({ limit: 2, after: 'abc' });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['http://api.test/emails', 'http://api.test/emails?limit=2&after=abc']);
  });
});
