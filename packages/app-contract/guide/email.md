# Email

Apps send email through the `EMAIL` binding. Every app has its own sending domain: messages come from `hello@mail.<slug>.{{APPS_DOMAIN}}`, with your app's name (or `from_name`) as the sender name. Set `reply_to` if replies should reach a real inbox.

```ts
type AppEmailMessage = {
  to: string | string[];          // 1..{{MAX_EMAIL_RECIPIENTS}} recipients
  subject: string;                // 1..200 characters
  text?: string; html?: string;   // at least one
  reply_to?: string;
  from_name?: string;             // default: the app's name
};
type AppEmailResult =
  | { ok: true; id: string; suppressed: string[] }
  | { ok: false; error: { code: 'invalid_message' | 'all_suppressed' | 'quota_exceeded'
                              | 'tenant_not_ready' | 'tenant_paused' | 'send_failed'; message: string } };

// src/api/env.ts
export interface Env {
  EMAIL: { send(message: AppEmailMessage): Promise<AppEmailResult> };
  // …
}

const result = await c.env.EMAIL.send({ to: 'someone@example.com', subject: 'Welcome', text: 'Hi!' });
if (!result.ok) console.error(result.error);
```

- `send` never throws; always check `result.ok`.
- `tenant_not_ready`: email is still being set up — usually for a few minutes after the app is created. Tell the user to try again shortly.
- Addresses that bounced or complained are skipped and listed in `suppressed`.
- Each organization can send up to {{MAX_EMAILS_PER_ORG_PER_DAY}} emails per day; messages are limited to {{bytes:MAX_EMAIL_BYTES}}.
