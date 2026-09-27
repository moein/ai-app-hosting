import { isManagedPath } from '@repo/app-contract';
import { MAX_FILE_BYTES, MAX_FILES_PER_WRITE, MAX_PATH_LENGTH, MAX_WRITE_BYTES, PlatformError } from '@repo/shared';

export type FileOperation =
  | { path: string; op: 'upsert'; content: string; encoding: 'utf8' | 'base64' }
  | { path: string; op: 'delete' };

const encoder = new TextEncoder();

/** Why a path is unacceptable (SRC-2.3), or null. */
export function pathProblem(path: string): string | null {
  if (path.length === 0) return 'is empty';
  if (path.length > MAX_PATH_LENGTH) return `is longer than ${MAX_PATH_LENGTH} characters`;
  if (path.startsWith('/')) return 'must be relative (no leading "/")';
  if (path.startsWith('./')) return 'must not start with "./"';
  if (path.includes('\\')) return 'must use "/" separators';
  if (path.includes('//')) return 'must not contain "//"';
  if (path.endsWith('/')) return 'must be a file, not a directory';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'contains control characters';
  const segments = path.split('/');
  if (segments.includes('..') || segments.includes('.')) return 'must not contain "." or ".." segments';
  if (segments.includes('.git')) return 'must not touch .git';
  return null;
}

export const contentBytes = (op: Extract<FileOperation, { op: 'upsert' }>) =>
  op.encoding === 'base64'
    ? Math.floor((op.content.replace(/=+$/, '').length * 3) / 4)
    : encoder.encode(op.content).byteLength;

/** Every check before any I/O: paths, managed files, sizes (SRC-2.3 – 2.5). */
export function validateOperations(files: FileOperation[]): void {
  const issues = files
    .map((file, index) => ({ index, problem: pathProblem(file.path) }))
    .filter((entry) => entry.problem !== null)
    .map(({ index, problem }) => ({ path: ['files', index, 'path'], message: `Path ${problem}.` }));
  const paths = files.map((file) => file.path);
  const duplicates = paths.filter((path, i) => paths.indexOf(path) !== i);
  for (const path of new Set(duplicates))
    issues.push({ path: ['files'], message: `"${path}" appears more than once.` });
  if (issues.length > 0) throw new PlatformError('INVALID_INPUT', { details: { issues } });

  const protectedPaths = paths.filter(isManagedPath);
  if (protectedPaths.length > 0) throw new PlatformError('PROTECTED_PATH', { details: { paths: protectedPaths } });

  if (files.length > MAX_FILES_PER_WRITE) {
    throw new PlatformError('PAYLOAD_TOO_LARGE', { details: { files: files.length, max_files: MAX_FILES_PER_WRITE } });
  }
  let total = 0;
  for (const file of files) {
    if (file.op !== 'upsert') continue;
    const bytes = contentBytes(file);
    if (bytes > MAX_FILE_BYTES) {
      throw new PlatformError('FILE_TOO_LARGE', { details: { path: file.path, bytes, max_bytes: MAX_FILE_BYTES } });
    }
    total += bytes;
  }
  if (total > MAX_WRITE_BYTES) {
    throw new PlatformError('PAYLOAD_TOO_LARGE', { details: { bytes: total, max_bytes: MAX_WRITE_BYTES } });
  }
}

/** UTF-8 text with no NUL bytes in the first 8 KB counts as text (spec 07 design). */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8_192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}
