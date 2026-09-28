-- Failed sign-ins by address.
--
-- Sign-in refuses an address after too many failures in a short window (see
-- routes/auth.ts). It counts LOGIN_FAILED audit entries for that address, so
-- this index keeps the count cheap however long the audit log grows. Partial:
-- only failed sign-ins are indexed.

CREATE INDEX IF NOT EXISTS audit_log_login_failed_ip_idx
    ON audit_log ((state_after->>'ip'), occurred_at)
    WHERE action_code = 'LOGIN_FAILED';
