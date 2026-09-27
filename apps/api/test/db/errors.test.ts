import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from '../../src/db/errors';

describe('isUniqueViolation', () => {
  it('finds the constraint in the cause chain', () => {
    const d1 = new Error('D1_ERROR: UNIQUE constraint failed: apps.slug: SQLITE_CONSTRAINT');
    const wrapped = new Error('Failed query: insert into "apps" ...', { cause: d1 });
    expect(isUniqueViolation(wrapped, 'apps.slug')).toBe(true);
    expect(isUniqueViolation(wrapped, 'organizations.slug')).toBe(false);
    expect(isUniqueViolation(new Error('other'), 'apps.slug')).toBe(false);
  });
});
