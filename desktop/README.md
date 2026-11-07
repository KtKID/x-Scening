# x-scening 桌面客户端

Electron + React + TypeScript 的黄纸底时间线客户端。启动默认读取 `src/scening/` 已保存的本地活动与总结。设置中的“测试预览”可手动切换到带 **【测试数据】** 标识的虚拟活动。

2026-11-03 壳布局调整：左侧148px“明镜”导航提供时间线、回顾、整理与底部设置；顶部日期与星期居中；概览上移并移除标题下的重复日期。功能定义见 [Spec feat11场景1](../docs/spec/screen-observer-p0/spec.md#feat11-在桌面客户端浏览时间线)，本轮范围及验证见[三处壳布局task](../docs/spec/screen-observer-p0/tasks/task-client-shell-polish.md)。

应用名为 **x-scening**，macOS图标来自已确认的明镜Logo。当前固定入口为`desktop/release/mac-arm64/x-scening.app`；`Observer.app`作为兼容软链接保留，旧版更新继续可达。

## 启动

在项目根运行：

```sh
./desktop/run.sh
```

源码用户先完成[根目录的源码运行与编译步骤](../README.md#从源码运行与编译)：当前快照要求macOS Apple Silicon；本流程使用Node ≥24.9.0、npm及Python ≥3.9。先创建项目`.venv`并安装根目录`requirements.txt`，再执行：

```sh
desktop/scripts/run.sh ci
desktop/scripts/run.sh run setup:electron
node desktop/scripts/prepare-kmh.mjs
```

然后默认使用`kmhLauncher: desktop/.cache/kmh-runtime/kmh.mjs`、`kmhProfile: scening`。启动客户端后，打开“设置 → 模型”，选择第三方模型提供商或自定义模型API，填写API密钥、选择模型和思考等级，再点击“保存”。编辑已有供应商时，密钥留空沿用已保存的值。完整构建命令见根目录说明。

从源码生成本机应用：

```sh
desktop/scripts/run.sh run check
desktop/scripts/run.sh version patch --no-git-tag-version
desktop/scripts/run.sh run build
open desktop/release/mac-arm64/x-scening.app
```

开发模式应用使用项目源码、`.venv` 和内置 Agent 运行时。界面开发使用 `./desktop/run.sh`。

脚本使用系统已安装的Node/npm，保留已有PATH的优先顺序，并补入当前用户的`~/.local/bin`和macOS常见安装目录。源码Python入口使用系统Node调用KMH，KMH CLI要求Node ≥24.9.0；该要求同时满足当前桌面锁文件的Node范围。脚本仅对本次子进程清除代理变量以直接下载依赖；全局配置保持原值。本节的npm命令统一经`scripts/run.sh`执行。

当前工作区已实现、待单独提交的内置运行环境接入，采用应用资源内的KMH与独立Node；已提交源码按本节步骤配置启动器并使用系统Node。协议同步脚本从系统PATH定位Node。模型设置页的供应商维护与选择属于该开发接入；KMH失败时的详细输出沿用KMH运行日志。

KMH 的 profile 来源、模型与思考等级、独立运行目录、API Key填写及当前验证状态统一见 [scening 的 KMH 配置说明](../src/scening/README.md#kmh-configuration)。路径示例采用项目相对路径或占位符。

本地记录和采集共用显式 `screenshotDir`。缺少该字段时显示配置错误；旧单帧、缩图和目录回退的清理范围见 [旧采集清理 task](../docs/spec/screen-observer-p0/tasks/task-remove-legacy-capture.md)。已保存的旧图片引用继续可读，`home/kmh` 继续保存 KMH 运行数据。

Windows PowerShell 提供等价的项目内环境入口：`desktop/scripts/run.ps1 ci`、`desktop/scripts/run.ps1 run setup:electron`、`desktop/scripts/run.ps1 run dev`。本轮真实运行覆盖 macOS；Windows / Linux 的平台运行与安装包验收由后续环境执行。

## 已实现功能

- 模型设置：在「分析配置」选已登记的供应商、图片模型和思考等级，再点「应用到分析」。下一次截图分析或总结读取该选择。登记其他供应商时保留当前配置。第三方目录和自定义 API 共用密钥维护，编辑时留空沿用已有密钥，页面只接收凭据状态。
- 模型表单控件：分析配置采用应用内样式的下拉菜单，供应商登记字段沿用现有表单控件，统一边框、箭头与禁用状态。

- 整理页采用“本地截图 → 补分析 → 任务关联”流水线布局，宽窗口横向排列、窄窗口纵向排列；按钮与进度条沿用棕色。保存增量与关联结果变化触发一次流动，动画结束即清理光点，减弱动态偏好保留静态状态；关联节点明确显示其时间线/实际执行日期。后台调度与单操作按钮沿用现有行为，见[流水线布局task](../docs/spec/screenshot-analysis-backfill/tasks/task-backfill-pipeline.md)。

- [本机客户端编译检测](src/version-check/README.md)：独立模块的功能、使用方式、代码与Spec索引。

- 主导航“补分析”：独立页面选择日期，显示本地截图总数、已分析与待分析数量，一个按钮开始/停止/继续补分析。默认昨天，支持今天和历史日期，未来日期禁用；读取正式报告frames判定“全部已分析”，空日期单列。查看与切换日期保持零模型调用，切换页面后台继续，退出取消自有工作并保留成功结果。开启实时分析会先从当天最早未分析图补起，积压后处理新图；两个入口共用日锁协调，设计与验证见[当天队列task](../docs/spec/screenshot-analysis-backfill/tasks/task-today-analysis-queue.md)。
- 应用来源统一为Python系统采集：卡片和详情按`frames[].app`首次出现顺序去重，旧单图沿用顶层`app`；多应用活动可分别匹配每个应用筛选，应用分布按每条涉及该应用的活动计一次。未知身份单列为“未知应用”，使用应用数统计已识别名称。模型`observation.app_tags`保留原始结果，展示与统计消费采集身份；周期总结采用相同口径。实现及应用切换、真实双屏与窗口验证见[系统应用身份任务](../docs/spec/screen-observer-p0/tasks/task-system-app-identity.md)。
- 设置 → 运行配置：完整编辑当前个人配置的运行参数和任务类型。分析与截图频率优先展示，其他参数按分析与总结、存储与模型、分析拼图、屏幕与截图策略、键鼠与画面选取、超时与进程控制分组；每项有中文用途和单位说明。
- 设置中的“保存”统一写入本次配置草稿，保留 YAML 中文注释及文件权限；数值、路径、时间、任务类型和拼图几何条件通过现有 Python 权威模型校验。文件被外部修改、无效输入或写入失败时提示原因并保留草稿。“清除修改”恢复最近成功读取或保存的值，同时清空新类型输入；客户端内切换页面保留草稿。「截图存储」可直接编辑路径，也可通过「选择文件夹」打开系统窗口并填入草稿。点击「保存」后，下一张截图起使用新路径。原始 JPEG、采集旁文件与日索引一起保存，旧截图保留原位置，日志、活动、总结和分析拼图沿用各自的目录。其他采集参数下次开始采集读取，每日回顾字数下次生成读取，桌面刷新周期随下一轮状态读取更新。实现与验证见[完整设置 task](../docs/spec/screen-observer-p0/tasks/task-settings.md)。
- 设置 → 预设 → 任务类型：增删类型后使用统一的“保存”按钮，默认工作、学习、娱乐、游戏。活动卡片和详情按 `observation.task_types` 显示全部已选类型，多项和长名称自动换行；空列表与旧记录显示“待分类”，历史自定义名称继续保留。展示与真实窗口验证见[卡片类型任务](../docs/spec/screen-observer-p0/tasks/task-task-type-cards.md)。
- 三栏：侧边导航、每日时间线、右侧概览。卡片选中切换活动详情，关闭按钮或 Escape 返回概览。
- 日期前后切换、日历、今天、应用筛选、手动刷新；同小时的密集活动顺序排列，单时间点活动保持可读。
- 测试模式中，标题、正文、总结均以【测试数据】开头；虚拟记录仅在内存生成，截图使用明确标记的占位预览。
- 测试预览提供明镜宣传录屏用的今日总结，内容围绕客户端脱敏、OCR判别、模型分析与今日总结流程；活动、周期总结与当日档案保持同一主题，概览“展示总结”和“回顾 → 每日总结”共用完整虚构正文。见[宣传演示task](../docs/spec/screen-observer-p0/tasks/task-demo-daily-review.md)。
- 设置 → 本地记录：读取当前配置的 home / screenshotDir，显示按天 JSON 活动、周期总结和原始截图，支持相对及历史绝对引用；截图支持放大。
- 空日期、坏JSON、无效活动、缺图、配置错误分别显示；活动/总结分别读取，支持修复文件后刷新。
- 历史分析的卡片标题从可见事实短句派生，正文预览整理格式，详情保留完整原文；单次观察显示到秒，同分钟短区间保留秒级起止。真实6条数据的适配证据见 [10月22日卡片任务](../docs/spec/screen-observer-p0/tasks/task-timeline-real-records.md)。
- 窄窗口保留概览与总结入口，点击卡片显示右侧详情抽屉。
- macOS工具栏提供“开始截屏 / 停止截屏”和实际进程状态；开始按分析开关接入完整或仅截图流程，并切换到今天的本地记录。同项目、同home的独立进程会显示完整/仅截屏模式，重复启动沿用现有进程。
- 工具栏“开启分析”开关默认开启，本次客户端保留选择。关闭后继续保存JPEG，开启后生成活动与总结；采集中切换在同一Python进程内生效，关闭时取消当前分析和总结、保留原图与已提交记录，截图持续；默认预算下1秒内确认完成。已保存记录继续可读。
- 本地记录按当前配置的 `desktop.refreshIntervalSeconds` 自动更新（项目默认2秒），活动追加、末条end和总结均会更新；保留日期、筛选和仍存在的详情，手动刷新继续提供即时重读。

停止截屏会优先通知采集线程结束生产，取消当前KMH任务并核对整个任务进程组回收，当前短文件提交完成后确认停止；分析切换期间停止按钮保持可操作。采集状态通过事件即时推送，记录列表保留原刷新节奏。macOS关闭窗口保留采集，退出应用会等待本客户端启动的进程退出；独立进程由显式“停止截屏”控制。启动与退出错误显示原因，运行输出保存在 `desktop/.cache/capture.log`，原有日志继续位于项目logs。独立进程的状态依据锁持有者与进程身份查询，退出码以独立进程原日志为准。

当前scening采集依赖macOS，Windows/Linux客户端可浏览记录，采集控制显示“仅浏览”。采集控制见[原task](../docs/spec/screen-observer-p0/tasks/task-desktop-capture.md)，本轮开关及验证见[分析开关task](../docs/spec/screen-observer-p0/tasks/task-desktop-analysis.md)。

现有数据读取主定义为 [Spec feat11](../docs/spec/screen-observer-p0/spec.md#feat11-在桌面客户端浏览时间线)，局部设计、用例和证据见 [qdev task](../docs/spec/screen-observer-p0/tasks/task-desktop-client.md)，视觉依据为 [已确认效果图](../docs/design/observer-shell-paper-v1.png)。

## 每日温馨总结

右侧“当日概览”在所选日期已有总结时显示“展示总结”，点击直接展示页面已载入的完整档案，正文与操作随弹窗一起呈现；缺总结、读取期间或读取失败时隐藏按钮。日期及数据来源切换后按当前选择更新，读取和展示保持零模型调用。手动生成沿用“回顾 → 每日总结”的“生成总结”和“重新生成”。弹窗支持关闭、Escape、点击遮罩与回到时间线；实现与验证见[概览总结按钮task](../docs/spec/daily-review-automation/tasks/task-overview-summary.md)。

主导航“总结”页分“半小时总结 / 每日总结”两个tab，每日页通过日历选择报告日期。1号报告在2号生成并始终归属1号；每个日期显示自身状态；已有正文直接呈现在每日页，生成与失败重试共用档案弹窗。错误含原始多行详情，可滚动查看，重新生成失败时旧正文继续保留，最近错误固定显示在上方。

设置 → 每日总结使用时间选择器，默认本地03:00，保存后立即重排。客户端到点、启动和恢复时补昨天及更早已结束、到期且已有分析的日期，部分12小时分析即可总结；截图补分析继续独立推进。自动尝试共3次，包含首次；每次失败完成60秒后继续，次数和完整原因按日期持久化。用户可手动单次重试。每天首次回到前台通过同一档案弹窗阅读昨日总结；窗口可见且聚焦、成功正文实际呈现后记为当天已展示。后台、隐藏、失焦和锁屏保留待展示状态。

每日页已有报告时直接展示完整档案及重新生成、保存图片按钮；缺报告且状态读取完成时，正中显示“生成总结”。当天已有部分分析也可手动生成，自动计划继续按既定日期与时刻执行。页内重新生成、右侧展示按钮和自动提醒共用档案弹窗；正文和保存图片逻辑由页内档案与弹窗复用。测试预览保留【测试数据】标记。每日进程与截图分析、半小时总结和任务关联独立；macOS关窗后主进程继续调度，退出应用时取消自有模型进程。Python将正文保存在 `home/daily-reviews/YYYY-MM-DD.json`，次数、错误和展示记录保存在 `home/daily-review-status/YYYY-MM-DD.json`。实现与验证见[每日自动总结任务](../docs/spec/daily-review-automation/tasks/task-daily-review-automation/dev-report.md)。

每日回顾采用暖纸档案样式，完整正文保留原换行；顶部统计来自点击生成时的全日记录快照，包含活动条数、采集应用去重数及同日有效任务数。工作、学习等分类支持多选，按分类次数统计，缺项计入待分类；任务关系待整理时明确标记。点击“保存图片”选择本地位置，导出同一份完整正文和统计的PNG长图，取消与失败保持原数据。布局、保存流程和真实验证见[当日档案task](../docs/spec/screen-observer-p0/tasks/task-daily-archive.md)。

## 构建模式与数据目录

本地`npm run build`使用`dev`模式；GitHub Actions的Release事件或tag构建自动使用`publish`模式。模式随客户端编译产物保存，dev 首次启动使用 [公开默认值](../observer.yaml) 和 [开发目录模板](../observer.defaults_dev.yaml) 生成项目根目录的 `observer_dev.yaml`，之后直接读取这份由 Git 忽略的个人配置。默认 home 为 `./home`，截图目录为 `./data/snapshot-v1`。手动验证发布构建可执行`npm run build:publish`。

publish首次启动在`~/.scening/observer.yaml`保存用户配置，默认活动、总结和KMH数据归`~/.scening`，正式截图归`~/.scening/snapshots`，桌面缓存归`~/.scening/desktop/.cache`，日志归`~/.scening/logs`。已有用户配置原文保留，`OBSERVER_CONFIG`可显式选择另一份配置。`~`由Python与桌面统一展开为当前用户主目录。

开启分析时，点击「开始截屏」会先检查当前图片模型和 API 密钥。缺少配置时，界面提示前往「设置 → 模型」，采集保持停止。仅截屏模式可直接保存截图。

发布构建仅读取 [公开模板 observer.yaml](../observer.yaml)。首次创建用户配置时保留中文注释。publish 安装包包含独立 Python、感知模块、Node 和基于 DeepSeek Harness 插件打包的 Agent 运行时。应用从自身资源定位运行环境。首次运行时按提示授予系统权限，需要分析时在“设置 → 模型”填写 API 密钥。包内运行环境和 ZIP 校验见 [GitHub Release](#github-release)。实施、真实测试和远程构建边界见[发布模式任务](../docs/spec/screen-observer-p0/tasks/task-publish-mode.md)。

## 更新记录

- 2026-11-05：补齐publish包的独立Python与截图/OCR依赖，后端从安装包自身定位；真实迁移、设置读写、KMH调用和ZIP回读见[Release运行环境任务](../docs/spec/screen-observer-p0/tasks/task-portable-runtime.md)。

- 2026-11-04：新增dev/publish构建模式、用户配置首次创建与`~`路径支持；[发布模式任务](../docs/spec/screen-observer-p0/tasks/task-publish-mode.md)已完成本地验收，Python58项、桌面99项及双模式编译通过。

- 2026-11-04：整理页改为三节点流水线布局，沿用棕色按钮/进度条和既有任务调度，执行与验证见[流水线布局task](../docs/spec/screenshot-analysis-backfill/tasks/task-backfill-pipeline.md)。

- 2026-11-04：补充明镜宣传录屏的今日总结测试内容，演示来源、日期和档案保存沿用现有流程，状态见[宣传演示task](../docs/spec/screen-observer-p0/tasks/task-demo-daily-review.md)。

- 2026-11-04阅读更正：已有总结在每日页直接展示，缺总结显示“生成总结”；生成和自动提醒继续统一弹窗，正文和保存图片复用。

- 2026-11-04：所有每日总结触发统一至档案弹窗，实际前台展示后确认；隐藏/失焦/锁屏保护与展示日志见[统一弹窗任务](../docs/spec/daily-review-automation/tasks/task-unified-review-dialog.md)。

- 2026-11-01：0.1.6新增档案式每日回顾、真实统计与PNG保存，任务片段和详情补齐类型标签，时间线卡片类型位于右上角；关联任务名称沿用已确认规则。构建入口为`release/mac-arm64/Observer.app`，重新打开应用后加载新包。见[当日档案task](../docs/spec/screen-observer-p0/tasks/task-daily-archive.md)。

- 2026-10-29：启动默认读取真实本地记录，测试预览由设置手动选择；见[默认本地记录task](../docs/spec/screen-observer-p0/tasks/task-default-local.md)。

- 2026-10-28：新增独立每日回顾，概览按钮每次重新生成，成功后遮罩弹窗展示，完整模型回复按日保存；见[每日回顾task](../docs/spec/screen-observer-p0/tasks/task-daily-review.md)。
- 2026-10-27：新增工具栏分析开关，复用完整/仅截图模式并在当前保存完成后切换；详见[分析开关task](../docs/spec/screen-observer-p0/tasks/task-desktop-analysis.md)。

## 数据与代码边界

| 目录            | 职责                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `src/main/`     | Electron窗口、安全边界、只读文件与图片适配、现有采集进程的启停与状态；主进程只接受当前页面请求 |
| `src/preload/`  | 按日读取、按当前记录ID读取图片、查询运行状态、启停采集；参数和响应校验                         |
| `src/shared/`   | 唯一 UI 消息 Zod、测试数据、日期显示；scening 契约为自动生成文件                               |
| `src/renderer/` | React 时间线、概览、详情、总结、设置与纸纹视觉                                                 |
| `scripts/`      | 项目内环境与 Pydantic → Zod 生成                                                               |
| `tests/`        | 隔离文件适配和真实 Electron 窗口验证                                                           |

`src/scening/activity_memory.py` / `observer_config.py` 继续拥有活动与配置协议，`daily_review.py`拥有独立每日回顾协议和文件，`daily_review_state.py`拥有逐日状态与视图协议。`contracts` 使用项目 `.venv` 导出 Pydantic JSON Schema，生成 Zod；`contracts:check` 检查漂移。现有 Python 自定义的日期/区间/正文约束在读取时补核对。位置配置采用生成模型的字段投影。UI消息和派生 title/id 由 `shared/protocol.ts` 定义，正式活动所有字段沿用原文件，扩展字段保持。

界面以记录中的钟点排列，活动条数表示已保存记录的数量；采样活动区间的统计含义继续沿用现有观察模型。客户端读取home、截图和配置，Python继续独占正式数据写入。自动更新与手动刷新均读取完整的已落盘文件。桌面间隔从当前所选配置读取，显式旧配置缺少desktop块时沿用项目YAML该块。

## 检查和构建

KMH来自项目内`vendor/kmh-scening/runtime.tar.gz`固定运行快照；构建校验SHA256后解包到`desktop/.cache/kmh-runtime`，再纳入应用资源。快照包含scening、生产依赖、供应商目录和独立Node，当前适用macOS Apple Silicon；源码来源版本与哈希见同目录`snapshot.json`，第三方许可证随依赖包保留。同步上游时设置`KMH_SOURCE_ROOT=<kmh-repo>`、`KMH_NODE_BINARY=<portable-node>`，运行`desktop/scripts/run.sh run models:sync`重建项目内快照。普通构建直接读取固定快照。

版本采用三段整数：普通Git提交将末段加1（如0.1.10→0.1.11）；Release准备提交将中段加1、末段归零（如0.1.11→0.2.0），同次提交升号一次。对照上一提交准备本次版本，已有正确递增时将版本与锁文件直接纳入该次提交；需要准备版本时使用`desktop/scripts/run.sh version patch --no-git-tag-version`，Release准备时使用`desktop/scripts/run.sh version minor --no-git-tag-version`。

```sh
desktop/scripts/run.sh run check
desktop/scripts/run.sh test
desktop/scripts/run.sh run build
desktop/scripts/run.sh run test:e2e
desktop/scripts/run.sh exec -- tsx tests/capture.e2e.ts
desktop/scripts/run.sh run package
```

`desktop/scripts/run.sh run build`完成编译与打包，统一发布到`desktop/release/mac-arm64/x-scening.app`；`run package`复用同一流程。每次构建更新这个固定入口，应用包核对完整并就绪后发布检测标记。`out/`保留编译中间结果，`run start`用于开发预览；正式使用从固定应用入口启动。本地客户端启动时按应用位置定位项目根。环境变量 `OBSERVER_PROJECT_ROOT`、`OBSERVER_CONFIG` 可显式选择其他项目根或配置文件。源码采用三平台 Electron API；本轮平台运行证据以 task 为准。

运行中的客户端每60秒检查新构建，提示中点击“重启并更新”即可安全收尾并自动打开固定入口的新版本。等待时显示“正在重启…”，失败保留当前窗口并显示完整原因；见[一键更新task](../docs/spec/screen-observer-p0/tasks/task-local-client-restart.md)。

依赖在 `node_modules/`，npm / Electron / electron-builder 缓存、临时文件、用户数据、会话、采集终端输出和崩溃日志在 `.cache/`。每次启动默认本地记录；测试预览由用户在本次浏览中手动选择。采集沿用项目.venv与原入口，所有新增测试使用独占目录。

## Changelog

| 日期       | 变更                                                                       | 记录                                                                              |
| ---------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 2026-10-29 | 活动卡片与详情显示多个任务类型，空列表和旧记录显示待分类，长名称自动换行。 | [卡片类型](../docs/spec/screen-observer-p0/tasks/task-task-type-cards.md)         |
| 2026-10-29 | 采集、每日回顾、开发启动与协议同步统一使用系统 Node，版本由用户维护。      | [系统 Node 修复](../reports/fix/fix-report-20261029-system-node.md)               |
| 2026-10-29 | 设置覆盖全部运行参数，统一保存与清除修改，保留跨页草稿并校验保存冲突。     | [完整设置](../docs/spec/screen-observer-p0/tasks/task-settings.md)                |
| 2026-10-29 | 新增任务类型预设编辑、配置保存和模型候选列表，卡片多类型识别另行对接。     | [类型预设](../docs/spec/screen-observer-p0/tasks/task-type-presets.md)            |
| 2026-10-27 | 截图目录改为必填，移除旧目录回退，并从 Python 同步清理后的配置契约。       | [旧采集清理](../docs/spec/screen-observer-p0/tasks/task-remove-legacy-capture.md) |
| 2026-10-27 | 增加 KMH 配置与登录依赖的统一文档入口，路径示例采用相对引用或占位符。      | [KMH 配置说明](../src/scening/README.md#kmh-configuration)                        |
| 2026-10-27 | 启停现有scening、显示采集状态、本地记录自动更新，保留刷新。                | [采集控制qdev](../docs/spec/screen-observer-p0/tasks/task-desktop-capture.md)     |
| 2026-10-27 | 首版三栏黄纸客户端、测试卡片与 scening 只读读取；实现及验收状态见 task。   | [客户端 qdev](../docs/spec/screen-observer-p0/tasks/task-desktop-client.md)       |

## 三帧活动读取

scening专用工具的完整结果保存在活动observation，analysis为三段兼容正文；卡片预览继续显示可见事实。外部Zod通过受控生成脚本进入Python，再由contracts生成桌面校验模型，旧记录保持可读。真实拼图与跨语言读取证据见[接入task](../docs/spec/screen-observer-p0/tasks/task-scening-profile.md)。

Python默认凑满三份候选后分析一张时间标签拼图，客户端卡片区间对应首末采集时间，详情图片读取该拼图。逐帧原图、时间、应用与屏幕保存在活动frames中，契约由Pydantic自动生成；历史单图记录继续可读。实现与验证见[三帧task](../docs/spec/screen-observer-p0/tasks/task-three-frame-analysis.md)。

### 0.1.1（2026-10-29）

- 切换总结、设置后返回时间线，恢复原滚动位置。
- 侧栏与设置显示版本号；界面版本由 package.json 在构建时统一注入。
- 发布修复时同步更新 package.json 和锁文件版本、构建并打包 release 应用，再直接验证应用包版本与修复场景。

### 同日任务时间线

本地活动按目标关联为任务，连续片段共用任务颜色。点击卡片查看当天进展、各次投入和全天时间条；点击关联内容定位时间线，筛选遮住目标时恢复全部应用并提示。分析开启且查看某天时按需整理文字；结果保存到 home/task-timeline，成功采样依据保存到 home/activity-evidence。历史资料缺少连续依据的时间显示待确认。验证见 [MVP开发报告](../docs/spec/task-linked-timeline-mvp/tasks/task-mvp-chain/dev-report.md)。

2026-10-31起，任务完成判断与“完成范围”展示暂停，任务详情保留可见活动、变化和来源。历史原字段继续兼容读取，当前投影清空其展示值，见[暂停完成判断task](../docs/spec/task-linked-timeline-mvp/tasks/task-disable-completion.md)。

### 0.1.2（2026-10-30）

- 打包交付同日任务关联、固定任务颜色、进展详情、点击定位与全天时间条。
- 应用仍放在 desktop/release/mac-arm64/Observer.app，沿用原home与截图目录。
- 复用本地Electron分发打包：`desktop/scripts/run.sh exec -- electron-builder --dir --config.electronDist=node_modules/electron/dist`。
- 从Codex启动时为应用启动命令申请运行权限；启动及数据保留证据见 reports/task-linked-timeline-mvp/release-0.1.2。

### 0.1.3（2026-10-30）

- 修复进展“回看”和投入列表的跳转被阅读位置恢复抵消；定位后聚焦目标，刷新保持新位置。
- 历史观察范围按任务色展示，斜纹说明时长待确认；点击短片段可跳转，密集位置展开记录列表。
- 待关联观察与空白在时间条旁提供说明，定位待关联记录保留当前任务详情。
- 回归入口为 `tests/task-navigation.e2e.ts` 和 `tests/task-timeline.e2e.ts`，修复及打包客户端实点记录见[修复报告](../reports/fix/fix-report-20261030-task-navigation.md)。

### 0.1.10（2026-11-01）

- 多任务记录恢复为普通活动卡，顶部多个任务标签可分别打开详情，右上角保留工作/学习/娱乐等多分类。
- 相邻记录各自只关联同一taskId时嵌套为任务组，内层保留每段活动；展示分组与投入估算各自处理，时长待确认也可成组。
- 显示衔接沿用observer.yaml的taskTimeline.maxContinuityGapSeconds（当前90秒）；其他任务、多任务、待关联、长间隔保留边界，应用筛选沿既定边界过滤。详见[分组修正task](../docs/spec/task-linked-timeline-mvp/tasks/task-activity-card-grouping.md)。

### 0.1.9（2026-11-01）

- 模型输入的已有任务目录与输出`newTasks`分开表达，旧`tasks`回复兼容读取，重复声明已有ID继续严格拒绝并返回具体诊断。
- 原采样时点带微秒、活动区间按秒保存时，时点回看归于同一原记录最近任务段；保留原始时间，避免生成额外卡片。同任务跨时间的记录继续分别展示。
- 当前组合子卡样式为实现时的展示选择；用户2026-11-01指出其未明确提出该样式，现阶段先查看效果，后续按实际反馈调整。

### 0.1.8（2026-11-01）

- 一条原记录支持多个任务，卡内分支分别打开任务详情；进展与原文证据按任务保存，明确帧号可直接打开原图，其余保留整组截图并标记具体帧待确认。
- 多任务混合时段显示待确认；唯一归属且满足连续性规则的时段只累计一次。档案按原活动、采集应用、关联任务分别去重，保存图片沿用完整档案样式。
- 兼容v1任务文件，首次v2提交前按原字节备份到home/task-timeline/backups；先整理失败/待处理记录，再逐批升级当天旧关系。原活动和原始JPEG继续保留。
- 方案与逐项验证见[多任务实施报告](../docs/spec/task-linked-timeline-mvp/tasks/task-multi-task/dev-report.md)。

### 0.1.7（2026-11-01）

- 任务整理取消改为信号记录意图、运行循环统一回收，修复旧进程长期占锁。
- 完整任务目录和正文按预算组批；失败提示带诊断码并按日期保留。根因与验证见[修复报告](../reports/fix/fix-report-20261101-task-organizer-lifecycle.md)。

### 0.1.4（2026-10-30）

- 时间条的密集位置和待关联记录改为单次点击直接定位卡片；极窄片段选最近时间位置，实际覆盖范围优先。
- “按时间选择”继续提供主动列表选择入口，空白区间继续显示记录覆盖说明。
- 点击规则、桌面回归与打包实点见[直接定位修补单](../reports/fix/fix-note-20261030-timebar-direct.md)。

### 2026-10-31 补分析入口

- 当天允许补分析；开启实时分析先补当天积压，尾批也补齐，随后接新图。实时与手动入口共享队列顺序和按日锁，原图与系统采集元信息支持重启恢复。详见[当天队列task](../docs/spec/screenshot-analysis-backfill/tasks/task-today-analysis-queue.md)。
- 新增独立Tab、日期选择和单个操作按钮，由应用调用既有补跑程序；显示全天完成状态与本轮进度，支持停止和剩余继续。功能正文与证据见[桌面补分析task](../docs/spec/screenshot-analysis-backfill/tasks/task-desktop-backfill.md)。
- 修正按钮悬停文字对比与禁用等待光标；当前日期直接显示“请选择历史日期”，空日显示“暂无截图”，实际请求期间显示处理中。真实点击与打包验证见[修复报告](../reports/fix/fix-report-20261031-backfill-button.md)。

- 2026-11-03 每日回顾统一使用完整报告协议；桌面、CLI与MCP共用权威模型并保留已保存正文。用户明确要求清理刚加入的旧客户端分流，规则与结果见[单一读取协议task](../docs/spec/daily-review-automation/tasks/task-single-report-protocol.md)。

## GitHub Release

推送三段版本标签（例如`v0.2.0`）会触发`.github/workflows/release.yml`，在macOS arm64环境检查代码并明确调用`build:publish`。标签须与`desktop/package.json`版本一致；Release准备版本遵循中段加1、末段归零。

publish 构建在写入包内构建标记后为完整应用及嵌套组件做临时签名。应用包、显示名和主程序统一为 `x-scening`。流程读取实际包内的主进程、版本和构建标记，核对 publish 模式、名称、arm64 架构、图标及整包递归严格验签，并启动包内 Python 与 KMH。ZIP 解压后执行同样的核验，再上传 ZIP、JSON 清单和 SHA256SUMS。核对通过后创建 Release，相同标签重试更新对应附件。工作流使用当前仓库 GITHUB_TOKEN，发布 job 单独声明 contents:write。

Actions里的“Run workflow”要求填写候选标签，`publish_release`默认false，仅构建并保留候选附件；正式手动发布需选择true并使用已有标签。本地`npm run build`继续默认dev；发布包内置独立Python、scening源码及截图/OCR依赖，KMH快照在构建时解压并连同Node进入应用Resources；应用从自身资源启动，用户填写自己的模型API密钥。`OBSERVER_PROJECT_ROOT`用于开发模式。产物为 macOS Apple Silicon 客户端 ZIP，跨版本授权继承需使用稳定的 Developer ID 签名并单独验证。

```sh
git push origin main
git tag v0.2.0
git push origin v0.2.0
```

源码入口：`src/release-artifacts.ts`。检查命令：`npm run release:check-tag -- --tag v0.2.0`，`npm run release:verify -- --tag v0.2.0`；`release:archive`先核验再压缩回读。首次配置与证据见[GitHub Release任务](../docs/spec/screen-observer-p0/tasks/task-github-release.md)。

独立Python构建工具固定为uv 0.9.18，Python为3.12.11；`requirements-runtime.lock`从根`requirements.txt`生成并记录依赖哈希。首次构建联网准备依赖，安装后的应用使用包内资源。发布候选可通过`npm run build:publish -- --output-root ../tmp/portable-client-build`隔离生成，正式本机入口保留。
