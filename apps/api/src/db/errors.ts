/** True when `error` (or any error in its cause chain) is a UNIQUE violation on `table.column`. */
export function isUniqueViolation(error: unknown, column: string): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    if (message.includes('UNIQUE constraint failed') && message.includes(column)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
