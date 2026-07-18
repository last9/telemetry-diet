import assert from 'node:assert/strict';
import test from 'node:test';

import { selectPackDetails } from '../scripts/pack-output.js';

const packageDetails = {
  name: 'telemetry-diet',
  files: [],
  entryCount: 0,
  size: 0,
};

test('selects the single package from npm 10 array output', () => {
  assert.equal(selectPackDetails([packageDetails], 'telemetry-diet'), packageDetails);
});

test('selects the named package from npm 12 keyed output', () => {
  assert.equal(
    selectPackDetails({ 'telemetry-diet': packageDetails }, 'telemetry-diet'),
    packageDetails,
  );
});

test('rejects ambiguous npm pack output', () => {
  assert.throws(
    () => selectPackDetails([packageDetails, packageDetails], 'telemetry-diet'),
    /expected exactly one/,
  );
  assert.throws(
    () => selectPackDetails({ other: packageDetails }, 'telemetry-diet'),
    /unexpected package keys/,
  );
});

test('rejects malformed package metadata', () => {
  assert.throws(() => selectPackDetails(null, 'telemetry-diet'), /unsupported JSON shape/);
  assert.throws(
    () => selectPackDetails([{ ...packageDetails, files: undefined }], 'telemetry-diet'),
    /missing its file list/,
  );
  assert.throws(
    () => selectPackDetails([{ ...packageDetails, size: Number.NaN }], 'telemetry-diet'),
    /invalid packed size/,
  );
});
