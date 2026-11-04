# Observer / x-Scening MCP 契约

本说明基于项目现有工具。接入时以 `tools/list` 发现的 schema 为准。

## 工具

### list_task_associations

```json
{"startDate":"2026-11-03","endDate":"2026-11-03"}
```

按日期范围读取全部已保存活动与任务关联，日期含首尾。返回：

- 顶层 `startDate`、`endDate`、`days`。
- 每日 `day`、`organized`、`needsOrganization`、`tasks` 目录、`activityCount`、`counts`、`activities`、`issues`。
- 每条活动 `activityId`、`start`、`end`、`app`、`analysis`、`status`、`tasks`。
- `status=linked`：tasks 是 taskId/title/action 列表；`none`：已整理且明确无关联，tasks=null；`unknown`：尚待整理或来源变化，tasks=null。

正文在三种状态下都可用。查询只读取现有产物，任务整理沿用客户端自身流程。

### list_period_summaries

参数同上，返回 `days`、`summaryCount`、`summaries`、`unreadableDays` 等字段。每份总结包含 `windowStart`、`windowEnd`、`generatedAt`、`timeline`、`gaps`、`summary`、`trigger`。跨午夜窗口保存在 windowEnd 所在日。

### generate_daily_review

```json
{"day":"2026-11-03","refresh":false}
```

读取或生成每日回顾，可能调用模型并写入每日回顾和生成状态。定时读取分析数据使用前两个查询工具；每日回顾按用户单独表达的用途调用。

## 传输与连接

现有服务为本机 stdio MCP，启动模块为 `scening.mcp_server`。客户端负责启动子进程和 JSON-RPC 通信；stdout 是协议流。供本机 MCP 配置参考的路径模板：

```text
command: <observer-repo>/.venv/bin/python
args: ["-B", "-m", "scening.mcp_server", "--config", "<observer-config>"]
cwd: <observer-repo>
env.PYTHONPATH: <observer-repo>/src
```

从用户已连接工具、客户端运行配置或已确认的安装位置取得真实路径。显式配置必须是客户端生产端使用的配置，MCP 与生产端读取同一 home。配置在 MCP 启动时加载，home 切换后按该 Harness 的连接重载方式生效。新机器上的路径由本机配置发现，文档占位符用于表达配置项。

远程 Agent 需要其运行环境能够访问的 MCP 连接；本机 stdio 依赖同机进程与文件系统。连接方案按用户现有部署与 Harness 能力选择。

## 结果与失败

现有 JSON-RPC `tools/call` 将业务 JSON 放在 `result.content[].text`，并提供 `isError`；Harness 可能已经解码为对象。只按返回形状解析一次，保留完整结果后检查 issues。

当前工具参数按日期查询，活动列表按日期全量返回。消费差异由 Agent 自己保存 ID 与内容摘要计算。查询为空时依据文件状态和可见时间说明“本轮读取为空”；读取损坏、响应截断和连接失败各自记为问题，成功检查点保持上一轮值。

## 调度配置要点

使用当前 Harness 原生调度工具的真实 schema，频率和值域由该工具确定。将用户确认的轮询间隔传给调度器，保存返回 ID，修改或暂停同一项计划。

Codex 当前对话定时任务可承接持续检查，执行前读取可用调度工具说明；独立项目任务按用户指定的交付位置选择。参考 [OpenAI 定时任务文档](https://learn.chatgpt.com/docs/automations?surface=app) 与 [Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。本地运行条件和首次自动触发结果随实际环境验证。
