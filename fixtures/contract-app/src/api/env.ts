export type AppEmailMessage = { to: string | string[]; subject: string; text?: string; html?: string };
export type AppEmailResult =
  | { ok: true; id: string; suppressed: string[] }
  | { ok: false; error: { code: string; message: string } };

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  EMAIL: { send(message: AppEmailMessage): Promise<AppEmailResult> };
}
