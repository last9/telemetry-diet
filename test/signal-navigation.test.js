import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('workbench exposes logs, traces, and metrics as analysis modes', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');

  assert.match(html, /data-signal="logs"/);
  assert.match(html, /data-signal="traces"/);
  assert.match(html, /data-signal="metrics"/);
  assert.doesNotMatch(html, /data-signal="(?:traces|metrics)"[^>]*disabled/);
});
