// Platform D1 schema (Drizzle). Tables are added by the specs that own them (specs/00-foundation/design.md
// "Platform D1 schema"). Conventions: TEXT primary keys holding prefixed IDs; timestamps are INTEGER epoch ms.
import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

// spec 02
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  status: text('status', { enum: ['active', 'blocked'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at').notNull(),
  lastLoginAt: integer('last_login_at'),
});

export const loginCodes = sqliteTable(
  'login_codes',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    consumedAt: integer('consumed_at'),
    invalidatedAt: integer('invalidated_at'),
  },
  (table) => [index('login_codes_email').on(table.email)],
);

// spec 03 (created with auth because signup needs them)
export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['personal'] })
    .notNull()
    .default('personal'),
  emailTenantStatus: text('email_tenant_status', { enum: ['pending', 'ready', 'failed'] })
    .notNull()
    .default('pending'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const memberships = sqliteTable(
  'memberships',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: ['owner'] })
      .notNull()
      .default('owner'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.userId] }), index('memberships_user').on(table.userId)],
);

// spec 11 (created with auth because AUTH-1.7 reads it)
export const emailSuppressions = sqliteTable(
  'email_suppressions',
  {
    email: text('email').notNull(),
    orgId: text('org_id'), // NULL = global
    reason: text('reason', { enum: ['bounce', 'complaint'] }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    unique('email_suppressions_email_org').on(table.email, table.orgId),
    index('email_suppressions_email').on(table.email),
  ],
);
