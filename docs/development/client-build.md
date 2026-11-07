# 桌面客户端打包规范

## 版本号

客户端版本使用 `主版本.次版本.修订号` 三段整数。每次人工打包先升版，再构建。

| 场景 | 升版规则 | 示例 |
| --- | --- | --- |
| 本机客户端打包（包括重打） | 修订号加 1 | `0.2.11 → 0.2.12` |
| 准备 GitHub Release | 次版本加 1，修订号归零 | `0.2.11 → 0.3.0` |
| GitHub Actions 重试同一个标签 | 沿用标签版本，源码和标签一致 | `v0.3.0 → v0.3.0` |

在 `desktop/` 中执行 `npm version patch --no-git-tag-version` 或 `npm version minor --no-git-tag-version`，让 `package.json` 和 `package-lock.json` 同步更新。普通 Git 提交沿用修订号加 1 的规则，同批改动已经打包升版时，提交沿用本批版本。构建后核对源码、锁文件、应用包和构建成功标记的版本一致。GitHub Release 还要核对 `v` 标签与源码版本一致。

## 本机开发包的签名指纹

本机自用通过 `npm run build` 构建 `dev` 包，从固定入口 `desktop/release/mac-arm64/x-scening.app` 启动。应用标识固定为 `local.x-scening.desktop`，主程序名固定为 `x-scening`。默认使用 Electron 自带的主程序签名。沿用此签名时，每次打包都要复用上一版的 Electron 主程序字节及其签名指纹（`CDHash`）。

1. 打包前记录上一版主程序的 SHA-256 和 `CDHash`，核对本轮 Electron 来源。
2. 打包后读实际应用包，核对两个值和上一版一致，并检查应用标识、主程序名与固定路径。
3. 升级 Electron、改变主程序名或更换签名身份时，作为一次权限迁移处理。用第一版授予屏幕录制和输入监控，升级后验证首帧和键鼠监听。

从项目根目录执行以下命令核对本机包。

```sh
app=desktop/release/mac-arm64/x-scening.app
executable=$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$app/Contents/Info.plist")
/usr/bin/shasum -a 256 "$app/Contents/MacOS/$executable"
/usr/bin/codesign -d --verbose=4 "$app" 2>&1 | rg '^(Identifier|CDHash|Signature)='
```

## 本机 Apple Development 签名

本机自用的 macOS dev 和 publish 包可使用同一张 Apple Development 证书。用下列命令查看钥匙串中的有效签名身份，并在 `desktop/` 中将该证书的 40 位 SHA-1 指纹传给打包入口。

```sh
/usr/bin/security find-identity -v -p codesigning
npm run build -- --mode dev --apple-development-identity "$SCENING_CERT_SHA1"
npm run build:publish -- --apple-development-identity "$SCENING_CERT_SHA1" \
  --output-root ../tmp/local-publish-build
```

连续版本复用同一张证书和应用标识，验证旧版的签名身份校验规则可匹配新版。首次从临时签名迁移时，为 Apple Development 签名的包授予屏幕录制和输入监控。后续在同一路径覆盖升级，用实际首帧和键鼠事件验证权限继承。

## GitHub Release 与本机包的关系

构建发生在本机或 GitHub runner，与签名指纹没有直接关系。用同一份 Electron 主程序并保留它的签名时，两边的主程序指纹可以一致。

本项目当前的 [GitHub Release 工作流](../../.github/workflows/release.yml)调用 `npm run build:publish`。[构建入口](../../desktop/src/version-check/build.ts)每次生成新的构建标记，并对完整应用重新做临时签名。因此当前 GitHub Release 的应用指纹与本机 `dev` 包不同，连续构建的 Release 也应预期得到不同的指纹。同一个标签重试只复用版本号，仍会重新构建。

需要让 GitHub Release 承接已有系统授权时，先为该更新链建立稳定的签名身份，并用实际安装的连续两个版本验证权限继承。归档里的 `SHA256SUMS.txt` 用来核对 ZIP 和清单的完整性，应用身份核对使用包内签名及其身份校验规则。
