#!/usr/bin/env bash
set -euo pipefail

if ! command -v trivy >/dev/null 2>&1; then
  echo 'Install Trivy v0.76.1 before running the production container release gate.' >&2
  exit 1
fi

# Every resource is disposable and unique; DOCKER_CONTEXT can select an isolated daemon.
fixture_id="broker-smoke-${RANDOM}-$$"
fixture_network="${fixture_id}-network"
fixture_db="${fixture_id}-db"
fixture_app="${fixture_id}-app"
fixture_image="${fixture_id}:test"
cleanup() {
  docker rm -f "$fixture_app" "$fixture_db" >/dev/null 2>&1 || true
  docker network rm "$fixture_network" >/dev/null 2>&1 || true
  docker image rm "$fixture_image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker build --tag "$fixture_image" .
node scripts/scan-image-secrets.mjs "$fixture_image"
# Scan the exact runtime image that the smoke test starts. No unfixed-vulnerability
# exclusions or implicit .trivyignore suppressions: triage failures before release.
trivy image --scanners vuln --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL --exit-code 1 \
  --no-progress --timeout 10m --ignorefile /dev/null "$fixture_image"
# Production commands must work without package managers or their bundled dependencies.
docker run --rm "$fixture_image" sh -ec '
  for tool in npm npx yarn yarnpkg; do
    if command -v "$tool" >/dev/null 2>&1; then
      echo "Unexpected package manager in production: $tool" >&2
      exit 1
    fi
  done
  test ! -d /usr/local/lib/node_modules
  test -s /usr/local/LICENSE
'
docker network create "$fixture_network" >/dev/null
docker run -d --name "$fixture_db" --network "$fixture_network" \
  -e POSTGRES_DB=broker_smoke -e POSTGRES_USER=broker_smoke \
  -e POSTGRES_PASSWORD=container-fixture-only-password postgres:16-alpine >/dev/null
db_ready=false
for attempt in $(seq 1 60); do
  if docker exec "$fixture_db" pg_isready -U broker_smoke -d broker_smoke >/dev/null 2>&1; then
    db_ready=true
    break
  fi
  sleep 1
done
if [ "$db_ready" != true ]; then
  echo 'Disposable container database did not become ready.' >&2
  exit 1
fi
fixture_env=(
  -e "DATABASE_URL=postgresql://broker_smoke:container-fixture-only-password@${fixture_db}:5432/broker_smoke" \
  -e BETTER_AUTH_SECRET=container-fixture-only-auth-secret-at-least-32-characters \
  -e APP_URL=https://broker-smoke.invalid -e WICK_MODE=fixture -e MUSE_MODE=fixture \
  -e SEED_BUYER_PASSWORD=container-fixture-buyer-password \
  -e SEED_SUPPLIER_A_PASSWORD=container-fixture-supplier-a-password \
  -e SEED_SUPPLIER_B_PASSWORD=container-fixture-supplier-b-password \
  -e SEED_SUPPLIER_C_PASSWORD=container-fixture-supplier-c-password \
  -e SEED_ADMIN_PASSWORD=container-fixture-admin-password
)
docker run --rm --network "$fixture_network" "${fixture_env[@]}" \
  "$fixture_image" node dist/scripts/migrate.js
docker run --rm --network "$fixture_network" "${fixture_env[@]}" \
  "$fixture_image" node dist/scripts/seed.js
docker run -d --name "$fixture_app" --network "$fixture_network" \
  -p 127.0.0.1::3000 "${fixture_env[@]}" "$fixture_image" >/dev/null
fixture_port=$(docker port "$fixture_app" 3000/tcp | sed -n 's/^127\.0\.0\.1://p')
if [ -z "$fixture_port" ]; then
  echo 'Container did not expose its loopback smoke-test port.' >&2
  exit 1
fi
BROKER_SMOKE_URL="http://127.0.0.1:${fixture_port}" node scripts/verify-container-http.mjs
test "$(docker exec "$fixture_app" id -u)" != 0
docker stop --time 30 "$fixture_app" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$fixture_app")" = 0
echo 'Production container build, readiness, assets, isolation, and shutdown checks passed.'
