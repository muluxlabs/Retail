-- ============================================================================
--  Migration 008: a real Settings screen
--
--  system_setting (migration 006) existed but had no way to change it short
--  of a migration - exactly the redeploy its own comment said it was meant
--  to avoid. This is the missing other half: a generic read/update API and
--  the permission gating it.
--
--  The client's own words: "Settings category that is accessed by the admin
--  only or admin chooses who will have access to them." administrator holds
--  settings.manage by default, same narrow-by-default precedent as
--  branch.manage. settings_manager is the "admin chooses" half: a role that
--  carries nothing but this, so an admin can delegate Settings access to
--  someone through the Staff screen's existing role assignment without
--  handing them full administrator.
-- ============================================================================

INSERT INTO permission (id, description) VALUES
    ('settings.manage', 'View and change system settings');

INSERT INTO role_permission (role_id, permission_id) VALUES
    ('administrator', 'settings.manage');

INSERT INTO role (id, name) VALUES
    ('settings_manager', 'Settings Manager');

INSERT INTO role_permission (role_id, permission_id) VALUES
    ('settings_manager', 'dashboard.read'),
    ('settings_manager', 'settings.manage');
