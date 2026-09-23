-- Remove two permissions that gated nothing.
--
-- `stock:adjust` and `user:read` were added when the catalogue was written, on
-- the assumption that the operations would follow. They did not: no resolver
-- checks either one, so granting them changed nothing.
--
-- A permission that grants nothing is worse than an absent one -- it tells an
-- administrator they have allowed something they have not. The catalogue should
-- describe what the system can actually do.
--
-- `stock:adjust` comes back with the adjust/transfer mutations it was named for,
-- and `user:read` with a user-administration screen. Adding a permission is one
-- INSERT and one line in the catalogue; carrying a misleading one has no upper
-- bound on how long it misleads.

DELETE FROM "role_permissions"
WHERE "permission_id" IN (
  SELECT "id" FROM "permissions" WHERE "key" IN ('stock:adjust', 'user:read')
);

DELETE FROM "permissions" WHERE "key" IN ('stock:adjust', 'user:read');
