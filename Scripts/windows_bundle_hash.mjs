import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Tauri 2.11.4 changes this fixed-size marker while bundling NSIS, then restores
// the original Cargo executable. Normalize only this documented three-byte change.
// https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle.rs
const original = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
const installed = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function verifyInstalledBinary(bytes, expectedBuildHash) {
  assert.match(expectedBuildHash, /^[a-f0-9]{64}$/);
  const offset = bytes.indexOf(installed);
  assert(offset >= 0 && bytes.indexOf(installed, offset + 1) === -1, 'Expected one NSIS bundle marker');
  const normalized = Buffer.from(bytes);
  original.copy(normalized, offset);
  assert.equal(hash(normalized), expectedBuildHash, 'Installed binary differs beyond the Tauri NSIS marker');
  return { installedSha256: hash(bytes), buildSha256: expectedBuildHash, normalizedMarkerOffset: offset };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(JSON.stringify(verifyInstalledBinary(await readFile(process.argv[2]), process.argv[3])));
}
