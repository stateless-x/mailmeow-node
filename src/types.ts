import type { components } from './generated/api';

export type Email = components['schemas']['Email'];
export type EmailListItem = components['schemas']['ListItem'];
export type EmailList = components['schemas']['List'];
export type Tag = components['schemas']['Tag'];

/** The error body every non-2xx response has (docs/user/api-reference.md). */
export interface ErrorResponse {
  /** `null` when no response came back (network error). */
  statusCode: number | null;
  /** One of the names in the API reference, e.g. `validation_error`. */
  name: string;
  message: string;
}

/** Never thrown for API errors: one of `data` or `error` is set. */
export type Response<T> =
  | { data: T; error: null; headers: Record<string, string> }
  | { data: null; error: ErrorResponse; headers: Record<string, string> | null };

export interface SendEmailOptions {
  /** `"Name <hello@acme.com>"` or `"hello@acme.com"`. */
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string | string[];
  headers?: Record<string, string>;
  tags?: Tag[];
  /** Up to 20 files, 10 MB in total. Same shape as the Resend SDK, except `path` (a URL) is not supported yet. */
  attachments?: Attachment[];
}

export interface Attachment {
  filename: string;
  /** The file: a base64 string, or bytes (`Buffer`, `Uint8Array`, `ArrayBuffer`), which are sent as base64. */
  content: string | Uint8Array | ArrayBuffer;
  /** Default: from the file extension. */
  contentType?: string;
  /** Makes the file inline: use it in the HTML as `<img src="cid:...">`. */
  contentId?: string;
}

export interface RequestOptions {
  /** Defaults to a fresh random key per `send`, reused by every retry. */
  idempotencyKey?: string;
}

export interface ListEmailsOptions {
  /** 1 to 100. Default 20. */
  limit?: number;
  /** Emails older than this id (next page). */
  after?: string;
  /** Emails newer than this id. Not together with `after`. */
  before?: string;
}

export interface MailMeowOptions {
  /** Default: `MAILMEOW_BASE_URL`, then `https://api.mailmeow.dev`. */
  baseUrl?: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
}
