import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { localDay, moveDay } from '../src/shared/protocol';

export const root = path.resolve(
  fileURLToPath(new URL('../..', import.meta.url)),
);
export const desktop = path.join(root, 'desktop');
export const evidence = path.join(root, 'reports/desktop-backfill-20261031');
export async function fixture() {
  const folder = await mkdtemp(path.join(root, 'tmp/desktop-backfill-'));
  const home = path.join(folder, 'home');
  const shots = path.join(folder, 'screenshots');
  const day = moveDay(localDay(), -1);
  await mkdir(home);
  await mkdir(shots);
  await promisify(execFile)(path.join(root, '.venv/bin/python'), [
    '-B',
    '-c',
    `import sys
from pathlib import Path
from PIL import Image
for i in range(5):
    with Image.new('RGB',(80,50),(i*30,20,100)) as image:
        image.save(Path(sys.argv[1])/f'{sys.argv[2]}_09-00-{i*10:02d}_m1_action.jpg')`,
    shots,
    day,
  ]);
  const launcher = path.join(folder, 'model.cjs');
  await writeFile(path.join(folder, 'mode.txt'), 'success');
  await writeFile(
    launcher,
    `const fs=require('node:fs');
const path=require('node:path');
const yaml=require(${JSON.stringify(path.join(desktop, 'node_modules/yaml'))});
const folder=__dirname;
fs.appendFileSync(path.join(folder,'calls.txt'),'call\\n');
const mode=fs.readFileSync(path.join(folder,'mode.txt'),'utf8');
if(mode==='fail')process.exit(2);
const file=process.argv[process.argv.indexOf('--patch')+1];
const config=yaml.parse(fs.readFileSync(file,'utf8'))[0].config;
setTimeout(()=>{fs.writeFileSync(config.resultFile,JSON.stringify({schema_version:1,visible_activity:'核对补分析结果',inferred_intent:'推测在验证桌面入口',stage_and_evidence:'可见文字变化',app_tags:['unknow'],task_types:[]}));},mode==='slow'?15000:500);`,
  );
  const config = parseDocument(
    await readFile(path.join(root, 'observer.yaml'), 'utf8'),
  );
  config.set('home', home);
  config.set('screenshotDir', shots);
  config.set('kmhLauncher', launcher);
  config.setIn(['desktop', 'refreshIntervalSeconds'], 0.25);
  const configPath = path.join(folder, 'observer.yaml');
  await writeFile(configPath, config.toString());
  return { folder, home, shots, day, configPath };
}
export async function callCount(folder: string): Promise<number> {
  try {
    return (await readFile(path.join(folder, 'calls.txt'), 'utf8'))
      .trim()
      .split('\n').length;
  } catch {
    return 0;
  }
}
export async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('等待补分析结果超时');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
