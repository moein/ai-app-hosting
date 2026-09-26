import { e2eEnv } from './env';

/** Aborts the whole run unless the target API is the dev environment (E2E-1.2). */
export default async function setup(): Promise<void> {
  const { E2E_API_ORIGIN } = e2eEnv();
  const url = new URL('/healthz', E2E_API_ORIGIN);
  let environment: unknown;
  try {
    const res = await fetch(url);
    environment = ((await res.json()) as { environment?: unknown }).environment;
  } catch (error) {
    throw new Error(`Refusing to run e2e: ${url} is unreachable (${String(error)})`);
  }
  if (environment !== 'dev') {
    throw new Error(`Refusing to run e2e: ${url} reports environment ${JSON.stringify(environment)}, expected "dev"`);
  }
}
