CREATE TABLE broker_api_keys (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
 prefix text NOT NULL UNIQUE,
 secret_digest text NOT NULL CHECK (secret_digest ~ '^[a-f0-9]{64}$'),
 scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes)='array'),
 limits jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(limits)='object'),
 issued_role text NOT NULL CHECK (issued_role IN ('buyer','provider')),
 issued_provider_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 last_used_at timestamptz,
 revoked_at timestamptz,
 CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days')
);
CREATE INDEX broker_api_keys_owner_page ON broker_api_keys(user_id,created_at DESC,id DESC);
CREATE INDEX broker_api_keys_owner_active ON broker_api_keys(user_id,expires_at) WHERE revoked_at IS NULL;

-- An account can never resurrect a credential by returning to an earlier role or binding.
CREATE FUNCTION broker_revoke_keys_after_account_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.role IS DISTINCT FROM OLD.role OR NEW."providerId" IS DISTINCT FROM OLD."providerId" THEN
  UPDATE broker_api_keys SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=OLD.id AND revoked_at IS NULL AND expires_at>statement_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER broker_keys_account_change AFTER UPDATE OF role,"providerId" ON "user"
 FOR EACH ROW EXECUTE FUNCTION broker_revoke_keys_after_account_change();
CREATE FUNCTION broker_revoke_keys_after_provider_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  UPDATE broker_api_keys SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=OLD.user_id AND revoked_at IS NULL AND expires_at>statement_timestamp();
  RETURN OLD;
 ELSIF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
  UPDATE broker_api_keys SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id IN(OLD.user_id,NEW.user_id) AND revoked_at IS NULL AND expires_at>statement_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER broker_keys_provider_change AFTER UPDATE OF user_id OR DELETE ON broker_providers
 FOR EACH ROW EXECUTE FUNCTION broker_revoke_keys_after_provider_change();
