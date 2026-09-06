// Run on a development machine/CI only. The target directory must not exist.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const output = process.argv[2] && resolve(process.argv[2]);
if (!output || existsSync(output)) throw new Error('Provide a new absolute artifact directory');
const run = (command, args, env = {}) => execFileSync(command, args, {
  stdio: 'inherit', env: { ...process.env, ...env },
});
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) throw new Error('Refusing to package a dirty worktree');
const commit = git('rev-parse', 'HEAD');
mkdirSync(output, { recursive: true });
run('pnpm', ['--filter', '@drama/api', 'build']);
run('pnpm', ['--filter', '@drama/api', 'deploy', '--legacy', '--prod', `${output}/apps/api`]);
cpSync('database/migrations', `${output}/database/migrations`, { recursive: true });
for (const scope of ['platform', 'tenant']) {
  run('pnpm', ['--filter', '@drama/admin', 'build'], { VITE_ADMIN_SCOPE: scope });
  cpSync('apps/admin/dist', `${output}/static/${scope}`, { recursive: true });
}
run('pnpm', ['--filter', '@drama/h5', 'build']);
cpSync('apps/h5/dist', `${output}/static/web`, { recursive: true });
const manifest = { commit, builtAt: new Date().toISOString(), target: 'linux-x64-glibc',
  nodeVersion: '24.20.0', services: ['web', 'admin', 'agent', 'worker'] };
// Fail locally if the platform-specific prebuilt runtime was not packaged.
const sharpPath = `${output}/apps/api/node_modules/.pnpm`;
const { readdirSync } = await import('node:fs');
if (!readdirSync(sharpPath).some(name => name.startsWith('@img+sharp-linux-x64@'))) {
  throw new Error('Linux x64 sharp binary missing; install with supportedArchitectures first');
}
writeFileSync(`${output}/release.json`, JSON.stringify(manifest, null, 2) + '\n');
run('tar', ['-czf', `${output}.tar.gz`, '-C', output, '.']);
const digest = createHash('sha256').update(readFileSync(`${output}.tar.gz`)).digest('hex');
writeFileSync(`${output}.sha256`, `${digest}  ${output.split('/').pop()}.tar.gz\n`);
console.log(JSON.stringify({ ...manifest, sha256: digest }));
