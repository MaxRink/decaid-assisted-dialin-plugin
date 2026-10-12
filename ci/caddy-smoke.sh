#!/bin/sh
# Exercise the supplied proxy configuration with isolated local TLS, without public DNS.
set -eu
cd "$(dirname "$0")/.."
run_id="decaid-caddy-smoke-$(date +%s)-$$"
image="$run_id:local"
backend_image="$run_id:backend"
cleanup() {
  docker rm -f "$run_id-tls" "$run_id-backend" >/dev/null 2>&1 || true
  docker network rm "$run_id" >/dev/null 2>&1 || true
  docker volume rm "$run_id-data" "$run_id-config" >/dev/null 2>&1 || true
  docker image rm "$image" "$backend_image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 1' INT TERM
docker build --tag "$image" collector/caddy
docker build --tag "$backend_image" --file collector/Dockerfile .
docker run --rm --env RESEARCH_DOMAIN=localhost \
  --mount "type=bind,source=$(pwd)/collector/Caddyfile,target=/etc/caddy/Caddyfile,readonly" \
  "$image" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker run --rm "$image" caddy build-info
docker network create --internal "$run_id" >/dev/null
docker volume create "$run_id-data" >/dev/null
docker volume create "$run_id-config" >/dev/null
docker run --detach --name "$run_id-backend" --network "$run_id" --network-alias collector \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true --entrypoint node \
  "$backend_image" -e 'require("node:http").createServer((req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({url:req.url,headers:req.headers}));}).listen(8787,"0.0.0.0")' >/dev/null
docker run --detach --name "$run_id-tls" --network "$run_id" --network-alias tls \
  --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges:true \
  --env RESEARCH_DOMAIN=localhost \
  --mount "type=bind,source=$(pwd)/collector/Caddyfile,target=/etc/caddy/Caddyfile,readonly" \
  --mount "type=volume,source=$run_id-data,target=/data" \
  --mount "type=volume,source=$run_id-config,target=/config" "$image" >/dev/null
docker exec -i "$run_id-backend" node <<'NODE'
const assert = require('node:assert/strict');
const https = require('node:https');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function request(path) {
  return new Promise((resolve, reject) => {
    // Caddy issues a local CA certificate for localhost; this isolated test has no public trust assertion.
    const req = https.get({ hostname: 'tls', servername: 'localhost', port: 443, path,
      rejectUnauthorized: false, timeout: 2000, headers: { Host: 'localhost', Cookie: 'private-cookie',
        Authorization: 'Bearer private-token', 'X-Forwarded-For': '192.0.2.1', 'X-Real-IP': '192.0.2.2' } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('TLS request timed out')));
    req.on('error', reject);
  });
}
(async () => {
  let health;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { health = await request('/healthz'); if (health.status === 200) break; } catch {}
    await delay(250);
  }
  assert.equal(health?.status, 200, 'local TLS proxy did not start');
  for (const path of ['/healthz', '/v1/events']) {
    const response = await request(path);
    assert.equal(response.status, 200);
    const forwarded = JSON.parse(response.body);
    assert.equal(forwarded.url, path);
    for (const header of ['cookie', 'authorization', 'x-forwarded-for', 'x-real-ip']) assert.equal(forwarded.headers[header], undefined);
  }
  for (const path of ['/metrics', '/', '/v1/events/extra']) assert.equal((await request(path)).status, 404);
  console.log('Caddy isolated TLS, proxy routing, sensitive-header removal and private-metrics boundary passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
NODE
