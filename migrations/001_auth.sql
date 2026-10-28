CREATE TABLE IF NOT EXISTS "user" (
 id text PRIMARY KEY, name text NOT NULL, email text UNIQUE NOT NULL,
 "emailVerified" boolean NOT NULL DEFAULT false, image text,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
 role text NOT NULL DEFAULT 'buyer' CHECK (role IN ('buyer','provider','admin')),
 "providerId" text
);
CREATE TABLE IF NOT EXISTS "session" (
 id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text UNIQUE NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
 "ipAddress" text, "userAgent" text, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS auth_session_user_idx ON "session"("userId");
CREATE TABLE IF NOT EXISTS account (
 id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
 "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 "accessToken" text, "refreshToken" text, "idToken" text,
 "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
 scope text, password text,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE("providerId","accountId")
);
CREATE INDEX IF NOT EXISTS auth_account_user_idx ON account("userId");
CREATE TABLE IF NOT EXISTS verification (
 id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
 "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_verification_identifier_idx ON verification(identifier);
