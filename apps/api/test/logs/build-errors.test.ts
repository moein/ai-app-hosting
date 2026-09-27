import { describe, expect, it } from 'vitest';
import { excerptFromJobLog } from '../../src/builds/view';
import { cleanLog, parseBuildErrors } from '../../src/logs/build-errors';

describe('parseBuildErrors (LOG-1.2)', () => {
  it('parses both TypeScript formats with runner paths removed', () => {
    const log = [
      "/home/runner/work/dev-todo/dev-todo/src/api/index.ts(12,5): error TS2304: Cannot find name 'x'.",
      "src/web/App.tsx:3:10 - error TS2307: Cannot find module './missing'.",
    ].join('\n');
    expect(parseBuildErrors(log)).toEqual([
      {
        kind: 'typescript',
        file: 'src/api/index.ts',
        line: 12,
        column: 5,
        code: 'TS2304',
        message: "Cannot find name 'x'.",
      },
      {
        kind: 'typescript',
        file: 'src/web/App.tsx',
        line: 3,
        column: 10,
        code: 'TS2307',
        message: "Cannot find module './missing'.",
      },
    ]);
  });

  it('parses vite/rollup, esbuild and npm errors', () => {
    const log = [
      '[vite]: Rollup failed to resolve import "left-pad" from "/home/runner/work/r/r/src/web/App.tsx".',
      '✘ [ERROR] Expected ";" but found "}"',
      '',
      '    src/api/index.ts:4:2:',
      'npm error code ERESOLVE',
      'npm error ERESOLVE unable to resolve dependency tree',
      'npm error 404 Not Found - GET https://registry.npmjs.org/not-a-real-pkg - Not found',
    ].join('\n');
    expect(parseBuildErrors(log)).toEqual([
      { kind: 'bundler', file: 'src/web/App.tsx', message: 'Cannot resolve import "left-pad"' },
      { kind: 'bundler', message: 'Expected ";" but found "}"', file: 'src/api/index.ts', line: 4, column: 2 },
      { kind: 'npm', code: 'ERESOLVE', message: 'ERESOLVE unable to resolve dependency tree' },
      { kind: 'npm', code: 'E404', message: 'Not Found - GET https://registry.npmjs.org/not-a-real-pkg - Not found' },
    ]);
  });

  it('falls back to the last Error line, de-duplicates and caps at 20', () => {
    expect(parseBuildErrors('something\nError: kaboom\nmore')).toEqual([{ kind: 'other', message: 'Error: kaboom' }]);
    const many = Array.from({ length: 30 }, (_, i) => `a.ts(${i + 1},1): error TS1000: e`).join('\n');
    expect(parseBuildErrors(`${many}\n${many}`)).toHaveLength(20);
  });

  it('strips ANSI codes and timestamps', () => {
    expect(cleanLog('2026-09-27T10:00:00.1234567Z \u001b[31mred\u001b[0m')).toBe('red');
  });
});

describe('job log excerpt (LOG-1.3)', () => {
  it('takes the failed step section, capped at 200 lines', () => {
    const log = [
      '##[group]Run npm ci',
      'ok',
      '##[endgroup]',
      '##[group]Run npm run build',
      ...Array.from({ length: 300 }, (_, i) => `line ${i}`),
      '##[error]Process completed with exit code 1.',
      'post',
    ].join('\n');
    const excerpt = excerptFromJobLog(log).split('\n');
    expect(excerpt).toHaveLength(200);
    expect(excerpt.at(-1)).toContain('##[error]');
    expect(excerpt.join('\n')).not.toContain('npm ci');
  });
});
