CREATE TABLE `app_secrets` (
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `name`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`provisioning` text DEFAULT 'pending' NOT NULL,
	`provisioning_error` text,
	`script_name` text NOT NULL,
	`repo_owner` text NOT NULL,
	`repo_name` text NOT NULL,
	`repo_id` integer,
	`d1_database_id` text,
	`d1_database_name` text NOT NULL,
	`live_deployment_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apps_slug_unique` ON `apps` (`slug`);--> statement-breakpoint
CREATE INDEX `apps_org_status_created` ON `apps` (`org_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`org_id` text NOT NULL,
	`trigger` text NOT NULL,
	`commit_sha` text NOT NULL,
	`commit_message` text,
	`source_deployment_id` text,
	`status` text NOT NULL,
	`error_code` text,
	`error_details` text,
	`run_id` integer,
	`run_attempt` integer,
	`job_id` integer,
	`artifact_key` text,
	`artifact_bytes` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`build_finished_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deployments_app_created` ON `deployments` (`app_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `deployments_app_commit` ON `deployments` (`app_id`,`commit_sha`);--> statement-breakpoint
CREATE INDEX `deployments_status_created` ON `deployments` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `usage_counters` (
	`org_id` text NOT NULL,
	`metric` text NOT NULL,
	`day` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`org_id`, `metric`, `day`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
