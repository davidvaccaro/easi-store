import test from 'node:test';
import assert from 'node:assert/strict';
import { checksumFor, parseOptions } from './package-portable.mjs';

test('portable target/version validation rejects unsafe and unsupported values', () => {
  assert.equal(parseOptions([]).nodeVersion, '24.22.1');
  assert.equal(parseOptions(['--target', 'darwin-arm64', '--node-version', 'v24.6.0', '--bundle-runtime']).bundleRuntime, true);
  assert.throws(() => parseOptions(['--target', '../../other']), /Unsupported target/);
  assert.throws(() => parseOptions(['--node-version', 'latest']), /exact Node/);
  assert.throws(() => parseOptions(['--node-version', '26.0.0']), /exact Node/);
  assert.throws(() => parseOptions(['--output']), /Missing value/);
  assert.throws(() => parseOptions(['--unexpected']), /Unknown argument/);
});

test('checksums match the complete filename and require a valid SHA-256', () => {
  const digest = 'a'.repeat(64);
  assert.equal(checksumFor(`${digest}  node-v24.6.0-darwin-arm64.tar.gz\n`, 'node-v24.6.0-darwin-arm64.tar.gz'), digest);
  assert.throws(() => checksumFor(`${digest}  prefix-node-v24.6.0-darwin-arm64.tar.gz`, 'node-v24.6.0-darwin-arm64.tar.gz'), /not found/);
  assert.throws(() => checksumFor('invalid  node-v24.6.0-darwin-arm64.tar.gz', 'node-v24.6.0-darwin-arm64.tar.gz'), /not found/);
});
