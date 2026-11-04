# x-scening MCP 完整接口

源码依据：`src/scening/mcp_server.py`、`activity_memory.py`、`task_store.py`、`daily_review.py`、`daily_review_report.py`、`daily_review_state.py`。核对日期：2026-11-04。运行时通过 `tools/list` 核对新增或变化的接口。

## 目录

- [业务工具与内容位置](#业务工具与内容位置)
- [list_task_associations](#list_task_associations)
- [list_period_summaries](#list_period_summaries)
- [generate_daily_review](#generate_daily_review)
- [协议与解析](#协议与解析)
- [错误与读取边界](#错误与读取边界)

## 业务工具与内容位置

| 用户目标 | 工具 | 正文字段 |
| --- | --- | --- |
| 获取逐条屏幕活动分析 | `list_task_associations` | `days[].activities[].analysis` |
| 获取某日任务目录与活动归属 | `list_task_associations` | `days[].tasks`、`days[].activities[].tasks` |
| 获取周期总结原文 | `list_period_summaries` | `summaries[].summary` |
| 获取周期总结的活动文字时间表 | `list_period_summaries` | `summaries[].timeline[].analysis` |
| 获取每日回顾原文 | `generate_daily_review` | `review.response`，`status=ready` |
| 重新生成每日回顾 | `generate_daily_review`，`refresh=true` | 新报告的 `review.response` |

## list_task_associations

按日期读取全部已保存有效活动及已有任务关联。只读 `home/records/YYYY-MM-DD.json` 和 `home/task-timeline/YYYY-MM-DD.json`，模型调用与任务整理由原生产流程负责。

| 参数 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `startDate` | string | 是 | 起始归档日期，含当日，`YYYY-MM-DD` |
| `endDate` | string | 是 | 结束归档日期，含当日，`YYYY-MM-DD` |

顶层返回：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `startDate`、`endDate` | string | 查询边界 |
| `days` | array | 有活动日文件的逐日查询结果，日期升序 |

`days[]`：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `day` | string | 归档日期 |
| `organized` | boolean | 该日存在并成功读取已有任务文件；逐条有效性继续看 `status` |
| `needsOrganization` | boolean | 有效活动中包含 `unknown` |
| `tasks` | array | 任务目录，每项为 `taskId`、`title`、`object`、`goal` |
| `activityCount` | integer | 返回的有效活动条数 |
| `counts` | object | `linked`、`none`、`unknown` 的活动计数 |
| `activities` | array | 有效活动，按带时区的开始时刻升序 |
| `issues` | array of string | 活动坏行、文件读取或校验问题 |

`activities[]`：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `activityId` | string | 来源日期、原行号、start 派生的身份；消费时同时保存来源与日期 |
| `start`、`end` | string | 带时区的活动起止时间，可能为同一观察时点 |
| `app` | string | 采集应用身份，多应用以 `、` 拼接 |
| `analysis` | string | 已保存的完整活动分析正文 |
| `status` | string | `linked`、`none` 或 `unknown` |
| `tasks` | array or null | `linked` 时每项含 `taskId`、`title`、`action`；其余状态为 `null` |

三态判断：已保存关联的来源签名与当前活动一致且关联列表有值时为 `linked`；签名一致且列表为空时为 `none`；关联待整理或来源签名已变化时为 `unknown`。活动的 `end` 延长可保持原有关联。三种状态的 `analysis` 均可读取。

示意返回（合成数据）：

```json
{
  "startDate": "2026-11-03",
  "endDate": "2026-11-03",
  "days": [{
    "day": "2026-11-03", "organized": false, "needsOrganization": true,
    "tasks": [], "activityCount": 1,
    "counts": {"linked": 0, "none": 0, "unknown": 1},
    "activities": [{
      "activityId": "example-activity",
      "start": "2026-11-03T09:00:00+08:00",
      "end": "2026-11-03T09:05:00+08:00",
      "app": "Code", "analysis": "正在核对 MCP 工具的输入参数。",
      "status": "unknown", "tasks": null
    }],
    "issues": []
  }]
}
```

缺少活动日文件的日期跳过；已有空列表日文件返回零条活动。活动坏行记入 `issues`，其余有效活动继续返回。任务文件损坏时该日 `organized=false`，活动关联按 `unknown` 返回并附诊断。活动文件整体损坏时该日可能返回零条与 `issues`，结合两者解释覆盖范围。

## list_period_summaries

只读 `home/summaries/YYYY-MM-DD.json`，读取范围内全部周期总结并按 `windowStart` 的实际时刻升序返回。

| 参数 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `startDate` | string | 是 | 起始归档日期，含当日 |
| `endDate` | string | 是 | 结束归档日期，含当日 |

顶层返回：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `startDate`、`endDate` | string | 查询边界 |
| `days` | array of string | 文件成功读取并校验通过的日期，空列表日文件也计入 |
| `summaryCount` | integer | `summaries` 的条数 |
| `summaries` | array | 所有有效日文件中的周期总结 |
| `unreadableDays` | array | 每项含 `day`、`reason`，表示该日文件读取或校验失败 |

`summaries[]`：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `windowStart`、`windowEnd` | string | 带时区的覆盖窗口起止 |
| `generatedAt` | string | 带时区的总结生成时间 |
| `summary` | string | 完整周期总结原文 |
| `trigger` | string | `periodic` 或 `manual_exit` |
| `timeline` | array | 每项含 `start`、`end`、`app`（可为 null）、`analysis` 的文字时间表 |
| `gaps` | array | 每项含 `start`、`end`、`reason` 的已知观察缺口 |
| 扩展字段 | 按原存储 | 模型校验允许保留已有扩展字段 |

示意返回（合成数据）：

```json
{
  "startDate": "2026-11-03", "endDate": "2026-11-03",
  "days": ["2026-11-03"], "summaryCount": 1,
  "summaries": [{
    "windowStart": "2026-11-03T09:00:00+08:00",
    "windowEnd": "2026-11-03T09:30:00+08:00",
    "generatedAt": "2026-11-03T09:31:00+08:00",
    "summary": "本时段在核对 MCP 参数并整理说明，运行结果待确认。",
    "trigger": "periodic",
    "timeline": [{
      "start": "2026-11-03T09:00:00+08:00",
      "end": "2026-11-03T09:05:00+08:00",
      "app": "Code", "analysis": "正在核对 MCP 工具的输入参数。"
    }],
    "gaps": []
  }],
  "unreadableDays": []
}
```

归档日期以 `windowEnd` 的日期为准。读取 11 月 3 日 23:30 至 11 月 4 日 00:00 的窗口，应包含 11 月 4 日。缺文件日跳过；坏文件或窗口结束日期与文件名错配时整日进入 `unreadableDays`；其他日期继续返回。`timeline` 是该总结保存的活动文字快照，逐日全部活动通过 `list_task_associations` 获取。

## generate_daily_review

读取缓存或生成某日每日回顾，复用 `daily_review.review_day` 和逐日状态核心。

| 参数 | 类型 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `day` | string | 是 | — | 真实日历日期，`YYYY-MM-DD` |
| `refresh` | boolean | 否 | `false` | `true` 时进入重新生成流程；JSON 使用真正的布尔值 |

返回为三种协议之一：

```json
{"status":"ready","review":{"day":"2026-11-03","generatedAt":"2026-11-04T03:01:00+08:00","sourceCount":2,"sourceActivityCount":6,"generationId":"example-generation","sourceHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","response":"11月3日，你围绕 MCP 调用整理了接口资料。运行结果继续保持待确认。"}}
```

```json
{"status":"empty","message":"当日无记录。已保存分析可用后，可点击生成总结。"}
```

```json
{"status":"error","message":"每日总结生成失败：具体原因"}
```

`review` 的全部字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `day` | string | 报告所属日期 |
| `generatedAt` | string | 带时区的生成时间 |
| `sourceCount` | integer | 参与生成的周期总结数量 |
| `sourceActivityCount` | integer or null | 参与生成的活动数量，兼容旧报告 |
| `generationId` | string or null | 生成身份，兼容旧报告 |
| `sourceHash` | string | 输入快照的 SHA-256 摘要 |
| `response` | string | 完整模型回复正文 |

`refresh=false` 命中有效缓存时原样返回保存的回顾；缓存缺失时进入模型生成并保存 `home/daily-reviews/YYYY-MM-DD.json` 与对应逐日状态。缓存以已保存报告为准，新增活动后的重新生成由显式刷新承接。有效缓存读取失败时返回错误。

生成可同时使用该日全部已保存活动和周期总结，只有部分活动分析的日期也能生成。模型凭据与启动器沿用项目已有 KMH 配置。`refresh=true` 沿用既有并发锁与状态规则；执行结果以实际回复为准。`ready`、`empty` 对应 `isError=false`，`error` 对应 `isError=true`；缺必填参数时业务体可能为 `{"error":"缺少必填参数：day"}`。

生成收尾顺序为“先提交报告，再保存成功状态”。状态保存失败时，错误回包与已更新报告可能同时存在；恢复后用 `refresh=false` 核实缓存中的正文、`generatedAt` 和 `generationId`，再决定后续操作。

## 协议与解析

逐行 UTF-8 JSON-RPC 2.0：每个请求对象编码成一行并立即刷新，每条响应独占一行。stdout 专用于协议，客户端读取 stderr 诊断。

| 方法 | 请求参数 | 响应与行为 |
| --- | --- | --- |
| `initialize` | `protocolVersion`；按客户端约定附 `capabilities`、`clientInfo` | 返回 `protocolVersion`、`capabilities.tools.listChanged=false`、`serverInfo.name=x-scening`、`serverInfo.version=0.1.0` |
| `notifications/initialized` | 通知形式，省略 id | 服务忽略通知，继续接收请求 |
| `ping` | 空对象或省略 | 返回 `{}` |
| `tools/list` | 空对象或省略 | 返回 `tools`，含三个工具的名称、描述、`inputSchema` |
| `tools/call` | `name` 字符串、`arguments` 对象 | 返回 `content` 与 `isError` |

支持协议版本：`2024-11-05`、`2025-03-26`、`2025-06-18`；请求其他版本时回退 `2024-11-05`。支持的能力集合为 `tools`，`resources/list`、`resources/read`、`prompts/list` 等方法会进入未知方法错误分支。

手动交互顺序示例，每行作为一次写入：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"example-agent","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"ping"}
{"jsonrpc":"2.0","id":3,"method":"tools/list"}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_task_associations","arguments":{"startDate":"2026-11-03","endDate":"2026-11-03"}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_period_summaries","arguments":{"startDate":"2026-11-03","endDate":"2026-11-03"}}}
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"generate_daily_review","arguments":{"day":"2026-11-03","refresh":false}}}
```

标准工具响应示例：

```json
{"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"{\"startDate\":\"2026-11-03\",\"endDate\":\"2026-11-03\",\"days\":[],\"summaryCount\":0,\"summaries\":[],\"unreadableDays\":[]}"}],"isError":false}}
```

Python 解析示例，`rpc_reply` 为客户端已经读入的 JSON 响应：

```python
import json

if "error" in rpc_reply:
    raise RuntimeError(rpc_reply["error"])
result = rpc_reply["result"]
payloads = [json.loads(block["text"]) for block in result["content"]
            if block["type"] == "text"]
if result.get("isError", False):
    raise RuntimeError(payloads)
payload = payloads[0]  # 当前服务每个工具返回一个 JSON 文本块
```

宿主直接返回 MCP `result` 或已解码业务对象时，按实际层级取值。客户端接收通知时保持读取后续响应；请求 id 用于匹配响应。

## 错误与读取边界

| 层级 | 标识 | 处理 |
| --- | --- | --- |
| JSON-RPC | `-32700` | 修正 JSON 编码 |
| JSON-RPC | `-32600` | 修正请求对象、`jsonrpc`、`method` |
| JSON-RPC | `-32601` | 使用上表列出的协议方法 |
| JSON-RPC | `-32602` | 修正 params/arguments 对象形状或工具名 |
| 工具 | `isError=true`，正文 `error` 或 `status=error/message` | 展示实际原因，修正日期、必填参数或本地生成环境 |
| 部分读取 | `days[].issues`、`unreadableDays` | 保留可读部分，标明失败日期与问题 |

两个日期范围接口均要求合法日期且首日早于或等于末日，末日包含在内。范围查询全量读取对应日文件，当前参数集合为 `startDate/endDate`；按具体时段、应用、任务筛选和增量比较由消费端执行。单日结果截断时应使用宿主完整结果读取能力，处理完整后再推进消费检查点。

返回空列表表达本次读取结果；文件缺失、生产尚未保存、配置指向其他 home、文件损坏和活动尚未发生需要结合实际诊断区分。已知缺口以 `gaps` 表达，任务整理覆盖以三态及 `issues` 表达，采集实时状态须来自实际状态接口。
