-- Daily active users: distinct signed-in users making tool calls, last 30 days.
SELECT toStartOfDay(timestamp) AS day, COUNT(DISTINCT blob8) AS active_users
FROM platform_metrics_prod
WHERE blob1 = 'tool_call' AND blob8 != '' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day
ORDER BY day;
