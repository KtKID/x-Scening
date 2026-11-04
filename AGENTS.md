# AGENTS.md

x-scening — macOS 原生的被动式屏幕感知系统，通过低成本视觉观察，把电脑上的可见操作持续转为结构化活动记忆，为个人主动式 Agent 提供上下文基础。

项目文档入口：[项目总览与模块索引](docs/README.md)。截图、OCR、拼图流程、实施验证及测试样本集中从[专题索引](docs/README.md#screenshot-ocr-docs)进入。按总览进入模块自身README，再查源码与Spec；截图节奏、完整数据路径和带统计时间的空间快照见[scening模块说明](src/scening/README.md)。

## 项目目标

当前目标为基本可跑的 P0：多屏缓存 → 事件与定时选图 → 原分辨率 JPEG → 凑齐三帧后的拼图 KMH 与每日 JSON / 同日无变化只更新末条 end → 默认每 30 分钟总结 → 文件与 logs 日志。应用 Python 代码统一位于 `src/scening/`，通过 `./run.sh` 启动。遵循剃刀法则，先连续运行 30 分钟看效果，后续依据真实问题选择优化。

桌面客户端位于 `desktop/`，采用 Electron + React + TypeScript，黄纸底三栏布局；默认读取 scening 已保存的本地记录，右侧默认当日概览，点击卡片显示详情。设置可手动切换为文字以【测试数据】开头的测试预览，通过 `./desktop/run.sh` 启动；macOS客户端可启停现有采集并展示状态，通过“开启分析”开关选择完整分析或仅截图；切换在同一Python进程内生效，关闭时取消当前模型任务并保留已提交文件，本地记录自动更新并保留手动刷新。需求、局部设计和验证见 [客户端 task](docs/spec/screen-observer-p0/tasks/task-desktop-client.md)、[采集控制task](docs/spec/screen-observer-p0/tasks/task-desktop-capture.md)与[分析开关task](docs/spec/screen-observer-p0/tasks/task-desktop-analysis.md)。

产品背景、架构方向和完整路线图见 [项目规划](docs/project-plan.md)；P0 的功能场景与关键约束见 [屏幕感知 Spec](docs/spec/screen-observer-p0/spec.md)，v1.0 已整体确认，v1.1 离线处理、v1.2 定时截图与 v1.3 主动申请权限按用户 qdev 授权推进。实现方案、配置、文件字段和验证安排见 [技术设计](docs/spec/screen-observer-p0/tech-design.md)，v0.8 的其他主线方案待用户确认；Python最小活动链路已实现并短试跑，暂停/排除与真实30分钟效果按后续任务推进。本文负责开发协作规则、职责边界、当前范围与文档导航。

## 设计

当前实时采集采用 Python / MSS 多屏缓存、pynput 键鼠事件、画面差异选图和 Pillow 原分辨率 JPEG；系统空闲和休眠状态由 Quartz 提供。当前采集统一使用原分辨率 JPEG；旧单帧和离线缩图入口已按用户要求移除，历史图片与记录保留。来源、模块和用法见 [scening 实现](src/scening/README.md)。

| 决策 | 作用 |
| --- | --- |
| Python / MSS / pynput | 缓存各屏最新帧，根据键鼠坐标与近期活动选屏；应用按系统窗口层级、目标屏矩形与窗口PID读取，异常或切换竞态记未知。 |
| Python / Pillow | 实时选图用 RGB 平方差，正式候选保持原分辨率 JPEG；后续活动入口沿用平均 RGB 差去重，正式候选保持原采集像素。 |
| KMH scening | 图片交由 KMH 专用 profile，通过read_image与submit_observation提交结构化结果，默认 minimax-cn / MiniMax-M3 / high；中国区API Key在home/kmh/.env配置。 |
| 隐私闸门 | 候选发布与补分析提交前复用同一本地判定（L0应用黑名单 + Vision OCR fast 规则）。实时事件与定时图暂存内存JPEG，选中后以内存OCR检查，通过再保存，敏感帧释放内存；自动积压与手动补分析确认敏感后删除原图和采集信息、重建索引，OCR失败保留待重试；规则与验证见[敏感判定规则](docs/design/screenshot-sensitive-rules-20261101.md)。 |
| Scheduler / LLM | 每 30 分钟生成总结，运行异常和空状态写日志。 |
| JSON / Pydantic | 当前活动与总结结构在src/scening/activity_memory.py定义；每日一份分析记录，新分析追加到列表，同日无变化只更新最后一条记录的 `end`；总结也使用 JSON 保存。 |
| 数据目录配置 | dev默认home为./home、screenshotDir为./data/snapshot-v1；GitHub Release/tag构建采用publish，默认home为~/.scening、截图位于其snapshots子目录，首次创建用户配置后保留后续修改。实时事件图独占内存并按动作上限释放。 |
| 运行方式 | 首版手动启动；x-infra、自启动和统一监控列入后续。 |

### 模块职责

- **Observer**：独立线程采集多屏缓存与输入首尾，按差异与定时观察选出正式 JPEG，输出采集时间、屏幕和应用元信息。
- **Interpreter**：通过 VLM 将画面转换成结构化活动信息。
- **Memory**：通过按天 JSON 追加分析记录、更新末条 `end` 并保存总结，为未来的任务空间和其他 Agent 提供上下文。

三个职责由运行调度器衔接，解释结果与截图元信息合成为统一的 `ActivityEvent`。后续来源接入沿用该契约，保持观察、理解、记录各自的职责。字段与数据归属见 [每日记录设计](docs/spec/screen-observer-p0/tech-design.md#records)。

配置入口为项目根目录 [observer.yaml](observer.yaml)，每个字段旁的原生 `#` 注释提供中文用途、单位和值域说明，字段及值域见 [配置设计](docs/spec/screen-observer-p0/tech-design.md#一份配置明确生效时机d02)。`--config`选择完整配置，显式CLI参数临时覆盖，修改后重启生效；数值默认值统一在YAML维护，源码通过Pydantic校验快照读取。

应用代码统一位于 `src/scening/`；感知源码参考副本和来源清单归档在 `docs/task/archived-sensing/`，唤醒脚本归档在 `docs/task/archived-wake-word/`。测试位于 tests，验证产物位于 reports。

### 开发约束

1. 首版以基本闭环正确运行为准，局部识别、专项合并、相似度调优和复杂恢复策略列入后续。范围依据用户最新的剃刀法则要求。
2. 默认每三张同日实时新图生成拼图分析；开启分析先补当天最早未分析积压，积压尾批支持1～2张，随后接新图。实时与手动补分析按同一日锁选最早待分析，模型与提交串行，采集持续保存JPEG及同名metadata.json。实时满批每帧均与同一已知应用的成功基准相同时只更新末条end，其他字段保持；当前段避免重复消费，下一开启段仍以报告frames核对。比较基准在分析和保存成功后更新；其他入口追加时清除旧基准。用户2026-10-31明确qdev授权与验证见[当天队列task](docs/spec/screenshot-analysis-backfill/tasks/task-today-analysis-queue.md)。
3. 活动记录与总结分别表达可见事实、推测和需要进一步确认的状态；工作目标与代码完成状态以证据为依据。截图时间与应用在采集时确定，暂停、故障和重启中断的活动区间按实际覆盖记录。
4. 实时采集在系统空闲或休眠时暂停，屏幕布局变化重建基准；正式 JPEG 完整保存后才交给分析。任一图片保存失败停止该次后续流程并记录，正式历史图片保留；待分析原图经现有闸门确认敏感时，按用户2026-11-04授权删除原图及采集信息并重建索引，OCR失败保留重试。应用排除等既有待实现范围按对应任务推进。
5. dev模式home默认./home，publish默认~/.scening；screenshotDir独立配置，dev默认项目./data/snapshot-v1，publish默认~/.scening/snapshots，新正式JPEG保存到采集日期子目录，按秒级采集时间、屏幕和用途命名并排他保护重名；旧平铺图片保持原位。日期目录index.json以成功报告frames为已分析唯一依据，可从报告与原图重建。PreparedImage.original/mini 同指正式 JPEG；截图目录显式配置，旧 home/screenshot 回退已移除。实时事件JPEG在内存中维护，在整理和退出时释放引用，通过隐私检查后提交正式图片；兼容工具临时图沿独占目录清理。依据为2026-11-04内存OCR授权、2026-10-27多屏采集接入授权、2026-10-30按日索引授权及Spec C8/C9。
6. 开发范围按阶段推进；任务管理、浏览器 Tab 接入、Codex 会话读取、拾绪收藏管理和 Agent 主动执行能力由后续阶段承接。
7. 实现与验证依据真实需求和适用开发规范推进；新增参数、契约与范围决策同步维护对应文档。
8. 验证结论标明证据类型，分别记录规划、静态检查、测试和真实运行结果。
9. P0 行为与关键约束以 Spec 为依据，引用稳定的 feat、场景和 C 编号；D、P 编号条目经用户确认后定稿。需求确认后进入同目录技术设计，技术设计确认后再拆开发任务。
10. 每日分析记录使用 JSON 列表，新分析 append，无变化只改末条 end；跨日重新分析并写入新一天文件。新记录 screenshot/mini 同指派生拼图，frames保留三张原始JPEG及采集元信息，旧记录继续可读。文件写入失败或无法读取时保留原文件并写 logs。字段与提交机制见 [每日记录设计](docs/spec/screen-observer-p0/tech-design.md#records)。

11. 活动入口采用多屏缓存与交互选屏；状态、异常、空状态写项目 logs。终端与 zellij 即时打印秒级时间、正式候选路径、屏幕、分析/合并/总结进度。候选队列有界；睡眠、采集故障、布局变化和过载的中断代次随候选传递，防止跨缺口延长活动。桌面壳按feat11只读展示数据并控制现有采集，停止先通知生产线程结束并取消在途模型任务，当前短文件提交收尾；Python继续独占正式记录写入。
12. 图片分析使用外部 KMH 的 `profiles/scening`，默认 minimax-cn / MiniMax-M3 / high，通过中国区API Key调用；headless每次独立调用，解释器自动提供本轮输入与独占结果位置。任务携带已保存三帧拼图及逐帧时间、应用、屏幕、间隔；KMH的read_image读取图片，submit_observation提交结构化结果，read读取总结JSON。半小时总结按窗口内每次分析的start/end/app/analysis生成文字时间表，通过read汇总；新总结仅保存这四项时间表，图片证据归原活动记录与截图目录。工具结果保存在活动observation，兼容三段正文保存在analysis；外部Zod为结果协议权威，受控生成Python及桌面契约。配置、凭据与真实验证见 [KMH 配置说明](src/scening/README.md#kmh-configuration)和[专用profile接入task](docs/spec/screen-observer-p0/tasks/task-scening-profile.md)。
13. 技术设计必须用时序图展示主要流程，明确模块调用顺序、关键分支和文件保存顺序；图文同步维护。
14. Python 脚本采用中文注释；关键函数详细说明用途、参数、返回值、异常、保存顺序及副作用。验证数据使用项目 tmp 下的独占 home；供用户查看的验证截图保留在 tmp，自动测试的合成数据在结束后清理，正式 home 保存用户要求的运行产物。
15. 所有可调数值统一维护于 observer.yaml，包括 scening 与 analysis 策略块；默认值只在 YAML 提供，Pydantic 校验启动快照。采集频率与下游 sampleIntervalSeconds 分别配置，算法/文件格式常量按语义保留。
16. 文档、示例与对外分享的日志片段使用项目相对路径，外部位置使用 `<kmh-repo>`、`<observer-home>`、`<user-home>` 等占位符；账号、密钥与授权链接使用脱敏值。运行时文件定位和本地凭据由原有配置管理。

## 开发路线

| 阶段 | 目标 |
| --- | --- |
| P0 | 屏幕感知：截图、去重、理解、活动记录、半小时总结。 |
| P1 | 浏览器增强：当前及后台 Tab 的 URL、标题与页面内容。 |
| P2 | 任务理解：关联屏幕活动、网页与已有任务空间。 |
| P3 | 自动整理：保存资料、匹配空间、创建候选空间。 |
| P4 | 开发上下文：接入 Codex 会话、项目事件与任务状态。 |
| P5 | 主动协助：发现问题、准备资料、提出建议、恢复工作现场。 |

完整路线图与最终产品形态见 [Roadmap](docs/project-plan.md#5-roadmap)。

## 版本目标

| 当前版本 | 范围 | 验收标准 |
| --- | --- | --- |
| MVP / P0 | 多屏采集、交互选屏、差异选图、JPEG → 原 KMH / JSON / 总结；旧单帧与离线缩图已移除，历史文件保留。 | 正式候选保留；活动按日追加，无变化仅改 end；跨日重新分析；中断与队列丢弃可查日志。30分钟真实连续效果单列验证。 |

验收对照真实屏幕活动、已保存记录、总结、logs 日志和隐私控制效果。先验证闭环与可信性，再根据效果决定优化，详见 [成功标准](docs/project-plan.md#22-第一版成功标准) 和 [当前开发重点](docs/project-plan.md#7-当前开发重点与待校准项)。

## 协作与表达

- 桌面版本按三段整数递增：**每次打包发布前必须更新版本号**，普通打包及普通Git提交末段加1；Release准备中段加1且末段归零。重复打包同样升版；同一批修改在打包前已升版时，随后提交沿用本批版本。通过`npm version patch/minor --no-git-tag-version`同时更新`desktop/package.json`与锁文件；打包完成后核对源版本、包内版本和成功标记一致，更新提示分别显示当前版本与新版本。提交与发布按用户授权执行。
- 本机客户端通过统一build入口完成编译、打包并发布至固定应用位置后，运行中的客户端每60秒检查应用与成功标记，提供“重启并更新”以安全收尾并自动切换；macOS Apple Silicon固定入口为desktop/release/mac-arm64/x-scening.app，更新时保持入口身份；实现与验证见[本机构建检测task](docs/spec/screen-observer-p0/tasks/task-local-client-build.md)和[一键更新task](docs/spec/screen-observer-p0/tasks/task-local-client-restart.md)。

- 回答先给结论，直接、具体，深度与问题复杂度相称。
- 优先使用直接肯定句；真实区别采用平行的正向陈述。
- 是非问题先给判断，再用一句话解释；比较问题给出明确建议。
- 概念解释通常控制在 3～5 句；列表用于并列或顺序内容，优缺点每侧最多 3～4 条。
- 代码交付给出代码，复杂用法附示例；交付说明写明改动、验证及实际限制。
- 使用简洁自然的表达，以具体建议或可核验结果结束。

## 文档维护

- [截图敏感判定规则](docs/design/screenshot-sensitive-rules-20261101.md)：2026-11-04 v1.4实时图改为内存JPEG检查后保存，B7实时写盘窗口修复；真实Vision、强杀退出及benchmark见[内存OCR任务](docs/spec/screen-observer-p0/tasks/task-memory-ocr.md)。v1.3积压清理及OCR失败重试沿用[积压报告](reports/fix/privacy-backlog-20261104/test-report.md)。B8实时连续性、B9累计披露政策与B10独立验收集开放，L1标题关键词继续由后续承接。
- [截图分析索引 Spec](docs/spec/screenshot-analysis-status/spec.md)：2026-10-30 用户明确授权按 x-qdev 实施 v1.0；每日分析报告的 frames 是已分析唯一真源，按日 index.json 可重建、按采集时间升序，原图保持原名。2026-10-31用户选择并授权补齐2026-10-30待分析截图，历史执行见[补跑task](docs/spec/screenshot-analysis-backfill/tasks/task-historical-backfill.md)；新增独立日期、单按钮与完成判定的[桌面补分析task](docs/spec/screenshot-analysis-backfill/tasks/task-desktop-backfill.md)。当天允许补分析，开启分析先补当天积压再处理新图，实时与手动共用日锁，见[当天队列task](docs/spec/screenshot-analysis-backfill/tasks/task-today-analysis-queue.md)。
- [任务时间线 MVP Spec](docs/spec/task-linked-timeline-mvp/spec.md)：v1.0 已确认，5 个功能承接同日任务关联、时间线优化、任务进展、点击定位与详情全天时间条；[技术设计](docs/spec/task-linked-timeline-mvp/tech-design.md) v1.0 已确认，MVP链路已接通。 2026-11-01用户已确认D1～D5多任务扩展并授权验证后更新；一条记录保留多个任务分支、各自进展与证据、保守互斥计时和v1备份兼容，见[多任务方案](docs/design/task-progress-ownership-fix-20261101.md)与[实施任务](docs/spec/task-linked-timeline-mvp/tasks/task-multi-task/dev-checklist.md)。 用户后续明确展示为普通卡多任务标签、单任务相邻活动嵌套，见[分组修正task](docs/spec/task-linked-timeline-mvp/tasks/task-activity-card-grouping.md)。
- [系统应用身份 task](docs/spec/screen-observer-p0/tasks/task-system-app-identity.md)：Python统一提供逐帧应用，卡片/详情/筛选/统计/周期总结采用采集身份；模型app_tags保留原始结果与工具参数；真实应用切换和双屏验证。
- [Electron 桌面客户端](desktop/README.md)：黄纸底时间线、测试数据、当日概览/详情、只读 scening 接入、项目内环境及构建方式。
- [完整设置 task](docs/spec/screen-observer-p0/tasks/task-settings.md)：设置页编辑全部运行配置，优先展示分析与截图频率，统一保存和清除修改，采集参数在下次开始采集时读取。

- [scening Python 实现](src/scening/README.md)：当前多屏采集到 JPEG 候选、兼容字段、配置和运行方式。
- [每日温馨回顾 task](docs/spec/screen-observer-p0/tasks/task-daily-review.md)：当日概览“总结”按钮每次汇总当天周期总结，等待时禁用，回复后弹窗；总结页分“半小时总结/每日总结”双tab，每日tab读取已保存回顾并支持原地重新生成；独立Python模块将完整回复保存到home/daily-reviews，每天一份。
- [每日自动总结与次日阅读 Spec](docs/spec/daily-review-automation/spec.md)、[技术设计](docs/spec/daily-review-automation/tech-design.md)：2026-11-03 Spec v1.1按用户补充更新，日期/时间用选择控件、已结束日期的部分分析也可总结、每日页居中总结按钮与动态日期提示；默认次日03:00，报告与完整失败按日期归属。3个功能、10个场景；技术设计v1.0已确认并实施，执行结果与未验证边界见任务报告。
- [MCP 查询工具 task](docs/task/task-mcp-summary-tools.md)：对外stdio MCP服务提供`list_period_summaries`范围查询与`generate_daily_review`生成两工具，stdlib实现零新依赖；总结只读，回顾复用既有缓存与锁。
- [MCP 任务关联 task](docs/task/task-mcp-task-association.md)：`list_task_associations`逐活动返回任务关联三态——linked列出任务、none为已整理无关联（null）、unknown为未整理或来源变化；只读推导，不触发整理。
- [后台状态球 task](docs/spec/task-linked-timeline-mvp/tasks/task-background-status.md)：顶栏采集中左侧显示任务关联/补分析两枚状态球（运行绿、空闲灰）；关联状态、待关联条数（pendingCount）与最近问题继续只读展示。整理页当前布局由[流水线布局task](docs/spec/screenshot-analysis-backfill/tasks/task-backfill-pipeline.md)承接：三节点、真实增量动效、窄窗口纵排，棕色按钮/进度条和原任务调度沿用。
- [当日档案 task](docs/spec/screen-observer-p0/tasks/task-daily-archive.md)：正文优先的档案式回顾、全日真实统计、同样式PNG长图保存，以及任务片段/详情类型标签；版本0.1.6。
- [三帧拼接分析 task](docs/spec/screen-observer-p0/tasks/task-three-frame-analysis.md)：收满三张后时间标签拼图分析，保留原图，未满批退出/中断日志与受控验证。
- [旧采集清理 task](docs/spec/screen-observer-p0/tasks/task-remove-legacy-capture.md)：移除单帧、缩图和目录回退，保留多屏采集、历史文件与 KMH 运行数据。

- [项目文档总览](docs/README.md)：项目总览、模块协作与快速查阅入口，索引覆盖 scening、桌面客户端、Kimi 自定义模型扩展及独立补丁；迁出、研究交付和上游参考另列，草稿与待验证状态沿模块说明维护。
- [Kimi 自定义模型扩展功能说明](browser/kimi-custom-provider-v2/README.md)：侧栏对话、30 项模型工具与 35 项底层工具、技能、录制、划词、附件、历史和自定义模型配置，以及代码与来源索引。
- [Nanobrowser 进度与环境](docs/nanobrowser-progress-and-environment.md)：当前网页侧栏 Agent 对话扩展，0.3.0 已构建且用户确认可用；记录项目内 Node/pnpm/依赖、安装入口、独立 SWC 缓存清理和审计证据。
- [浏览器扩展 TS/TSX 迁出入口](browser/kmh-extension-ts/README.md)：代码已迁往独立 km-browser-agent 仓库，本地保留说明与 dist 兼容软链接；后续开发与提交在新仓库进行。
- [KMH agent 内核 task](docs/task/task-agent-kernel-dsh.md)：方案 A 落地——KMH（DSH harness）的 agent 循环裁剪打包进扩展为可选引擎（设置 agentEngine 切换），fetch 直连 OpenAI 兼容模型、会话落扩展 IndexedDB 可跨 SW 恢复、24 项浏览器工具进程内注册；kongming-os 零改动只读链接；静态+烟雾验证通过，真实链路待用户验收。

- [docs/project-plan.md](docs/project-plan.md)：产品背景、MVP 总体范围、架构方向、成本策略、示例、路线图和待校准项。
- [docs/spec/screen-observer-p0/spec.md](docs/spec/screen-observer-p0/spec.md)：P0 可验收功能场景、已确认关键约束；v1.0 已确认，v1.1 离线处理、v1.2 定时截图与 v1.3 权限申请均有用户授权。
- [docs/spec/screen-observer-p0/tech-design.md](docs/spec/screen-observer-p0/tech-design.md)：具体方案、时序图、接口、配置、存储字段、失败处理与用例安排；v0.8 的其他主线方案待用户确认，确认后进入 x-req。
- [AGENTS.md](AGENTS.md)：项目入口、模块职责、开发约束、阶段与验收摘要、协作规则。
- [Python 图片处理 task](docs/spec/screen-observer-p0/tasks/task-python-mini.md)：本轮离线 PNG 处理方案、使用方式与真实验证，旧离线入口已移除，原方案与历史证据见该 task。
- [Python 定时截图 task](docs/spec/screen-observer-p0/tasks/task-screen-capture.md)：旧单帧采集的历史方案与证据；当前统一运行多屏采集，清理见 [旧采集清理 task](docs/spec/screen-observer-p0/tasks/task-remove-legacy-capture.md)。
- [最小活动链路 task](docs/spec/screen-observer-p0/tasks/task-activity-pipeline.md)：KMH理解、基本去重、每日JSON与总结，当前运行入口为 `./run.sh`。
- [终端日志 task](docs/spec/screen-observer-p0/tasks/task-terminal-logging.md)：终端与zellij即时进度，文件日志与终端共用事件时间和保存路径。
- [配置中文注释 task](docs/spec/screen-observer-p0/tasks/task-config-comments.md)：全部配置的中文用途、单位、值域与兼容性验证。
- [截图目录 task](docs/spec/screen-observer-p0/tasks/task-snapshot-path.md)：独立截图目录、默认data/snapshot-v1、历史图片引用与验证。
- [YAML 配置 task](docs/spec/screen-observer-p0/tasks/task-yaml-config.md)：全部可调数值、中文原生注释、安全读取、兼容和实际消费验证。
- [运行配置 task](docs/spec/screen-observer-p0/tasks/task-runtime-config.md)：数值配置、加载优先级、启动快照与验证；默认值入口为 [observer.yaml](observer.yaml)。
- `CLAUDE.md` 通过软链接指向本文件，协作规则统一维护于 `AGENTS.md`。

- [每日总结统一弹窗任务](docs/spec/daily-review-automation/tasks/task-unified-review-dialog.md)：2026-11-04用户明确要求自动、右侧按钮、每日页生成与重新生成共用现有档案弹窗；每日页已有总结直接展示完整档案，缺总结提供“生成总结”，正文与保存逻辑共享；后台保留待展示状态，可见且聚焦的窗口实际呈现成功正文后确认。

- [每日自动总结实施报告](docs/spec/daily-review-automation/tasks/task-daily-review-automation/dev-report.md)：设置时间默认03:00，按报告日期独立生成与保存状态；部分分析补总结、三次自动预算、完整错误、居中总结和次日首次展示已实现，执行范围与证据见报告。

- GitHub Release工作流为`.github/workflows/release.yml`，推送v三段版本标签后以publish打包macOS arm64客户端。CI版本固定采用源码和标签的一致版本，同标签重试复用版本；本地人工打包继续按原规则升版。手动工作流默认只验证，正式发布需显式选择。上传前须核验实际包中的模式、版本、构建标记、图标与架构，并完成ZIP解压回读及SHA256核对。
