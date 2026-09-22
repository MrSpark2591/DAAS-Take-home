-- Real authentication: password hashes on users, and rotating refresh tokens.

-- ---------------------------------------------------------------------------
-- Passwords
--
-- Added in two steps because `users` already has seeded rows. A NOT NULL column
-- cannot simply appear on a populated table, and the placeholder below is not a
-- usable password -- it is a syntactically valid scrypt string whose hash no
-- input can produce, so every existing row is locked out until reseeded.
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN "password_hash" VARCHAR(255);

UPDATE "users"
SET "password_hash" = 'scrypt$16384$8$1$000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
WHERE "password_hash" IS NULL;

ALTER TABLE "users" ALTER COLUMN "password_hash" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Refresh tokens
-- ---------------------------------------------------------------------------
CREATE TABLE "refresh_tokens" (
  "id"         UUID           NOT NULL,
  "user_id"    UUID           NOT NULL,
  "token_hash" VARCHAR(64)    NOT NULL,
  "family_id"  UUID           NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "rotated_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "user_agent" VARCHAR(400),
  "ip_address" VARCHAR(64),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- Deleting a user takes their sessions with them; there is nothing to audit
-- about a session whose owner no longer exists.
ALTER TABLE "refresh_tokens"
  ADD CONSTRAINT "refresh_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The hash is the lookup key on every refresh, so it must be unique and indexed.
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens" ("token_hash");

-- Revoking a whole family on reuse detection, and listing a user's sessions.
CREATE INDEX "refresh_tokens_user_id_idx"  ON "refresh_tokens" ("user_id");
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens" ("family_id");

-- Lets a cleanup job find expired rows without a sequential scan.
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens" ("expires_at");

-- A token cannot expire before it was issued.
ALTER TABLE "refresh_tokens"
  ADD CONSTRAINT "refresh_tokens_expiry_after_creation"
  CHECK ("expires_at" > "created_at");

-- ---------------------------------------------------------------------------
-- Email uniqueness now matters for more than tidiness: it is the login
-- identifier. The partial index from the initial migration already enforces
-- this for live rows, so nothing to add -- noted here so the intent is on the
-- record next to the auth tables.
-- ---------------------------------------------------------------------------
