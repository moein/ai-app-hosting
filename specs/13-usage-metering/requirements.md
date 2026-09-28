# 13 — Usage Metering: Requirements

Every app costs the platform money when it's used: Worker requests and CPU, D1 reads, writes and storage, emails, the logs we keep for it, the builds it triggers, and the artifacts we store. The platform records these quantities per app and per day, so we know what each app and organization costs us. This is the basis for future plans and limits, and it lets us spot abuse early. v1 records and reports usage for operators; users don't see it yet and aren't billed.

## Stories & acceptance criteria

### USG-1 — Collect every cost-driving quantity per app and day
As the operator, I want each app's usage recorded daily, so that I know what every app and org costs us.

- **USG-1.1** THE SYSTEM SHALL record, per app and UTC day, every metric in the design's metric catalog (Workers requests and CPU time, static asset requests, D1 rows read/written and storage, emails, runtime log entries and bytes, builds and build minutes, deployments, artifact storage).
- **USG-1.2** WHEN the api worker's hourly cron runs THE SYSTEM SHALL pull Cloudflare-measured metrics (D1, static assets) for the current and the previous UTC day from the Cloudflare GraphQL Analytics API, attribute them to apps (D1 database id, hostname), and store each as that day's total, replacing the previous value.
- **USG-1.3** WHEN the hourly cron runs THE SYSTEM SHALL also recompute platform-measured day totals (Worker invocations and CPU time counted by the tail Worker from every trace event, log entries and bytes — all kept in each app's log buffer — builds and build minutes, deployments, artifact storage) for the current and the previous UTC day, replacing the previous value.
- **USG-1.4** WHEN `AppMail.send` succeeds THE SYSTEM SHALL add the number of recipients sent to the app's `emails` total for the day.
- **USG-1.5** THE SYSTEM SHALL make collection idempotent: running the job again for the same day SHALL yield the same totals.
- **USG-1.6** THE SYSTEM SHALL keep collecting storage metrics (D1 storage, artifact storage) for deleted apps as long as those resources exist, because they still cost us.
- **USG-1.7** IF one data source fails THEN THE SYSTEM SHALL still collect the others, log the failure, and write a `usage_collection_failed` metric with the source name.
- **USG-1.8** WHEN a deployment that ran a GitHub Actions build reaches a terminal state THE SYSTEM SHALL fetch the run's billable build time from GitHub once and store it on the deployment.

### USG-2 — Cost estimates and reports
As the operator, I want usage turned into an estimated cost, so that I can see which apps and orgs are expensive.

- **USG-2.1** THE SYSTEM SHALL keep one price table (unit prices in USD, with the date they were taken) for every metric, plus the per-request platform overhead (dispatcher invocation, route lookup, tail invocation, log write).
- **USG-2.2** THE SYSTEM SHALL provide an operator report (`scripts/usage-report.mjs <env> [--month YYYY-MM] [--org <id>]`) listing, per org and app, the month's quantities and estimated cost, sorted by cost.
- **USG-2.3** THE SYSTEM SHALL write a `usage_collected` metric per run (apps and rows written, duration) so collection health is visible.

## Non-functional requirements

- Collection for 1,000 apps completes within one cron invocation (< 30 s of wall time, few GraphQL queries: one per dataset per day, not per app).
- Cloudflare analytics are eventually consistent (minutes of lag); a day's totals are final once the previous-day re-collection has run after midnight UTC.
- No app content (request paths, email addresses, log text) is stored in usage records.

## Out of scope

- Showing usage to users through MCP tools, plans, billing and payments (open question).
- Hard usage caps beyond the existing quotas and per-request CPU limit (open question).
- Platform-side costs not caused by an app's use: MCP tool calls, provisioning, the platform's own storage.
