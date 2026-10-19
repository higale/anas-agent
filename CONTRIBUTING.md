# 参与贡献

Anas 在独立的开发仓库中维护。公开的 `anas-agent` 仓库定期接收源码快照：每次同步新增一个提交，发布时添加版本标签。日常开发提交不公开，公开版本的历史保持连续。

## 报告问题

请提供 Anas 版本、操作系统、复现步骤、预期行为和实际行为。只附上相关日志片段，发布前移除个人数据和凭据。不要上传应用数据目录、会话数据库或模型供应商配置。

## 修改项目

1. 阅读 [AGENTS.md](AGENTS.md) 和[开发环境](#开发环境)。涉及审批、持久化或其他安全边界的修改必须遵循[安全模型](docs/SECURITY_MODEL.md)。
2. 使用 `npm ci` 安装依赖，保留必要补丁和可选原生依赖。
3. 每次修改聚焦一个目标，并同步更新受影响的文档。运行 `npm run typecheck` 和相关行为测试；主进程与渲染进程集成变更还需运行 `npm run build`。
4. 在拉取请求中说明问题、修改后的行为和验证结果。贡献使用项目的 [MIT 协议](LICENSE)，请保留第三方声明。

维护者会在下一次源码快照发布前，将已接受的贡献整合到开发仓库中，确保同步时保留这些修改。

## 开发环境

先阅读 [AGENTS.md](AGENTS.md)，检查工作区和近期 Git 历史，再安装当前平台的依赖。内置 ripgrep 和原生模块需要 npm 可选依赖，请勿跳过。

使用 Node.js 24、npm 和 Git。在目标操作系统上安装依赖，不要跨平台复制 `node_modules`。如果没有匹配的预编译原生模块，可能需要安装平台构建工具。只有使用 Python 工具、Skills 或相关测试时才需要 Python。在 Windows PowerShell 中，如果执行策略阻止 `npm.ps1`，请使用 `npm.cmd`。

```bash
npm ci
npm run dev
npm run typecheck
npm test -- <test-file>
npm run build
```

`build` 会检查类型，构建主进程、preload 和渲染进程资源，并验证主进程依赖边界。按修改的行为运行相关测试。Electron 检查使用隔离的数据目录：

```bash
npm run test:e2e -- --help-only
npm run test:e2e -- --startup-only
npm run test:e2e -- --storage-only
npm run test:e2e -- --workspace-only
```

构建、打包与后端测试共用生成文件和原生依赖，请串行运行。

| 目录 | 职责 |
| --- | --- |
| `src/main/agent/` | Agent 构建、持久化、生命周期与 IPC |
| `src/main/` | Electron 与产品服务 |
| `src/preload/` | 带类型的 `window.gale` 桥接接口 |
| `src/renderer/` | React 工作区、设置与共享控件 |
| `src/shared/` | 共享类型与辅助函数 |
| `data/` | 内置配置、帮助、语言包、技能、示例和资源 |
| `patches/` | 由 `postinstall` 应用的必要依赖补丁 |

## 本地打包

```bash
npm run pack       # 本地未压缩的应用目录
npm run dist       # pack 的别名
npm run portable   # Windows x64 便携包
npm run pack:win:release  # Windows x64 完整应用文件夹 ZIP
npm run pack:mac:release  # 当前 Mac 架构的 ad-hoc 签名 DMG
```

在 macOS 上，`pack` 会在 `release-build/` 下生成 ad-hoc 签名的应用，不使用证书签名、时间戳或公证，也不需要 `sudo`。打包时会校验内置依赖，包括原生 ripgrep；跨平台构建需要目标平台对应的包。

`pack:mac:release` 在 Mac 上运行：Apple Silicon 生成 ARM64 DMG，Intel 生成 x64 DMG，输出至 `release-macos/`。它采用 ad-hoc 签名，不需要 Apple 开发者账户、签名证书、时间戳或公证。构建会检查签名，并对打包后的应用进行冒烟检查。下载的应用在首次尝试启动后，可能需要在“系统设置 > 隐私与安全”中选择“仍要打开”。

`pack:win:release` 在 Windows x64 上运行，验证应用后生成 `release-build/Anas-<version>-windows-x64.zip`。解压后运行 `Anas/Anas.exe`，请保留整个文件夹。用户数据仍使用正常的应用数据目录。除非明确设置镜像环境变量，否则发布命令使用标准 Electron 下载地址；命令本身不会上传安装包。

## 维护者发布

详见[源码快照发布](docs/SOURCE_PUBLISHING.md)。应用版本来自 `package.json`，公开标签使用相同版本号。公开发布可以跳过中间的开发版本。
