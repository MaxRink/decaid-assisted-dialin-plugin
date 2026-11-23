#!/bin/sh
# Exercise the deployment image; remove only resources created by this invocation.
set -eu
cd "$(dirname "$0")/.."
run_id="decaid-collector-smoke-$(date +%s)-$$"
image="$run_id:local"
cleanup() {
  docker rm -f "$run_id" >/dev/null 2>&1 || true
  docker volume rm "$run_id" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 1' INT TERM
docker build --tag "$image" --file collector/Dockerfile .
docker volume create "$run_id" >/dev/null
docker run --detach --name "$run_id" --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --mount "type=volume,source=$run_id,target=/var/lib/research" \
  --env RESEARCH_ALLOWED_ORIGINS=https://lab.example.org \
  --env RESEARCH_METRICS_PORT=8788 --env RESEARCH_METRICS_BIND_HOST=0.0.0.0 \
  "$image" >/dev/null
# The first phase prints the enrolled token so the restart phase can retry as
# the same installation.
first_phase=$(docker exec -i "$run_id" node <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  assert.notEqual(process.getuid(), 0, 'collector must run unprivileged');
  for (const unused of ['/usr/local/lib/node_modules/npm', '/usr/local/bin/npm', '/usr/local/bin/npx']) await assert.rejects(fs.lstat(unused), { code: 'ENOENT' });
  await assert.rejects(fs.writeFile('/tmp/collector-rootfs-probe', 'no'), { code: 'EROFS' });
  const base = 'http://127.0.0.1:8787';
  for (let attempt = 0; ; attempt++) {
    try { assert.equal((await fetch(base + '/healthz')).status, 200); break; }
    catch (error) { if (attempt === 49) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  const record = { schemaVersion: 1, source: 'website', mode: 'measured', kind: 'shot', observationId: 'a'.repeat(32), revision: 1, measurements: { doseG: 18 } };
  const batch = value => ({ schemaVersion: 1, policyVersion: 1, records: [value] });
  const enrolment = await fetch(base + '/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, policyVersion: 1, enrol: true }) });
  assert.equal(enrolment.status, 201);
  const { token } = await enrolment.json(); assert.match(token, /^[a-f0-9]{64}$/);
  const post = (value, origin = 'https://lab.example.org', key = token) => fetch(base + '/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Research-Token': key }, body: JSON.stringify(batch(value)) });
  const correction = { ...record, revision: 2, measurements: { doseG: 19 } };
  for (const value of [record, record, correction, record]) {
    const response = await post(value); assert.equal(response.status, 201); assert.deepEqual(await response.json(), { accepted: 1 });
  }
  assert.equal((await post({ ...record, observationId: 'b'.repeat(32) }, 'https://evil.example.org')).status, 403);
  assert.equal((await post({ ...record, notes: 'must not persist' })).status, 400);
  assert.equal((await post({ ...record, revision: 3 }, 'https://lab.example.org', 'f'.repeat(64))).status, 403, 'another installation cannot overwrite');
  const directory = process.env.RESEARCH_DATA_DIR;
  const names = await fs.readdir(directory); assert.deepEqual(names, ['research-' + record.observationId + '.json']);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(directory, names[0]))).mode & 0o777, 0o600);
  const { owner, ...stored } = JSON.parse(await fs.readFile(path.join(directory, names[0]), 'utf8'));
  assert.deepEqual(stored, batch(correction)); assert.match(owner, /^[a-f0-9]{64}$/); assert.notEqual(owner, token);
  assert.equal((await fetch(base + '/metrics')).status, 404);
  const metrics = await fetch('http://127.0.0.1:8788/metrics'); assert.equal(metrics.status, 200);
  const text = await metrics.text(); assert.match(text, /^decaid_research_retained_records 1$/m);
  assert.equal(text.includes(record.observationId), false);
  assert.equal((await fetch('http://127.0.0.1:8788/metrics', { headers: { Origin: 'https://lab.example.org' } })).status, 403);
  console.log('Deployment image: non-root, read-only root filesystem, private volume, enrolment, ownership, ingestion, origin/schema rejection, idempotent corrections and private aggregate metrics passed');
  console.log('TOKEN=' + token);
})().catch(error => { console.error(error); process.exitCode = 1; });
NODE
)
printf '%s\n' "$first_phase" | grep -v '^TOKEN='
token=$(printf '%s\n' "$first_phase" | sed -n 's/^TOKEN=//p')
[ -n "$token" ]
docker restart "$run_id" >/dev/null
docker exec -i --env "SMOKE_TOKEN=$token" "$run_id" node <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const directory = process.env.RESEARCH_DATA_DIR;
  const names = await fs.readdir(directory); assert.equal(names.length, 1);
  const stored = JSON.parse(await fs.readFile(path.join(directory, names[0]), 'utf8'));
  assert.equal(stored.records[0].revision, 2);
  const { owner: _owner, ...retry } = stored;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:8787/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Research-Token': process.env.SMOKE_TOKEN }, body: JSON.stringify(retry) });
      assert.equal(response.status, 201); assert.deepEqual(await response.json(), { accepted: 1 }); break;
    } catch (error) { if (attempt === 49) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.deepEqual(await fs.readdir(directory), names);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, names[0]), 'utf8')), stored);
  console.log('Deployment image: durable restart and no-Origin retry by the same installation preserve the single corrected observation');
})().catch(error => { console.error(error); process.exitCode = 1; });
NODE
