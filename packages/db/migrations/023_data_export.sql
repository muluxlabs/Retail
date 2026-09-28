-- Exporting records.
--
-- The item master, suppliers, customers, supplier price lists and staff can be
-- downloaded as a spreadsheet. A whole customer list or cost list leaving the
-- building is worth controlling, so it is a permission of its own: given to
-- administrators and branch managers, grantable to (or taken from) any one
-- person on the Access screen. Every export is written to the audit log.

INSERT INTO permission (id, description) VALUES
    ('data.export', 'Export records (items, suppliers, customers, price lists, staff) to Excel or CSV')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_permission (role_id, permission_id) VALUES
    ('administrator',  'data.export'),
    ('branch_manager', 'data.export')
ON CONFLICT DO NOTHING;
