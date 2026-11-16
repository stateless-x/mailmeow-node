import { verifyWebhook, type VerifyWebhookOptions, type WebhookEvent } from './webhooks';
import type {
  Email,
  EmailList,
  ErrorResponse,
  ListEmailsOptions,
  MailMeowOptions,
  RequestOptions,
  Response,
  SendEmailOptions,
} from './types';

const DEFAULT_BASE_URL = 'https://api.mailmeow.dev';
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 30_000;

function env(name: string): string | undefined {
  return typeof process !== 'undefined' && process.env ? process.env[name] || undefined : undefined;
}

function randomKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Node 18 has no global `crypto`. 128 random bits is plenty for an idempotency key.
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, '0')).join('');
}

const camelToSnake = (k: string) => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

/** Top-level keys only, so `headers` names and `tags` values stay as given. Unknown keys go
 * to the API too, which answers 422 naming them: nothing is silently dropped. */
function toWire(payload: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined).map(([k, v]) => [camelToSnake(k), v]));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return BASE_DELAY_MS * 2 ** attempt;
}

const isRetryable = (status: number) => status === 429 || status >= 500;

export class MailMeow {
  readonly emails: Emails;
  readonly webhooks = { verify: (opts: VerifyWebhookOptions): WebhookEvent => verifyWebhook(opts) };

  /** @internal */
  readonly key: string;
  /** @internal */
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(key?: string, options: MailMeowOptions = {}) {
    const resolved = key || env('MAILMEOW_API_KEY');
    if (!resolved) {
      throw new Error('Missing API key. Pass it to the constructor `new MailMeow("mm_live_...")` or set MAILMEOW_API_KEY.');
    }
    this.key = resolved;
    this.baseUrl = (options.baseUrl ?? env('MAILMEOW_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.emails = new Emails(this);
  }

  /** @internal Sends one request, retrying 429, 5xx and network errors with the same headers. */
  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response<T>> {
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    for (let attempt = 0; ; attempt++) {
      let res: globalThis.Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      } catch {
        if (attempt < MAX_RETRIES) {
          await sleep(retryDelay(attempt, null));
          continue;
        }
        return {
          data: null,
          error: { statusCode: null, name: 'application_error', message: 'Unable to fetch data. The request could not be resolved.' },
          headers: null,
        };
      }
      if (isRetryable(res.status) && attempt < MAX_RETRIES) {
        await sleep(retryDelay(attempt, res.headers.get('retry-after')));
        continue;
      }
      const headers = Object.fromEntries(res.headers.entries());
      const text = await res.text();
      if (res.ok) {
        try {
          return { data: JSON.parse(text) as T, error: null, headers };
        } catch {
          return { data: null, error: { statusCode: res.status, name: 'application_error', message: 'The API returned a body that is not JSON.' }, headers };
        }
      }
      return { data: null, error: parseError(text, res.status), headers };
    }
  }
}

function parseError(text: string, status: number): ErrorResponse {
  try {
    const e = JSON.parse(text) as Partial<ErrorResponse>;
    if (typeof e.name === 'string' && typeof e.message === 'string') {
      return { statusCode: e.statusCode ?? status, name: e.name, message: e.message };
    }
  } catch {
    // not JSON: fall through to the generic error below
  }
  return { statusCode: status, name: 'application_error', message: 'Unexpected response from the API.' };
}

class Emails {
  constructor(private readonly client: MailMeow) {}

  /** `200` means accepted and queued, not delivered. Every call gets an idempotency key unless you pass one. */
  send(payload: SendEmailOptions, options: RequestOptions = {}): Promise<Response<{ id: string }>> {
    return this.client.request('POST', '/emails', toWire(payload), {
      'Idempotency-Key': options.idempotencyKey ?? randomKey(),
    });
  }

  get(id: string): Promise<Response<Email>> {
    return this.client.request('GET', `/emails/${encodeURIComponent(id)}`);
  }

  list(options: ListEmailsOptions = {}): Promise<Response<EmailList>> {
    const q = new URLSearchParams();
    if (options.limit !== undefined) q.set('limit', String(options.limit));
    if (options.after !== undefined) q.set('after', options.after);
    if (options.before !== undefined) q.set('before', options.before);
    const qs = q.toString();
    return this.client.request('GET', qs ? `/emails?${qs}` : '/emails');
  }
}
