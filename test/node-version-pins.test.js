import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// First release on each supported line that rejects TLS chains through the
// compromised eMudhra intermediates (nodejs/node#66871). Odd majors (23, 25)
// are end-of-life and never received the fix, so the engine range skips them.
const PATCHED_FLOORS = ['22.23.4', '24.22.1', '26.12.1'];
const SUPPORTED_ENGINES = '^22.23.4 || ^24.22.1 || >=26.12.1';

function readRepoFile(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('engines.node admits only Node releases with the eMudhra blocklist', () => {
  const manifest = JSON.parse(readRepoFile('package.json'));
  assert.equal(manifest.engines.node, SUPPORTED_ENGINES);
});

test('install docs state the patched Node floors', () => {
  for (const path of ['README.md', 'CONTRIBUTING.md']) {
    const doc = readRepoFile(path);
    for (const floor of PATCHED_FLOORS) {
      assert.ok(doc.includes(`Node.js ${floor}`), `${path} must mention Node.js ${floor}`);
    }
    assert.doesNotMatch(doc, /Node\.js 22\.13/, `${path} still documents the unpatched floor`);
  }
});
