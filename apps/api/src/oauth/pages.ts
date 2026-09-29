/** Server-rendered sign-in pages (spec 02, AUTH-1/2/4). No JavaScript; every value is HTML-escaped. */
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const CSS = `
:root{--bg:#f6f5f2;--card:#fff;--text:#1c1b1a;--muted:#5d5a55;--line:#e4e1db;--accent:#4f46e5;--accent-soft:#eef0ff;--error:#b42318}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.page{max-width:460px;margin:0 auto;padding:32px 16px}.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;margin-bottom:18px}
.logo{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:var(--accent);color:#fff}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:26px 22px}
h1{font-size:24px;line-height:1.25;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}
.client{background:var(--accent-soft);border-radius:12px;padding:12px 14px;margin:0 0 18px;color:var(--text);font-size:15px}
label{display:block;font-weight:700;margin:0 0 6px}input{width:100%;min-height:50px;padding:0 14px;border:2px solid var(--line);border-radius:12px;font:inherit;font-size:18px}
input:focus{outline:none;border-color:var(--accent)}input.code{letter-spacing:6px;font-size:24px;text-align:center}
.button{width:100%;min-height:50px;margin-top:14px;border:0;border-radius:12px;background:var(--accent);color:#fff;font:inherit;font-weight:700;font-size:17px;cursor:pointer}
.link{background:none;border:0;padding:8px 0;color:var(--muted);font:inherit;text-decoration:underline;cursor:pointer}
.links{display:flex;justify-content:space-between;gap:12px;margin-top:10px}
.error{color:var(--error);background:#fef3f2;border-radius:10px;padding:10px 12px;margin:0 0 14px}
.notice{color:var(--text);background:#ecfdf3;border-radius:10px;padding:10px 12px;margin:0 0 14px}
.fine{font-size:13px;margin-top:16px}`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — AI App Hosting</title><style>${CSS}</style></head><body><div class="page">
<div class="brand"><span class="logo" aria-hidden="true">▲</span>AI App Hosting</div><main class="card">${body}</main></div></body></html>`;
}

export type SignInView = {
  pendingId: string;
  clientName: string;
  redirectHost: string;
  email?: string;
  error?: string;
  notice?: string;
};

const messages = (view: SignInView) =>
  `${view.error ? `<p class="error" role="alert">${escapeHtml(view.error)}</p>` : ''}${view.notice ? `<p class="notice" role="status">${escapeHtml(view.notice)}</p>` : ''}`;

/** AUTH-1.1 / AUTH-4.4: who is asking, then the email form. */
export function emailPage(view: SignInView): string {
  return layout(
    'Sign in',
    `<h1>Sign in to connect ${escapeHtml(view.clientName)}</h1>
<p class="client"><strong>${escapeHtml(view.clientName)}</strong> wants to build and manage apps for you on AI App Hosting. After you sign in you'll go back to <strong>${escapeHtml(view.redirectHost)}</strong>.</p>
${messages(view)}
<form method="post" action="/authorize/email">
<input type="hidden" name="pending" value="${escapeHtml(view.pendingId)}">
<label for="email">Your email</label>
<input id="email" name="email" type="email" autocomplete="email" required maxlength="254" value="${escapeHtml(view.email ?? '')}" autofocus>
<button class="button" type="submit">Email me a code</button>
</form>
<p class="fine">New here? The same code creates your account. No password needed.</p>`,
  );
}

/** AUTH-2: the code form. */
export function codePage(view: SignInView & { email: string }): string {
  return layout(
    'Enter your code',
    `<h1>Check your email</h1>
<p>We sent a 6-digit code to <strong>${escapeHtml(view.email)}</strong>. It's valid for 10 minutes.</p>
${messages(view)}
<form method="post" action="/authorize/code">
<input type="hidden" name="pending" value="${escapeHtml(view.pendingId)}">
<label for="code">Code</label>
<input id="code" class="code" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="9" autofocus>
<button class="button" type="submit">Sign in</button>
</form>
<div class="links">
<form method="post" action="/authorize/resend"><input type="hidden" name="pending" value="${escapeHtml(view.pendingId)}"><button class="link" type="submit">Send a new code</button></form>
<form method="post" action="/authorize/restart"><input type="hidden" name="pending" value="${escapeHtml(view.pendingId)}"><button class="link" type="submit">Use a different email</button></form>
</div>`,
  );
}

export function errorPage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
