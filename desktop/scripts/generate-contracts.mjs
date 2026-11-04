// 从 scening 的 Pydantic 输出生成 Zod；生成文件保持单向同步。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const python =
  process.env.OBSERVER_PYTHON ??
  path.join(
    root,
    process.platform === 'win32'
      ? '.venv/Scripts/python.exe'
      : '.venv/bin/python',
  );
const result = spawnSync(
  python,
  [
    '-B',
    '-c',
    `import json
from scening.activity_memory import ActivityEvent, ActivitySummary
from scening.observer_config import ObserverConfig
from scening.runtime_control import ControlRequest, ControlReply
from scening.daily_review import DailyReview, DailyReviewReply
from scening.daily_review_state import DailyReviewState,DailyReviewView,DailyReviewCandidates,DailyReviewPresented
from scening.task_models import DayTasks,TaskProposal,MultiTaskProposal,DayTaskView,TimeEvidence,TimelineReadReply
from scening.screenshot_backfill_status import BackfillStatus
print(json.dumps({c.__name__:c.model_json_schema() for c in (DailyReviewState,DailyReviewView,DailyReviewCandidates,DailyReviewPresented,ActivityEvent,ActivitySummary,ObserverConfig,ControlRequest,ControlReply,DailyReview,DailyReviewReply,DayTasks,TaskProposal,MultiTaskProposal,DayTaskView,TimeEvidence,TimelineReadReply,BackfillStatus)}))`,
  ],
  {
    cwd: root,
    env: { ...process.env, PYTHONPATH: path.join(root, 'src') },
    encoding: 'utf8',
  },
);
if (result.status !== 0)
  throw new Error(result.stderr || 'Pydantic schema 导出失败');
const models = JSON.parse(result.stdout);
const definitions = new Map();
for (const [name, schema] of Object.entries(models)) {
  for (const [key, value] of Object.entries(schema.$defs ?? {}))
    definitions.set(key, value);
  definitions.set(name, schema);
}
const emitted = new Set();
const lines = [
  '// 自动生成：权威源 src/scening 的 Pydantic 模型（activity_memory、observer_config、runtime_control、daily_review、task_models、screenshot_backfill_status）。',
  '// 修改模型后运行 ./scripts/run.sh run contracts；contracts:check 检查漂移。',
  "import { z } from 'zod';",
  '',
];
function emit(name) {
  if (emitted.has(name)) return;
  const definition = definitions.get(name);
  if (!definition) throw new Error(`缺少模型 ${name}`);
  const expression = convert(definition);
  lines.push(`export const ${name}Schema = ${expression};`, '');
  emitted.add(name);
}
function convert(schema) {
  if (schema.$ref) {
    const name = schema.$ref.split('/').at(-1);
    emit(name);
    return `${name}Schema`;
  }
  if (schema.const !== undefined)
    return `z.literal(${JSON.stringify(schema.const)})`;
  if (schema.enum) return `z.enum(${JSON.stringify(schema.enum)})`;
  if (schema.anyOf) return `z.union([${schema.anyOf.map(convert).join(', ')}])`;
  if (schema.type === 'null') return 'z.null()';
  if (schema.type === 'boolean') return 'z.boolean()';
  if (schema.type === 'array') {
    let value = `z.array(${convert(schema.items)})`;
    if (schema.minItems !== undefined) value += `.min(${schema.minItems})`;
    if (schema.maxItems !== undefined) value += `.max(${schema.maxItems})`;
    if (schema.uniqueItems)
      value +=
        ".refine((items) => new Set(items).size === items.length, '列表项应唯一')";
    return value;
  }
  if (schema.type === 'object') {
    if (!schema.properties && typeof schema.additionalProperties === 'object') {
      return `z.record(z.string(), ${convert(schema.additionalProperties)})`;
    }
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties ?? {}).map(
      ([key, field]) => {
        let value = convert(field);
        if (!required.has(key)) value += '.optional()';
        if (field.default !== undefined)
          value += `.default(${JSON.stringify(field.default)})`;
        return `${JSON.stringify(key)}: ${value}`;
      },
    );
    const object =
      schema.additionalProperties === false ? 'strictObject' : 'looseObject';
    return `z.${object}({\n${fields.join(',\n')}\n})`;
  }
  if (schema.type === 'string') {
    let value =
      schema.format === 'date-time'
        ? 'z.iso.datetime({ offset: true })'
        : 'z.string()';
    if (schema.minLength !== undefined) value += `.min(${schema.minLength})`;
    if (schema.maxLength !== undefined) value += `.max(${schema.maxLength})`;
    if (schema.pattern) {
      // Pydantic 的严格末尾锚点同步到 JS，避免末尾换行被接受。
      const pattern = schema.pattern.endsWith('$')
        ? `${schema.pattern}(?![\\s\\S])`
        : schema.pattern;
      value += `.regex(new RegExp(${JSON.stringify(pattern)}))`;
    }
    return value;
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    let value = schema.type === 'integer' ? 'z.number().int()' : 'z.number()';
    for (const [key, method] of Object.entries({
      minimum: 'min',
      maximum: 'max',
      exclusiveMinimum: 'gt',
      exclusiveMaximum: 'lt',
    })) {
      if (schema[key] !== undefined) value += `.${method}(${schema[key]})`;
    }
    return value;
  }
  throw new Error(`未支持的 Python schema：${JSON.stringify(schema)}`);
}
for (const name of Object.keys(models)) emit(name);
const { format } = await import('prettier');
const output = await format(lines.join('\n'), {
  parser: 'typescript',
  singleQuote: true,
});
const target = new URL('../src/shared/scening.generated.ts', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output)
    throw new Error('scening 契约已变化，请运行 contracts');
  console.log('Pydantic → Zod 契约一致');
} else {
  writeFileSync(target, output);
  console.log('已从 scening 生成 Zod 契约');
}
