# 内置 KMH scening

`runtime.tar.gz`为本项目采用的KMH scening生产运行快照，包含profile、插件、模型适配器及供应商目录、原生依赖和独立Node。当前平台为macOS Apple Silicon，具体源版本、平台、依赖数与SHA256见`snapshot.json`；归档内`manifest.json`列出包名和版本，许可证保留在各依赖包目录。

普通客户端构建从本目录读取快照并校验哈希，解包至`desktop/.cache/kmh-runtime`，最终位于应用`Contents/Resources/kmh-runtime`。应用运行时数据保存在所选`<observer-home>/kmh`，用户的凭据及运行数据由现有home管理。

## Node版本与依赖文件

当前快照内置Node v24.22.1，平台为darwin/arm64。使用该快照的客户端通过随包Node启动KMH，用户本机的Node版本可各自保留。源码开发与重新同步快照建议使用Node 24.9.0及以上版本，与KMH CLI声明的最低版本一致；根目录和desktop README里的Node 22.12+要求对应桌面工具链。GitHub构建环境使用Node 24。

`packages/`目录保存完整生产依赖闭包，子目录名是内部哈希编号。Koffi包中的`vendor/node-api-headers`提供编译原生扩展使用的C头文件和许可证；同步过程沿用上游依赖包的目录结构，因此构建辅助文件也随包保留。当前原生运行采用随快照提供的macOS arm64组件。展开的`runtime/`由Git忽略，Git只维护压缩快照及其说明、校验元信息。

更新上游时使用已完成构建的`<kmh-repo>`，在项目根运行：

```sh
KMH_SOURCE_ROOT=<kmh-repo> KMH_NODE_BINARY=<portable-node> desktop/scripts/run.sh run models:sync
```

同步脚本通过KMH已提供的catalogProviderIds、catalogModels、providerDefaultsOf、getSupportedThinkingLevels和supportedProtocols生成目录；scening默认模型来自其原始profile。过滤、真实归档文件头、资源/链接保留与失败边界的回归入口为`desktop/tests/kmh-runtime-snapshot.test.mjs`，可通过桌面`npm test`运行。

profile与依赖包共用敏感文件过滤：凭据配置、`.env*`、私钥、会话/数据库文件、开发报告、测试日志和本机隐藏状态在复制时排除。模型SDK的`credentials.js`、`sessions`接口代码、原生库、资源与许可证继续保留。归档采用USTAR，属主UID/GID统一为0，属主名/组名为空，并清除macOS扩展属性、AppleDouble、ACL和文件标志。

清理既有固定快照时，在项目根运行：

```sh
desktop/scripts/run.sh exec -- node scripts/prepare-kmh.mjs --repack
```

`--repack`先校验原快照哈希，再从原归档清理并重建，保留上游提交、平台和依赖版本，更新`snapshot.json`的SHA256和字节数，并刷新本地展开的`runtime/`目录。归档通过临时文件成功生成后替换。
