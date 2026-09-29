-- Removing items.
--
-- Items never used are deleted; items with history are archived (see
-- apps/api/src/routes/productRemoval.ts). Ten or more at once is raised for
-- a second person to review, as this kind of exception.

ALTER TYPE exception_kind ADD VALUE 'items_removed';
