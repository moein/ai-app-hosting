export type BuildError = {
  kind: 'typescript' | 'bundler' | 'npm' | 'other';
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  message: string;
};

const MAX_ERRORS = 20;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape codes
const ANSI = /\u001b\[[0-9;]*m/g;
const RUNNER_PREFIX = /\/home\/runner\/work\/[^/]+\/[^/]+\//g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\s/;

/** Strips ANSI colors, GitHub timestamps and runner paths from log text. */
export const cleanLog = (text: string) =>
  text
    .split('\n')
    .map((line) => line.replace(ANSI, '').replace(TIMESTAMP, '').replace(RUNNER_PREFIX, ''))
    .join('\n');

/** Parses build output into at most 20 structured errors (LOG-1.2). */
export function parseBuildErrors(text: string): BuildError[] {
  const lines = cleanLog(text).split('\n');
  const errors: BuildError[] = [];
  const seen = new Set<string>();
  const push = (error: BuildError) => {
    const key = JSON.stringify(error);
    if (seen.has(key) || errors.length >= MAX_ERRORS) return;
    seen.add(key);
    errors.push(error);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    let m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/.exec(line);
    if (!m) m = /^(.+?):(\d+):(\d+) - error (TS\d+): (.+)$/.exec(line);
    if (m) {
      push({
        kind: 'typescript',
        file: m[1] as string,
        line: Number(m[2]),
        column: Number(m[3]),
        code: m[4] as string,
        message: m[5] as string,
      });
      continue;
    }
    m = /Rollup failed to resolve import "([^"]+)" from "([^"]+)"/.exec(line);
    if (m) {
      push({
        kind: 'bundler',
        file: (m[2] as string).replace(RUNNER_PREFIX, ''),
        message: `Cannot resolve import "${m[1]}"`,
      });
      continue;
    }
    m = /^✘ \[ERROR\] (.+)$/.exec(line);
    if (m) {
      const location =
        /^\s*(\S+?):(\d+):(\d+):/.exec(lines[i + 2] ?? '') ?? /^\s*(\S+?):(\d+):(\d+):/.exec(lines[i + 1] ?? '');
      push({
        kind: 'bundler',
        message: m[1] as string,
        ...(location ? { file: location[1] as string, line: Number(location[2]), column: Number(location[3]) } : {}),
      });
      continue;
    }
    if (/^error during build:/.test(line)) {
      const detail = (lines[i + 1] ?? '').trim();
      const location = /(\S+?):(\d+):(\d+)/.exec(detail);
      push({
        kind: 'bundler',
        message: detail || 'Build failed',
        ...(location ? { file: location[1] as string, line: Number(location[2]), column: Number(location[3]) } : {}),
      });
      continue;
    }
    m = /^npm (?:ERR!|error) code (\S+)/.exec(line);
    if (m) {
      const detail = lines
        .slice(i + 1, i + 6)
        .map((l) => l.replace(/^npm (?:ERR!|error)\s*/, '').trim())
        .find((l) => l && !l.startsWith('code'));
      push({ kind: 'npm', code: m[1] as string, message: detail ?? `npm failed with ${m[1]}` });
      continue;
    }
    m = /^npm (?:ERR!|error) 404 (.+)$/.exec(line);
    if (m) push({ kind: 'npm', code: 'E404', message: m[1] as string });
  }

  if (errors.length === 0) {
    const last = [...lines].reverse().find((l) => /\b(Error|error):/.test(l));
    if (last) push({ kind: 'other', message: last.trim() });
  }
  return errors;
}
