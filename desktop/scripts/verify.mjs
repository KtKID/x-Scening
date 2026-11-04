// 保留每次验证的真实命令、起止时间、输出与退出码。
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.dirname(desktop);
const evidence = path.join(root, 'reports/desktop-client-20261027');
const commands = process.argv.includes('--tech')
  ? [
      ['tech-check', ['run', 'check']],
      ['tech-unit-tests', ['test']],
    ]
  : [
      ['check', ['run', 'check']],
      ['unit-tests', ['test']],
      ['build', ['run', 'build']],
      ['electron-e2e', ['run', 'test:e2e']],
      ['package', ['run', 'package']],
    ];
const records = [];
for (const [label, args] of commands) {
  const startedAt = new Date().toISOString();
  const run = spawnSync('npm', args, {
    cwd: desktop,
    env: process.env,
    encoding: 'utf8',
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  writeFileSync(path.join(evidence, `${label}.log`), output);
  records.push({
    command: `npm ${args.join(' ')}`,
    cwd: desktop,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: run.status,
    output: `${label}.log`,
    emptyOutput: output.length === 0,
  });
  console.log(`${label}: exit ${run.status}`);
  if (run.status !== 0) {
    console.error(output);
    process.exitCode = 1;
    break;
  }
}
writeFileSync(
  path.join(
    evidence,
    process.argv.includes('--tech')
      ? 'tech-executions.json'
      : 'executions.json',
  ),
  JSON.stringify(records, null, 2),
);
