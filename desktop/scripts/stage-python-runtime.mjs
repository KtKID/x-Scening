// 发布资源保留公开模板，Python 路径随应用位置解析。
import { execFileSync } from 'node:child_process';
import { cp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const relocateSysconfig = `
from pathlib import Path
from pprint import pformat
from runpy import run_path
from shutil import rmtree
import sys
import sysconfig

runtime = Path(sys.argv[1]).resolve()
if runtime != Path(sys.base_prefix).resolve():
    raise ValueError('独立 Python 的运行目录不符')
file = Path(sysconfig.__file__).with_name(sysconfig._get_sysconfigdata_name() + '.py')
marker = '@SCENING_PYTHON_PREFIX@'
if marker not in file.read_text(encoding='utf-8'):
    values = run_path(str(file))['build_time_vars']
    prefix = values['prefix']
    if not Path(prefix).is_absolute() or prefix == '/':
        raise ValueError('独立 Python 的构建前缀无效')
    values = {
        name: value.replace(prefix, marker) if isinstance(value, str) else value
        for name, value in values.items()
    }
    file.write_text(
        'from sys import base_prefix as _base_prefix\\n\\n'
        'build_time_vars = ' + pformat(values) + '\\n'
        'build_time_vars = {\\n'
        '    name: value.replace(' + repr(marker) + ', _base_prefix)\\n'
        '    if isinstance(value, str) else value\\n'
        '    for name, value in build_time_vars.items()\\n'
        '}\\n',
        encoding='utf-8',
    )
# 复用缓存时去掉含编译时源路径的 Python 字节码。
for cache in runtime.rglob('__pycache__'):
    rmtree(cache)
`;

/** 将独立 Python 的本机安装路径替换为相对于运行环境的路径。 */
export async function stagePythonRuntime(root, output, pythonVersion, env) {
  const runtime = path.join(output, '.venv');
  const bin = path.join(runtime, 'bin');
  const minorVersion = pythonVersion.split('.').slice(0, 2).join('.');
  const library = path.join(runtime, 'lib', `libpython${minorVersion}.dylib`);
  const installName = `@rpath/${path.basename(library)}`;
  const currentName = execFileSync('/usr/bin/otool', ['-D', library], {
    encoding: 'utf8',
  })
    .split('\n')[1]
    ?.trim();
  if (currentName !== installName)
    execFileSync('/usr/bin/install_name_tool', ['-id', installName, library]);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', library]);

  execFileSync(
    path.join(bin, 'python3'),
    ['-B', '-c', relocateSysconfig, runtime],
    { env },
  );
  // uv 为入口生成本机绝对 shebang，改用同目录中的内置解释器。
  await writeFile(
    path.join(bin, 'mss'),
    '#!/bin/sh\nexec "$(dirname "$0")/python3" -B -m mss "$@"\n',
  );
  for (const name of [
    'observer.publish.yaml',
    'observer_dev.yaml',
    'observer.defaults_dev.yaml',
  ])
    await rm(path.join(output, name), { force: true });
  await cp(
    path.join(root, 'observer.yaml'),
    path.join(output, 'observer.yaml'),
  );
}
