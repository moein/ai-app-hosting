import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReport, reportSql } from './usage-report.mjs';

const row = (org, app, metric, quantity) => ({
  org_id: org,
  org_slug: org,
  app_id: app,
  app_slug: app,
  metric,
  quantity,
});

test('groups per app, prices it and sorts by cost, with org totals', () => {
  const report = buildReport(
    [
      row('org_a', 'cheap', 'requests', 1_000),
      row('org_a', 'busy', 'requests', 1_000_000),
      row('org_a', 'busy', 'emails', 1_000),
      row('org_b', 'mail', 'emails', 10),
    ],
    '2026-09',
  );
  assert.deepEqual(
    report.apps.map((a) => a.app),
    ['busy', 'cheap', 'mail'], // cheap: 1k requests ≈ $0.00155 > mail: 10 emails = $0.001
  );
  assert.equal(report.apps[0].totals.emails, 1_000);
  assert.ok(report.apps[0].costUsd > report.apps[1].costUsd);
  assert.equal(report.orgs[0].org, 'org_a');
  assert.ok(Math.abs(report.totalUsd - report.apps.reduce((s, a) => s + a.costUsd, 0)) < 1e-12);
});

test('builds a month-scoped query and validates its inputs', () => {
  assert.match(reportSql('2026-09'), /u\.day LIKE '2026-09-%'/);
  assert.match(reportSql('2026-09', 'org_abcdefghijk'), /u\.org_id = 'org_abcdefghijk'/);
  assert.throws(() => reportSql("2026-09' OR 1=1"), /--month/);
  assert.throws(() => reportSql('2026-09', "x' OR '1"), /--org/);
});
