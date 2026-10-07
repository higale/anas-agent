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
- 可选 `lang` 指定包内语言目录，例如 `"lang": "lang"`；缺失时仍显示清单中的固定名称。
- 可选 `home` 声明首页位置，例如 `"home": { "default_location": "window", "locations": ["window", "sidebar"] }`。`locations` 缺失时为两种位置，`default_location` 缺失时取第一种；整个声明缺失时默认侧边栏。只声明一种位置表示固定首页位置，空列表、重复项或不在列表中的默认值拒绝安装。
- 路径使用 `/`，不得为绝对路径、包含 `..` 或指向包外资源。
- 插件文件最多 10,000 个，总计最多 512 MiB，单个文件最多 128 MiB。包内链接需指向包内普通文件／目录，安装时复制实际内容；循环链接拒绝安装。

点击“安装插件”选择 ZIP 文件或 `PLUGIN.json`。选择清单会复制它所在的整个目录；后续修改源目录不会直接修改已安装插件。ZIP 支持清单位于根目录，或压缩包仅含一个顶层文件夹且清单位于其中；多个候选插件根目录、额外包装层或缺失清单会报错，不自动猜测。

ZIP 原文件最多 512 MiB，解包同时执行上述文件数量、单文件和总大小限制；达到 1 MiB 的条目压缩比最多 1,000 倍。解包流式校验大小、CRC、路径和重复条目，保留普通访问权限及可执行位，不套用应用备份的目录排除规则。失败时清理本次暂存文件，保留原始 ZIP、已安装插件和独立数据。

安装先在应用临时目录暂存、检查，再原子移动到 `plugins/<id>/package/`。同 ID 已安装时拒绝覆盖；卸载后重新安装可用于手动更新。`plugins/<id>/installation.json` 保存 `version: 0` 与 `enabled`，缺失 `enabled` 默认为 `true`。损坏插件单独显示错误，不阻止 Anas 启动或其他插件使用。

插件数据位于 `plugin_data/<id>/`，卸载默认保留数据，重新安装同 ID 后可以继续使用。卸载确认框的「删除插件数据」默认不勾选；明确勾选后同时删除当前插件的数据目录（含插件自行保存的配置及凭据），不删除其他插件数据或已有备份。删除前关闭页面、停止后台并验证目录归属；移动数据失败时回滚插件安装，回滚失败则保留暂存文件并报告位置。应用数据备份包含插件和数据；备份、恢复、进入数据修复、停用、卸载及退出应用会停止后台，恢复不会自动重启插件后台。

## 界面 API

HTML 引入宿主 SDK，业务脚本单独保存：

```html
<script src="/_anas/sdk.js"></script>
<script src="app.js"></script>
```

`window.anas` 提供 Promise API：

```js
const info = await anas.getInfo();
const home = await anas.getHome(); // { location, locations }
await anas.data.set('home_open_location', 'window');
await anas.openHome();
await anas.openView({ instanceId: 'document-123', location: 'sidebar', title: 'Example' });
const value = await anas.data.get('draft'); // 未设置时返回 null
await anas.data.set('draft', { text: 'Hello' });
await anas.openExternal('https://example.com');
const result = await anas.backend.call('example', { value: 1 });
```

`getInfo()` 返回 API 版本、应用版本、插件 ID、当前语言、明暗主题、字号及 `view: { instanceId, location }`。语言是宿主按可用语言包解析后的代码，包含 `system` 的解析结果。设置更新不会重建页面，插件可在聚焦时或以有界频率重新读取，以保留活动连接和输入状态。

### 首页位置

顶部插件菜单与 `openHome()` 使用同一打开流程：从插件自己的 `plugin_data/<id>/state.json` 中读取 `values.home_open_location`，不存在或为 `null` 时取清单默认值；无需加载首页或启动后台来决定位置。「设置 → 插件」选中启用的界面插件后可修改首页打开位置，固定位置时控件只读。该键通过现有 `data.get/set` 读写，无第二份宿主配置，卸载默认保留、备份恢复包含。值只能是清单允许的 `sidebar`、`window` 或恢复默认的 `null`；无效值报错并保留原文件，不擅自重置。`getHome()` 返回实际位置及允许的位置列表，插件首页无需提供重复设置控件。

设置保存仅影响下次打开首页；已有页面不关闭、不迁移、不丢弃表单。`openHome()` 固定打开 `main` 实例，在选定位置复用已有页面。宿主设置中的显式侧边栏／窗口按钮不修改偏好，也受清单允许的位置约束；`openView({ instanceId: 'main', ... })` 遵守同样约束。其他实例的位置仍由插件独立指定，不受首页策略限制。停用、卸载及恢复继续回收所有实例。`getHome()`、`openHome()` 是 API 1 新增接口，依赖它们的插件须检测旧宿主并提示升级。

### 多语言

声明 `"lang": "lang"` 后，宿主读取该包内目录的 `<语言代码>.json`。格式与 Anas 相同：`version: 0`、`_meta: { name, author? }`、嵌套翻译键和 i18next 的 `{{变量}}` 占位符。`plugin.name`（最多 120 字符）和 `plugin.description`（最多 2,000 字符）用于宿主菜单、设置和默认标题；未提供时逐项回退英文，再回退清单文本。显式 `openView` 标题为用户内容，不翻译。

```js
const { resources, errors } = await anas.getLanguageResources();
// resources: { en: { version: 0, _meta: { name: 'English' }, ... }, ... }
// 使用插件自己的 i18next 实例；不要导入宿主内部模块。
```

此 API 1 新增接口只返回当前启用插件的资源，不暴露宿主或其他插件的内容。旧宿主需检查 `typeof anas.getLanguageResources`。宿主不执行语言文件，不把翻译注入 HTML。语言选择按完整代码（不区分大小写）、同基础代码、英文回退；插件使用 i18next 的 `fallbackLng: 'en'`、`returnEmptyString: false` 逐项回退。

可选语种只由宿主内置及宿主数据目录 `lang/` 中的语言包决定，插件不能增加语言选项。用户在 ZIP 内新增或修改插件 `lang/` 文件，重打包后安装；插件匹配宿主当前语言，缺失翻译回退英文。宿主没有的语种不显示、不能选择，须先向宿主添加对应语言包并重新打开 Anas。语言是包的一部分，卸载重装不保留或合并旧翻译，无独立覆盖目录；完整数据备份照常包含插件包。

每插件最多 128 个语言 JSON，单文件 128 KiB，总计 512 KiB；语言文件名使用字母开头的字母、数字及短横线代码。资源路径须留在包内。损坏 JSON、未知格式或重复语种会在插件设置中报告，合法语言继续使用；目录或总量错误则拒绝加载该目录。原文件不修改，语言错误不阻止停用或卸载。

`openView()` 只打开当前插件的 UI，`location` 为 `sidebar` 或 `window`；`instanceId` 必填，允许 1–80 位英文字母、数字、下划线和短横线；可选 `title` 为最多 120 字符的非空标题。插件可把自己的配置 ID 用作页面实例 ID，通过 `getInfo().view` 读取。实例 ID 出现在页面 URL，不应放密码或其他秘密。默认菜单页面使用 `main`。此接口是 API 1 的新增能力；依赖它的插件应检查 `typeof anas.openView` 并提示旧宿主升级。

同一插件、打开位置和实例 ID 重复打开时聚焦已有页面，保留内存和连接；不同位置是独立页面，不迁移会话。插件每种位置的 `main` 仍兼容原菜单入口。独立窗口每插件最多 32 个；侧边调用完成表示已向主界面发送打开请求，窗口调用完成表示 DOM 已就绪，均不保证插件业务初始化完成。停用、卸载、恢复和宿主关闭会回收所有实例。插件自行决定是否自动执行连接等业务操作。

数据键最长 80 个字符，允许字母、数字、点、下划线和短横线；数据为 JSON，单个插件的数据文件最多 1 MiB。写入按顺序原子保存。不存在的键使用 `null`，有效的 `false`、`0`、空字符串和空数组原样保留。

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
