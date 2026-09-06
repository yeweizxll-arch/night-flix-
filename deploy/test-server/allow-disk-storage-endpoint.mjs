// Run as root on the Night Flix TEST server only, after backing up /etc/nightflix.
// Adds one public IP to the storage allowlist without changing any other setting.
import { hostname } from 'node:os';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import assert from 'node:assert/strict';
assert.equal(hostname(), 'iZbp1h5xl9g8stv73aco8mZ');
assert.equal(process.getuid(), 0);
const path = '/etc/nightflix/runtime.env';
const original = readFileSync(path, 'utf8');
const key = 'STORAGE_ENDPOINT_HOST_ALLOWLIST';
const lines = original.split('\n');
const matching = lines.map((line, i) => line.startsWith(key + '=') ? i : -1).filter(i => i >= 0);
assert.ok(matching.length <= 1, 'Ambiguous environment file');
const index = matching[0];
let current = index === undefined ? '' : lines[index].slice(key.length + 1).trim();
if (/^(["']).*\1$/.test(current)) current = current.slice(1, -1);
assert.match(current, /^[a-zA-Z0-9.*,-]*$/, 'Unexpected allowlist syntax');
const value = [...new Set([...current.split(',').filter(Boolean), '47.110.245.29'])].join(',');
if (index === undefined) lines.push(`${key}=${value}`); else lines[index] = `${key}=${value}`;
writeFileSync(path + '.disk-storage-new', lines.join('\n'), { mode: 0o600, flag: 'wx' });
renameSync(path + '.disk-storage-new', path);
console.log('Allowlisted the public test IP; all other runtime settings preserved');
