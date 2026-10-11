const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const child = require('node:child_process');

const root = path.join(__dirname, '..');
test('coffee catalog is deterministic and provenance scoped', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data/coffee-catalog.json')));
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(catalog.sources.some((s) => s.id === 'coffee-circle-catalog' && s.coverage.status === 'complete'));
  assert.ok(catalog.products.length >= 1);
  assert.equal(catalog.products.some((p) => p.name === 'KRUVE Siebe'), false);
  const calendar = catalog.products.find((p) => p.id === 'coffee-circle-adventskalender');
  assert.equal(calendar.beanEligible, false);
  assert.equal(calendar.format, 'bundle');
  for (const name of ['Apas, Espresso aus Brasilien', 'Henrique, Espresso aus Brasilien', 'Amigo, Filterkaffee', 'Compadre, italienischer Espresso', 'Bharath - Espresso aus Indien', 'Dreispitz, Espresso Blend', 'El Botón - Kaffee für den Vollautomaten', 'Mano, Espresso Blend']) {
    const product = catalog.products.find((p) => p.name === name);
    assert.ok(product, name);
    assert.notEqual(product.format, 'bundle', name);
  }
  const ids = new Set(catalog.products.map((p) => p.id));
  assert.equal(ids.size, catalog.products.length);
  for (const product of catalog.products) {
    assert.match(product.url, /^https:\/\//);
    assert.equal(typeof product.sourceId, 'string');
    assert.equal(typeof product.beanEligible, 'boolean');
    assert.ok(['whole-bean', 'ground', 'capsule', 'ready-to-drink', 'bundle', 'green-bean', 'unknown'].includes(product.format));
    assert.ok(product.decaf === true || product.decaf === null);
    if (!product.beanEligible) assert.notEqual(product.format, 'whole-bean');
  }
  child.execFileSync('python3', ['scripts/update-coffee-catalog.py', '--check'], { cwd: root, stdio: 'pipe' });
});

test('offline Shopify normalization keeps absent facts unknown', () => {
  const script = path.join(root, 'scripts/update-coffee-catalog.py');
  const fixture = path.join('/private/tmp', 'coffee-catalog-fixture.json');
  fs.writeFileSync(fixture, JSON.stringify({ products: [{ title: 'Example', handle: 'example', product_type: 'Kaffee', tags: ['origin: Colombia', 'category: espresso', 'Geschenkabo'] }] }));
  const output = path.join('/private/tmp', 'coffee-catalog-fixture-output.json');
  fs.copyFileSync(path.join(root, 'data/coffee-catalog.json'), output);
  const result = child.spawnSync('python3', [script, '--shopify-json', fixture, '--publisher', 'Example Roaster', '--catalog-url', 'https://example.test/collections/coffee', '--output', output], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const catalog = JSON.parse(fs.readFileSync(output));
  const entry = catalog.products.find((p) => p.publisher === 'Example Roaster');
  assert.equal(entry.origin, 'Colombia');
  assert.equal(entry.process, null);
  assert.equal(entry.recommendedBrew, null);
  assert.equal(entry.format, 'unknown');
  assert.equal(entry.beanEligible, false);
  assert.equal(entry.decaf, null);
});

test('offline Coffee Circle JSON-LD normalization blocks non-bean formats', () => {
  const script = path.join(root, 'scripts/update-coffee-catalog.py');
  const fixture = '/private/tmp/coffee-circle-jsonld.json';
  const output = '/private/tmp/coffee-circle-jsonld-output.json';
  fs.writeFileSync(fixture, JSON.stringify([
    {'@type': 'ProductGroup', name: 'Arara Premium Coffee', url: 'https://www.coffeecircle.com/en/k/arara'},
    {'@type': 'ProductGroup', name: 'Espresso Capsules Set', url: 'https://www.coffeecircle.com/en/k/capsules-set'},
  ]));
  fs.copyFileSync(path.join(root, 'data/coffee-catalog.json'), output);
  const result = child.spawnSync('python3', [script, '--jsonld', fixture, '--publisher', 'Coffee Circle', '--catalog-url', 'https://www.coffeecircle.com/sitemap.xml', '--output', output], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const catalog = JSON.parse(fs.readFileSync(output));
  const bean = catalog.products.find((p) => p.name === 'Arara Premium Coffee');
  const capsules = catalog.products.find((p) => p.name === 'Espresso Capsules Set');
  assert.equal(bean.beanEligible, false);
  assert.equal(bean.format, 'unknown');
  assert.equal(bean.decaf, null);
  assert.equal(capsules.beanEligible, false);
  assert.equal(capsules.format, 'capsule');
});
