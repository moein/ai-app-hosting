import { sha256Hex, truncateUtf8 } from '@repo/shared';

export const ARGS_MAX_BYTES = 8_192;
export const SQL_MAX_CHARS = 1_000;
const REDACTED = '[redacted]';

type Args = Record<string, unknown>;
type Redactor = (args: Args) => Promise<{ args: Args; emailHash?: string }>;

const normalizeEmail = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const hashEmail: Redactor = async ({ email, ...rest }) => ({
  args: rest,
  ...(email === undefined ? {} : { emailHash: await sha256Hex(normalizeEmail(email)) }),
});

/** Per-tool redaction (EVT-1.4). A test fails if a tool with a sensitive-looking field has no entry here. */
export const REDACTORS: Record<string, Redactor> = {
  request_login_code: hashEmail,
  verify_login_code: async (args) => {
    const hashed = await hashEmail(args);
    return { ...hashed, args: { ...hashed.args, ...('code' in args ? { code: REDACTED } : {}) } };
  },
  set_secret: async (args) => ({ args: { ...args, ...('value' in args ? { value: REDACTED } : {}) } }),
  write_files: async (args) => {
    if (!Array.isArray(args.files)) return { args };
    const files = await Promise.all(
      args.files.map(async (file: unknown) => {
        if (typeof file !== 'object' || file === null) return {};
        const { path, op, content } = file as Args;
        const summary: Args = { path, op: op ?? 'upsert' };
        if (typeof content === 'string') {
          summary.bytes = new TextEncoder().encode(content).byteLength;
          summary.sha256 = await sha256Hex(content);
        }
        return summary;
      }),
    );
    return { args: { ...args, files } };
  },
  query_database: async (args) => ({
    args: typeof args.sql === 'string' ? { ...args, sql: args.sql.slice(0, SQL_MAX_CHARS) } : args,
  }),
};

/** Redacted, size-capped JSON of a tool's arguments (EVT-1.4, EVT-1.5). */
export async function redactArgs(
  tool: string,
  raw: unknown,
): Promise<{ argsJson: string | null; argsTruncated: boolean; emailHash: string | null }> {
  if (raw === undefined || raw === null) return { argsJson: null, argsTruncated: false, emailHash: null };
  const isObject = typeof raw === 'object' && !Array.isArray(raw);
  const redactor = REDACTORS[tool];
  const { args, emailHash } = isObject && redactor ? await redactor(raw as Args) : { args: raw, emailHash: undefined };
  const json = JSON.stringify(args) ?? 'null';
  const capped = truncateUtf8(json, ARGS_MAX_BYTES);
  return { argsJson: capped, argsTruncated: capped !== json, emailHash: emailHash ?? null };
}
