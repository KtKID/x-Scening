"""从外部KMH已构建的权威Zod导出结果协议，受控生成Python接收模型。"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'))
from scening.observer_config import load_config


def generate(kmh):
    """只读外部schema，生成受支持的结果字段；未知类型直接报错以阻止静默漂移。"""
    node=shutil.which('node')
    if node is None:
        raise RuntimeError('系统 PATH 中找不到 Node，请检查已有 Node 的安装位置')
    source=kmh/'packages/scene-observer/lib/schema.js'
    script="""import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const uri=pathToFileURL(process.argv[1]);
const {ObservationResultSchema}=await import(uri.href);
const {z}=createRequire(uri)('zod');
console.log(JSON.stringify(z.toJSONSchema(ObservationResultSchema)));
"""
    schema=json.loads(subprocess.check_output([node,'--input-type=module','-e',script,str(source)],text=True))
    if schema.get('additionalProperties') is not False:
        raise ValueError('观察结果协议应显式限定字段')
    def expression(item):
        """把本协议实际使用的JSON类型映射为严格Pydantic字段。"""
        if 'const' in item:
            return 'Literal['+repr(item['const'])+']'
        if item.get('type')=='string':
            return 'Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length='+str(item.get('minLength',0))+')]'
        if item.get('type')=='array':
            return 'List['+expression(item['items'])+']'
        raise ValueError('观察结果存在未支持类型：'+repr(item))
    lines=['# 自动生成：外部 @kmh/scene-observer 的 ObservationResultSchema 为权威源。',
           '# 更新/漂移检查：python scripts/sync_scening_contract.py [--check]。',
           'from typing import Annotated, Literal, List',
           'from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator','',
           'class ObservationResult(BaseModel):',
           '    """接收已提交的观察结果；字符串按工具契约trim，模型字段由Zod生成。"""',
           "    model_config = ConfigDict(extra='forbid', strict=True)"]
    numeric=[]
    for name,item in schema['properties'].items():
        if not name.isidentifier() or name not in schema['required']:
            raise ValueError('观察结果字段应为具名必填项：'+name)
        field='    '+name+': '+expression(item)
        if 'default' in item:
            field+=' = Field(default='+repr(item['default'])+')'
        lines.append(field)
        if type(item.get('const')) in (int,float):
            numeric.append(name)
    if numeric:
        lines+=['','    @field_validator('+','.join(repr(name) for name in numeric)+", mode='before')",
                '    @classmethod','    def numeric_constants(cls, value):',
                '        """保留JS数字常量语义，布尔输入按无效协议处理。"""',
                '        if isinstance(value, bool):',"            raise ValueError('观察结果版本应为数字')",'        return value']
    return '\n'.join(lines)+'\n'


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--kmh-repo',type=Path)
    parser.add_argument('--check',action='store_true')
    args=parser.parse_args()
    content=generate((args.kmh_repo or load_config().kmhLauncher.parent.parent).resolve())
    target=ROOT/'src/scening/observation_generated.py'
    if args.check:
        if not target.exists() or target.read_text()!=content:
            raise SystemExit('scening结果协议存在漂移，请重新生成')
        print('KMH Zod → Python观察结果契约一致')
    else:
        target.write_text(content)
        print('已生成Python观察结果模型')
