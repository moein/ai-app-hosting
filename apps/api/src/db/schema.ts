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

// spec 03
export const apps = sqliteTable(
  'apps',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'deleted'] })
      .notNull()
      .default('active'),
    provisioning: text('provisioning', { enum: ['pending', 'ready', 'failed'] })
      .notNull()
      .default('pending'),
    provisioningError: text('provisioning_error'),
    // spec 11: the app's SES identity mail.<slug>.APPS_DOMAIN (MAIL-1.6, MAIL-1.7)
    emailStatus: text('email_status', { enum: ['pending', 'ready', 'failed'] })
      .notNull()
      .default('pending'),
    scriptName: text('script_name').notNull(),
    repoOwner: text('repo_owner').notNull(),
    repoName: text('repo_name').notNull(),
    repoId: integer('repo_id'),
    d1DatabaseId: text('d1_database_id'),
    d1DatabaseName: text('d1_database_name').notNull(),
    liveDeploymentId: text('live_deployment_id'),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (table) => [index('apps_org_status_created').on(table.orgId, table.status, table.createdAt)],
);

export const usageCounters = sqliteTable(
  'usage_counters',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id),
    metric: text('metric', { enum: ['deploys', 'emails'] }).notNull(),
    day: text('day').notNull(), // YYYY-MM-DD (UTC)
    count: integer('count').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.metric, table.day] })],
);

// spec 08
export const deployments = sqliteTable(
  'deployments',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id),
    trigger: text('trigger', { enum: ['push', 'redeploy', 'rollback'] }).notNull(),
    commitSha: text('commit_sha').notNull(),
    commitMessage: text('commit_message'),
    sourceDeploymentId: text('source_deployment_id'),
    status: text('status', { enum: ['queued', 'building', 'deploying', 'succeeded', 'failed', 'cancelled'] }).notNull(),
    errorCode: text('error_code'),
    errorDetails: text('error_details'), // JSON ≤ 20 KB
    runId: integer('run_id'),
    runAttempt: integer('run_attempt'),
    jobId: integer('job_id'),
    artifactKey: text('artifact_key'),
    artifactBytes: integer('artifact_bytes'),
    createdBy: text('created_by'),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    buildFinishedAt: integer('build_finished_at'),
    finishedAt: integer('finished_at'),
  },
  (table) => [
    index('deployments_app_created').on(table.appId, table.createdAt),
    index('deployments_app_commit').on(table.appId, table.commitSha),
    index('deployments_status_created').on(table.status, table.createdAt),
  ],
);

// spec 09
export const appSecrets = sqliteTable(
  'app_secrets',
  {
    appId: text('app_id')
      .notNull()
      .references(() => apps.id),
    name: text('name').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.appId, table.name] })],
);
