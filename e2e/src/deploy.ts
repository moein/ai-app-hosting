import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { expect } from 'vitest';
import { callTool } from './mcp';

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/contract-app/', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', '.wrangler']);

export type DeploymentView = {
  id: string;
  status: string;
  url: string | null;
  commit_sha: string;
  error: {
    code: string;
    message: string;
    step?: string;
    violations?: { rule: string; path: string }[];
    errors?: { kind: string; file?: string; line?: number; message: string }[];
  } | null;
  next_step: string;
};

/** The contract fixture app (spec 06, CON-5) as write_files entries; `overrides` replace or add files. */
export function fixtureFiles(overrides: Record<string, string | null> = {}): { path: string; content: string }[] {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(relative(FIXTURE_DIR, full), readFileSync(full, 'utf8'));
    }
  };
  walk(FIXTURE_DIR);
  for (const [path, content] of Object.entries(overrides)) {
    if (content === null) files.delete(path);
    else files.set(path, content);
  }
  return [...files].map(([path, content]) => ({ path, content }));
}

const TERMINAL = new Set(['live', 'superseded', 'failed', 'cancelled']);

/** Polls get_deployment (≤ 25 s long-polls) until the deployment is terminal. Real builds take a few minutes. */
export async function waitForDeployment(
  client: Client,
  slug: string,
  deployment: string,
  timeoutMs = 10 * 60_000,
): Promise<DeploymentView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await callTool<DeploymentView>(client, 'get_deployment', {
      app: slug,
      deployment,
      wait_seconds: 25,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error('get_deployment failed');
    if (TERMINAL.has(result.data.status) || Date.now() > deadline) return result.data;
  }
}

/** write_files with deploy (default) and wait for the resulting deployment. */
export async function writeAndDeploy(
  client: Client,
  slug: string,
  files: { path: string; content?: string; op?: 'delete' }[],
  message: string,
): Promise<DeploymentView> {
  const written = await callTool<{ deployment: { id: string } | null }>(client, 'write_files', {
    app: slug,
    message,
    files,
  });
  expect(written.ok, JSON.stringify(written)).toBe(true);
  if (!written.ok || !written.data.deployment)
    throw new Error(`write_files did not deploy: ${JSON.stringify(written)}`);
  return waitForDeployment(client, slug, written.data.deployment.id);
}
