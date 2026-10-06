# Anas 插件

## 范围与设计

插件用于独立开发、按需安装的界面和辅助功能。参考 [VS Code 的扩展入口与 Webview](https://code.visualstudio.com/api/extension-guides/webview)及 [Obsidian 的小型插件包](https://github.com/obsidianmd/obsidian-sample-plugin)，由 Anas 提供自己的有限宿主接口，不引入整套 IDE 框架。

提供：从 ZIP 或 `PLUGIN.json` 安装、启用／停用、卸载、固定插件菜单、侧边面板、独立窗口、独立数据和可选 Node 后台。插件包必须是已构建的产物，不在用户机器上执行 npm 安装或编译。插件市场、自动更新、任意位置 UI 注入以及模型工具注册不在本版范围内。

UI 和后台均为可选入口，至少提供一个。纯 UI 插件不创建后台进程；后台首次启动或调用时才创建独立 Electron utility process。插件不导入 Anas 内部 React 模块，也不建立另一套 Agent 执行循环。Skills、Tools 和 MCP 继续使用各自现有机制，本版不自动授予插件模型工具权限。

侧边面板收起、切换标签、进入设置及切换会话只隐藏已打开的插件页面，保留其页面状态。关闭插件标签销毁该页面。独立窗口是另一份页面实例，插件后台和持久化数据按插件共享；侧边页与独立窗口之间不承诺转移浏览器内存状态。RDP 等功能应自行管理连接会话，后续接入时验证其生命周期。

## 插件包

根目录必须包含 `PLUGIN.json`：

```json
{
  "version": 0,
  "id": "example-notepad",
  "name": "Notepad",
  "plugin_version": "0.1.0",
  "api_version": 1,
  "description": "A small persistent notepad.",
  "ui": "index.html"
}
```

- `version` 是清单格式版本，目前为 `0`；`plugin_version` 是插件自己的三段版本号。
- `id` 使用小写字母、数字和单个短横线，必须以字母开头，不使用 Windows 保留名称。
- `api_version` 必须为 `1`，不兼容时显示原因，不运行插件。
- `ui` 为包内 HTML 相对路径；`backend` 为可选的包内 `.cjs` 相对路径。
- 可选 `platforms` 为 `win32`、`darwin`、`linux` 的数组；缺失表示所有平台。
- 路径使用 `/`，不得为绝对路径、包含 `..` 或指向包外资源。
- 插件文件最多 10,000 个，总计最多 512 MiB，单个文件最多 128 MiB。包内链接需指向包内普通文件／目录，安装时复制实际内容；循环链接拒绝安装。

点击“安装插件”选择 ZIP 文件或 `PLUGIN.json`。选择清单会复制它所在的整个目录；后续修改源目录不会直接修改已安装插件。ZIP 支持清单位于根目录，或压缩包仅含一个顶层文件夹且清单位于其中；多个候选插件根目录、额外包装层或缺失清单会报错，不自动猜测。

ZIP 原文件最多 512 MiB，解包同时执行上述文件数量、单文件和总大小限制；达到 1 MiB 的条目压缩比最多 1,000 倍。解包流式校验大小、CRC、路径和重复条目，保留普通访问权限及可执行位，不套用应用备份的目录排除规则。失败时清理本次暂存文件，保留原始 ZIP、已安装插件和独立数据。

安装先在应用临时目录暂存、检查，再原子移动到 `plugins/<id>/package/`。同 ID 已安装时拒绝覆盖；卸载后重新安装可用于手动更新。`plugins/<id>/installation.json` 保存 `version: 0` 与 `enabled`，缺失 `enabled` 默认为 `true`。损坏插件单独显示错误，不阻止 Anas 启动或其他插件使用。

插件数据位于 `plugin_data/<id>/`，卸载保留数据，重新安装同 ID 后可以继续使用。应用数据备份包含插件和数据；备份、恢复、进入数据修复、停用、卸载及退出应用会停止后台，恢复不会自动重启插件后台。

## 界面 API

HTML 引入宿主 SDK，业务脚本单独保存：

```html
<script src="/_anas/sdk.js"></script>
<script src="app.js"></script>
```

`window.anas` 提供 Promise API：

```js
const info = await anas.getInfo();
const value = await anas.data.get('draft'); // 未设置时返回 null
await anas.data.set('draft', { text: 'Hello' });
await anas.openExternal('https://example.com');
const result = await anas.backend.call('example', { value: 1 });
```

`getInfo()` 返回 API 版本、应用版本、插件 ID、当前语言、明暗主题和字号。数据键最长 80 个字符，允许字母、数字、点、下划线和短横线；数据为 JSON，单个插件的数据文件最多 1 MiB。写入按顺序原子保存。不存在的键使用 `null`，有效的 `false`、`0`、空字符串和空数组原样保留。

页面使用独立的 `anas-plugin://<id>/` 来源，通过专用消息接口访问宿主，没有 `window.gale`、Node 或任意文件读取接口。页面可以请求网络；允许 WASM、包内脚本和样式，禁止内联脚本。外部链接用 `openExternal` 打开。

侧边 iframe 允许表单事件和 HTML 表单校验，插件可以在 `submit` 监听器中调用 `preventDefault()` 后通过公开 API 执行操作。CSP 的 `form-action 'none'` 继续禁止表单网络提交；表单自身不会获得额外宿主权限。

侧边页面使用独立来源 iframe，持久挂载在界面层；面板插槽提供位置和尺寸，切换页面树不会重建 iframe。弹出窗口使用独立 preload，仅暴露同一组插件 API；页面 DOM 就绪后显示，不等待远程图片等资源，加载不占用插件数据操作队列，DOM 就绪最多等待 30 秒。主界面的 IPC 不向插件页面开放。

## 可选后台

增加 `"backend": "backend.cjs"`，入口导出：

```js
module.exports = {
  async activate(context) {
    // context.pluginId / packageDirectory / dataDirectory
  },
  async call(method, params) {
    if (method === 'example') return { received: params };
    throw new Error('Unknown method');
  },
  async deactivate() {
    // 关闭连接、停止自己创建的子进程并完成落盘。
  }
};
```

三个函数都可省略；调用未提供的 `call` 会返回明确错误。后台按插件共享，宿主按顺序一次派发一个调用。启动和单次调用（含排队）限制为 30 秒，超时终止整个后台并拒绝尚未完成的调用，不自动重试。停止时取消尚未派发的调用，已开始的调用允许完成并返回真实结果，然后调用 `deactivate`；清理函数失败会向停止操作报告错误，阻止当次备份或卸载继续。停止总计最多等待 3 秒，再终止进程。强制终止不保证撤销已发生的外部操作。插件创建的原生子进程由插件负责关闭，宿主不承诺任意后代进程沙箱或托管能力。

后台可使用 Node 能力与自带依赖，具有当前操作系统用户的权限；独立进程用于隔离依赖和故障，不是权限沙箱。插件自行打包 Windows/macOS 所需辅助程序，并在 `deactivate` 中清理。需要原生依赖的插件须自行适配 Electron 的运行时 ABI；纯 JS、WASM 或独立可执行程序可降低这类耦合。

## 验证与后续边界

示例见 `examples/plugins/`。首版先用纯 UI 记事本验证安装、数据持久化和页面保留，再用可选后台示例验证延迟启动、RPC、错误和停止。测试覆盖不兼容清单、损坏包、路径边界、并发写入、排队取消与在途结果、慢资源加载隔离、停用／卸载、备份恢复和真实 Electron 页面通信。

在完成 `npm run build` 后运行 `node scripts/electron-plugins.cjs`，使用临时数据目录验证真实应用，不修改个人配置。

新增宿主接口需有具体插件需求、参数与生命周期约定、可观察的失败行为及测试。插件更新事务及 RDP 等具体插件按实际需求单独评估。
