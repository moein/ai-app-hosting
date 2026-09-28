-- Error rate by tool and MCP client, last 24 hours.
SELECT blob2 AS tool, blob5 AS client,
       SUM(_sample_interval * double1) AS calls,
       SUM(IF(blob3 = 'error', _sample_interval * double1, 0.0)) / SUM(_sample_interval * double1) AS error_rate
FROM platform_metrics_prod
WHERE blob1 = 'tool_call' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY tool, client
ORDER BY calls DESC;
