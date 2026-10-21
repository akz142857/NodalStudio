import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { verifyInstalledBinary } from '../windows_bundle_hash.mjs';

const source = Buffer.from('binary-prefix\0__TAURI_BUNDLE_TYPE_VAR_UNK\0binary-suffix');
const packaged = Buffer.from('binary-prefix\0__TAURI_BUNDLE_TYPE_VAR_NSS\0binary-suffix');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('allows exactly the NSIS marker change and retains both digests', () => {
  const before = Buffer.from(packaged);
  const receipt = verifyInstalledBinary(packaged, hash(source));
  assert.equal(receipt.installedSha256, hash(packaged));
  assert.equal(receipt.buildSha256, hash(source));
  assert.deepEqual(packaged, before);
});

test('rejects any other installed binary modification', () => {
  const changed = Buffer.from(packaged);
  changed[0] ^= 1;
  assert.throws(() => verifyInstalledBinary(changed, hash(source)), /differs beyond/);
});

test('rejects absent, ambiguous or incompatible bundle markers', () => {
  for (const invalid of [source, Buffer.concat([packaged, packaged]), Buffer.from('other binary')]) {
    assert.throws(() => verifyInstalledBinary(invalid, hash(source)), /one NSIS bundle marker/);
  }
});
