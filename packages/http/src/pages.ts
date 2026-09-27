/** Minimal status pages shown on app subdomains (dispatcher + placeholder script, spec 09). */
const page = (title: string, heading: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#222}main{text-align:center;padding:2rem}h1{font-size:1.5rem}</style></head>
<body><main><h1>${heading}</h1><p>${body}</p></main></body></html>`;

export const BEING_BUILT_HTML = page('Being built', 'This app is being built', 'Check back in a minute.');
export const NO_APP_HTML = page('Not found', "There's no app at this address", 'Check the address and try again.');
export const APP_ERROR_HTML = page('App error', 'This app ran into a problem', 'Please try again in a moment.');

export const htmlResponse = (html: string, status: number, headers: Record<string, string> = {}) =>
  new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
