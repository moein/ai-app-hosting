import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { expect } from 'vitest';
import { e2eEnv } from './env';
import { callTool } from './mcp';

export type AppSummary = { slug: string; name: string; url: string; status: string; provisioning: string };

export const appUrl = (slug: string) => `https://${slug}.${e2eEnv().E2E_APPS_DOMAIN}`;

/** create_app, then poll get_app until setup is ready (create_app itself waits up to 25 s). */
export async function createReadyApp(client: Client, name: string, slug?: string): Promise<AppSummary> {
  const created = await callTool<AppSummary>(client, 'create_app', slug ? { name, slug } : { name });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  if (!created.ok) throw new Error('create_app failed');
  let app = created.data;
  const deadline = Date.now() + 120_000;
  while (app.provisioning === 'pending' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const current = await callTool<AppSummary>(client, 'get_app', { app: app.slug });
    if (current.ok) app = current.data;
  }
  expect(app.provisioning).toBe('ready');
  return app;
}

/** Polls an app URL until it answers with `status` (KV routes and caches take up to ~60 s to converge). */
export async function waitForStatus(url: string, status: number, timeoutMs = 120_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let last: Response | undefined;
  for (;;) {
    last = await fetch(url, { redirect: 'manual' });
    if (last.status === status || Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

export async function deleteApps(client: Client, slugs: string[]) {
  for (const slug of slugs) await callTool(client, 'delete_app', { app: slug, confirm_slug: slug });
}
