# mailmeow

Node.js SDK for [mailmeow](https://mailmeow.dev), the Resend-compatible email API. Same call shape as Resend, plus automatic idempotency and safe retries. No dependencies; works on Node 18+, Bun, Deno and edge runtimes.

```bash
npm install mailmeow
```

## Send

```ts
import { MailMeow } from 'mailmeow';

const meow = new MailMeow(); // reads MAILMEOW_API_KEY, or pass the key

const { data, error } = await meow.emails.send({
  from: 'Acme <hello@acme.com>',
  to: 'you@example.com',
  subject: 'Welcome!',
  html: '<p>Glad you are here.</p>',
});
if (error) console.error(error.name, error.message);
else console.log(data.id);
```

Every call returns `{ data, error, headers }` and never throws for API errors. Each send gets an `Idempotency-Key` (pass your own with `{ idempotencyKey }`), and network errors, `429` and `5xx` are retried up to 2 times with that same key, so a retry never sends twice.

`meow.emails.get(id)` and `meow.emails.list({ limit, after })` work as in Resend.

## Verify a webhook

```ts
const event = meow.webhooks.verify({ payload: rawBody, headers: request.headers, secret: process.env.MAILMEOW_WEBHOOK_SECRET! });
```

Throws `WebhookVerificationError` when the signature is wrong or older than 5 minutes.

## Migrate from Resend

```diff
-import { Resend } from 'resend';
-const resend = new Resend(process.env.RESEND_API_KEY);
+import { MailMeow } from 'mailmeow';
+const resend = new MailMeow(process.env.MAILMEOW_API_KEY);
```

Or keep the `resend` package: set `RESEND_BASE_URL=https://api.mailmeow.dev` and use a mailmeow key. `attachments`, `scheduled_at`, `template` and `topic_id` are not supported yet and return `422 validation_error`.

## Develop

```bash
bun install
bun run check          # typecheck, build, unit tests
bun run test:contract  # starts its own throwaway stack (Docker + Go), runs the suite against
                       # the real `resend` package and this one, then tears it down
bun run generate       # regenerate src/generated/api.d.ts from mailmeow-be's OpenAPI
```
