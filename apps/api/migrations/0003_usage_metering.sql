CREATE TABLE `app_usage_daily` (
	`app_id` text NOT NULL,
	`org_id` text NOT NULL,
	`day` text NOT NULL,
	`metric` text NOT NULL,
	`quantity` real NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `day`, `metric`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `app_usage_daily_org_day` ON `app_usage_daily` (`org_id`,`day`);--> statement-breakpoint
ALTER TABLE `deployments` ADD `build_billable_ms` integer;