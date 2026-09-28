-- The time zone the business trades in.
--
-- "Today", the hour a sale happened and the day a receipt belongs to are the
-- shop's, not the server's UTC. Without this a sale at 00:30 in Harare would
-- be counted as yesterday's, and hourly trading patterns would be two hours out.
INSERT INTO system_setting (key, value) VALUES ('business_timezone', 'Africa/Harare')
ON CONFLICT (key) DO NOTHING;
