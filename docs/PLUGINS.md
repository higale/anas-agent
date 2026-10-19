# Anas 插件

## 范围与设计

插件用于独立开发、按需安装的界面和辅助功能。参考 [VS Code 的扩展入口与 Webview](https://code.visualstudio.com/api/extension-guides/webview)及 [Obsidian 的小型插件包](https://github.com/obsidianmd/obsidian-sample-plugin)，由 Anas 提供自己的有限宿主接口，不引入整套 IDE 框架。

提供：从 ZIP 或 `PLUGIN.json` 安装、启用／停用、卸载、工作区菜单与可选标题栏快捷入口、侧边面板、独立窗口、独立数据和可选 Node 后台。插件包必须是已构建的产物，不在用户机器上执行 npm 安装或编译。插件市场、自动更新、任意位置 UI 注入不在本版范围内。可选工具通过清单显式声明，按项目或子 Agent 的有效能力选择提供给模型。

UI、后台、技能和静态提示词均可选，至少提供一种。纯 UI 插件不创建后台进程；后台首次启动或调用时才创建独立 Electron utility process。插件不导入 Anas 内部 React 模块，也不建立另一套 Agent 执行循环。插件工具复用现有能力选择、托管执行和效果恢复；未定制项目使用所有已启用插件的可用贡献，定制项目按各插件的全部／定制／关闭模式选择。技能及静态提示词直接读取包内文件；通用设置由清单声明并在宿主设置页编辑。

设置 → 插件的概览按提示词、技能、工具分组展示，悬停名称查看简介，点击打开可复制的只读详情。技能名称和简介复用扫描时读取的 `SKILL.md` 元数据，提示词及技能正文由宿主按声明标识读取包内文件；停用插件也可预览，不启动后台。工具显示模型实际使用的名称、描述和输入参数，并列出操作类型及超时。预览不改变能力选择，也不改变插件清单或配置格式。

侧边面板收起、切换标签、进入设置及切换会话保留已有 iframe。同一窗口不搬动 iframe 节点；跨窗口创建新页面，通过异步交接恢复界面状态。连接、任务和数据由后台或原服务持有，关闭展示页面不应无条件结束业务资源。详见[面板框架](PANEL_FRAMEWORK.md)。

## 插件包

根目录必须包含 `PLUGIN.json`：

```json
{
  "version": 0,
  "id": "example-notepad",
  "name": "Notepad",
  "plugin_version": "0.1.0",
  "api_version": 2,
  "description": "A small persistent notepad.",
  "ui": "index.html"
}
```

- `version` 是清单格式版本，目前为 `0`；`plugin_version` 是插件自己的三段版本号。
- `id` 使用小写字母、数字和单个短横线，必须以字母开头，不使用 Windows 保留名称。
- `api_version` 必须为 `2`，不兼容时显示原因，不运行插件。API 2 要求页面主动获取上下文、登记生命周期并确认就绪；不会把 API 1 插件自动改写为新协议。
- `ui` 为包内 HTML 相对路径；`backend` 为可选的包内 `.cjs` 相对路径。
- 可选 `platforms` 为 `win32`、`darwin`、`linux` 的数组；缺失表示所有平台。
- 可选 `lang` 指定包内语言目录，例如 `"lang": "lang"`；缺失时仍显示清单中的固定名称。
- 可选 `icon` 指定包内 SVG、PNG 或 WebP，例如 `"icon": "assets/icon.svg"`；也可用 `{ "light": "assets/light.svg", "dark": "assets/dark.svg" }` 分别适配明暗主题。每张图标最多 256 KiB，建议 SVG 使用 `viewBox` 和明确颜色；以图片显示，不继承宿主 `currentColor`。
- 可选 `home` 声明首页位置，例如 `"home": { "default_location": "window", "locations": ["window", "sidebar"] }`。`locations` 缺失时为两种位置，`default_location` 缺失时取第一种；整个声明缺失时默认侧边栏。只声明一种位置表示固定首页位置，空列表、重复项或不在列表中的默认值拒绝安装。
- 路径使用 `/`，不得为绝对路径、包含 `..` 或指向包外资源。
- 插件文件最多 10,000 个，总计最多 512 MiB，单个文件最多 128 MiB。包内链接需指向包内普通文件／目录，安装时复制实际内容；循环链接拒绝安装。

点击“安装插件”，默认筛选 ZIP 文件；安装 `PLUGIN.json` 时切换到插件清单筛选项。对话框标题和筛选名称跟随应用语言。也可将一个 ZIP、`PLUGIN.json` 或插件目录拖入插件页的列表或详情区域；目录须在根部包含 `PLUGIN.json`，不向下搜索。拖拽与按钮共用校验、覆盖确认和清理流程，安装或确认期间不接收新的安装。选择清单或拖入目录会复制整个插件目录；后续修改源目录不会直接修改已安装插件。ZIP 支持清单位于根目录，或压缩包仅含一个顶层文件夹且清单位于其中；多个候选插件根目录、额外包装层或缺失清单会报错，不自动猜测。

ZIP 原文件最多 512 MiB，解包同时执行上述文件数量、单文件和总大小限制；达到 1 MiB 的条目压缩比最多 1,000 倍。解包流式校验大小、CRC、路径和重复条目，保留普通访问权限及可执行位，不套用应用备份的目录排除规则。失败时清理本次暂存文件，保留原始 ZIP、已安装插件和独立数据。

安装先在应用临时目录暂存、检查，再原子移动到 `plugins/<id>/`。同 ID 已安装时，先校验并暂存完整新包，再显示覆盖确认、新旧版本与默认不勾选的「删除插件数据」。取消保留现有页面、后台和数据；确认后关闭该插件页面、停止后台，保留启用状态和标题栏图标设置并原子替换，勾选删除数据也保留这两项安装设置。默认保留独立数据，明确勾选才清除；失败回滚旧包、安装设置与数据。替换事务在移动旧文件前转入 `plugins/.replace-<token>/`，卸载事务使用 `plugins/.remove-<随机ID>/`，均不放入可清理的 `tmp/` 或 `cache/`。确认只作用于暂存的新包及当时看到的安装实例，安装状态变化后须重新选择；同版本和降级也需要相同确认。损坏插件单独显示错误，不阻止 Anas 启动或其他插件使用。

内置和用户插件的安装状态统一保存为 `db/plugins/<id>/anas-installation.json`，内容为 `version: 0`、`enabled` 和可选的 `show_in_titlebar`；文件或配置字段缺失时分别默认启用、隐藏独立启动图标。经用户批准，旧 `plugins/<id>/installation.json` 不读取、不自动迁移；旧 `plugins/<id>/package/` 布局也不迁移或回退读取，已有用户插件需重新覆盖安装。覆盖时默认保留 `db/plugins/<id>/` 中的业务数据、通用设置及首页位置，新安装状态文件缺失时采用默认值。旧安装目录不自动删除，由覆盖安装或卸载整体处理；恢复包含旧路径的受支持备份也遵循此规则。内置插件原本就没有 `package/` 层级，不受此布局调整影响。

替换和卸载共用显式 v0 事务日志，记录插件 ID、操作类型、完成状态和每次文件或目录移动的意图及进度，路径由当前数据根目录解析。可选 `installation` 字段声明安装状态的创建、替换、移除或随数据重建；未包含该字段的 v0 事务仍按原目录移动记录恢复。准备目录先在 `tmp/` 写好初始日志，再整体移入上述事务目录，之后才移动现有包、安装设置或数据；初次写日志中断不会留下无法识别的持久事务。应用启动、备份恢复后，在开放插件前处理残留：未提交事务回滚旧包、安装设置与数据，已提交事务仅继续清理，回滚完成后清理暂存。清理时最后删除日志，防止部分清理被误判为未提交。回滚失败、目录冲突、链接目录或无法识别的日志保留原文件，并通过现有启动恢复界面报告位置；不按目录年龄删除、不猜测旧残留的状态、不新增旧格式迁移。当前进程发生未解决的回滚失败时，相关插件不能继续使用；解决冲突后重试操作或重启恢复。

插件数据位于 `db/plugins/<id>/`，卸载默认保留业务数据、通用设置及首页位置，重新安装同 ID 后可以继续使用；安装状态文件始终随卸载删除，因此重新安装采用默认启用状态和标题栏图标设置。卸载确认框的「删除插件数据」默认不勾选；明确勾选后同时删除当前插件的数据目录（含插件自行保存的配置及凭据），不删除其他插件数据或已有备份。删除前关闭页面、停止后台并验证目录归属；移动数据失败时回滚插件安装，回滚失败则保留暂存文件并报告位置。应用数据备份包含插件和数据；备份、恢复、进入数据修复、停用、卸载及退出应用会停止后台，恢复不会自动重启插件后台。

## 界面 API

### 内置插件与侧栏展示

启动时将随应用分发的 `data/plugins/_system/` 同步到应用数据目录的 `plugins/_system/`，内置插件从此处加载，使用同一后台和展示协议；默认启用，可在设置中停用，不可卸载或被同 ID 外部包覆盖。该目录由应用维护，手动修改会在下次启动或恢复备份时被随包内容覆盖。安装状态与其他插件一样保存在 `db/plugins/<id>/anas-installation.json`，不随代码刷新重置。恢复备份时重新同步当前随包内容，缺少系统或示例目录的受支持旧备份也能正常恢复，无需配置迁移，也不启动插件后台。

清单可声明最多 8 个 `widgets`，当前位置为 `sidebar.footer`（设置入口上方）。展示项需有后台，例：

```json
"widgets": [{
  "id": "quota", "location": "sidebar.footer", "handler": "quota",
  "actions": ["refresh"], "model_hosts": ["api.minimaxi.com"]
}]
```

`model_hosts` 可省略；填写时按当前输入框所选模型 API URL 的完整 hostname 匹配，无通配符或后缀猜测，不匹配则隐藏且不启动后台。它是适用性声明，不是网络权限限制。供应商协议解析和业务语义由插件负责。`actions` 声明可调用的操作 ID（最多 8 个），默认空。

宿主调用后台 `call(handler, { language, action, model }, context)`。自动读取的 `action` 为 `null`，按钮点击传对应 ID。`model` 为 `null` 或 `{ id, model, providerId, providerName, baseUrl, apiKey }`；主进程依据已配置模型 ID 解析连接信息，不接受渲染进程提供的凭据。此上下文只用于展示查询，不增加工具的对话身份。插件不得把凭据写入返回内容、错误或日志。

返回 `null` 隐藏，或返回 HTML 展示快照。插件决定内容和布局，宿主提供公共 CSS、主题、字号及操作桥接：

```js
return {
  title: 'MiniMax Token Plan', // 展示区域的无障碍名称
  html: `<div class="ui-stack ui-stack-tight">
    <header class="ui-row-between">
      <span>MiniMax Token Plan</span>
      <button class="ui-tool-button ui-tool-button-small"
        data-action="refresh" aria-label="立即刷新" title="立即刷新">
        <img class="ui-busy-icon" src="assets/refresh.svg" alt="">
      </button>
    </header>
    <section title="重置时间：2026/10/15 20:00">
      <div class="ui-row-between"><span>5 小时额度剩余</span><span class="ui-numeric">68%</span></div>
      <progress aria-label="5 小时额度剩余" max="1" value="0.68"></progress>
      <small class="ui-field-hint">约 1 小时后重置</small>
    </section>
  </div>`
};
```

- `title` 必填，最多 160 字符；`html` 为非空 HTML 片段，最多 64 KiB、1000 个元素。数据中的文字和属性值由插件按 HTML 上下文转义，不直接拼入接口返回的原始字符串。
- 宿主在 Shadow DOM 中加载共享 `base.css`、`ui-primitives.css` 与锚点基础样式，继承主题变量和字号。内容可使用分组、列表、表格、`details`、`progress` 等标准 HTML 自由组合；不再使用固定的 `lines` / `actions` 展示数据结构。外部 CSS 不影响片段内部，片段不影响宿主其他区域。区域最高为窗口高度的 50%，超出可滚动。
- HTML 仅描述静态展示和原生交互。自定义 CSS（`style` 属性、`style` / `link` 元素、旧式颜色属性）、脚本、事件属性、自定义元素、嵌入页面和表单导航不属于锚点协议；不符合规范时明确报错并保留上一份有效展示，不静默剥除内容。需要独立脚本的完整页面继续使用插件 `ui` 入口。
- 常用布局类为 `ui-stack` / `ui-stack-tight`、`ui-row` / `ui-row-between`、`ui-grid-2` / `ui-grid-3`；文字类为 `ui-truncate`、`ui-muted`、`ui-field-hint`、`ui-numeric`。按钮复用 `ui-button`、`ui-icon-button`、`ui-tool-button`，普通按钮默认补上 `ui-button`，遵循 `--control-height`。内嵌图标操作可用 `ui-tool-button-small`。原生 `progress` 和表格由宿主统一着色和排版。
- 按钮用 `data-action="操作 ID"`，必须在清单 `actions` 中声明；点击或键盘激活后仍调用原 handler，并传 `action`。宿主在请求期间禁用操作，保留插件声明的 `disabled`；可给图标加 `ui-busy-icon` 显示加载旋转，遵循减少动画设置。按钮没有额外参数，业务状态仍由后台校验。
- 紧凑文字可使用 `ui-adaptive-text` 容器，直接子元素分别标记 `data-full-text` 和 `data-short-text`，提供完整与简短文本。宿主按实际溢出、容器尺寸和字号变化选择版本；可见版本同步无障碍状态。插件决定哪些信息可缩短，例如用量仪表只省略套餐周期标签，保留余额币种。
- `img src` 使用包内 SVG / PNG / WebP 相对路径，宿主复用插件图标资源路由解析。文字提示使用 `title` 或 `data-tooltip`，宿主统一转换为支持多行的共享悬停提示，也支持键盘聚焦。`a href` 支持 HTTP、HTTPS、mailto，点击通过已有宿主外部链接接口打开，不导航主界面。
- 可复制的详情使用 `data-details` 按钮，例如 `<button class="ui-link-button ui-field-hint-link" data-details="状态: 有效&#10;自动续费: 关闭">详情</button>`；也可使用单个包内 `img` 作为图标，此时按钮必须提供非空 `aria-label`。悬停预览，点击或键盘激活后固定浮层，再次点击、点击外部或按 Esc 关闭；浮层沿用宿主主题、字号和窗口边界。详情是非空纯文本，不能同时声明 `data-action`、`title` 或 `data-tooltip`；不调用后台，不受后台请求中的临时禁用影响，但保留按钮自身的 `disabled`。内容更新或组件移除时关闭旧浮层。
- 业务错误、更新时间、套餐信息等均由插件写入 HTML，自由选择位置和结构；宿主只显示调用失败或 HTML 规范错误。模板自行标注标题、进度、按钮名称等无障碍语义。停用、切换上下文或关闭展示后，旧回执不再挂载。

可见展示项匹配当前 URL 后立即显示插件名称和加载状态，首次读取时按需启动后台；同一上下文刷新保留原内容，切换模型或凭据时清除旧内容并显示加载状态。后台明确返回 null 后隐藏，后续轮询不反复显示占位。每分钟读取一次，恢复窗口可见性或焦点时再读取；插件决定缓存期限、请求去重和失败退避。操作也返回新快照。隐藏、进入设置或切换上下文后不再应用旧回执，插件在途工作仍须有界并响应取消。展示调用允许并发，不能依赖普通页面 RPC 的顺序。停用、手动停止、后台崩溃及数据关闭后不会被展示轮询重新拉起；可在插件设置中重新启动后台或重新启用。应用重启后按启用状态重新按需加载。

内置 `usage-meter` 识别 MiniMax 官方 API 主机，查询相应地区的 Token Plan 额度，缓存 5 分钟；立即刷新绕过缓存，同一供应商与凭据的在途请求合并，切换模型复用缓存。优先使用接口明确返回的剩余百分比；仅有旧计数字段时按剩余数量处理，零总量不伪造百分比。显示套餐的 `general` 通用额度，兼容旧套餐以 `MiniMax-M*` 命名的共享额度；不按当前模型匹配，不以 `video` 等独立分组代替通用额度。分别显示“5h 限额”和“周限额”，主读数显示剩余额度，进度条表示剩余占实际总额度的比例。周额度按 `weekly_boost_permille` 计入加成：例如加成为 1500、剩余比例为 99% 时，主读数为 148.5%，详情中总额度为 150%、已用为 1.5%；缺少加成字段时总额度为 100%。读数来自公开的 `/v1/token_plan/remains`，不接入官网未公开的展示接口；上游百分比精度可能造成与官网的小幅差异。接口本次起止区间即使较短，也不改变类别名称。重置时间与倒计时仍按接口返回的结束时间计算。默认紧凑显示，一行显示剩余额度、刷新和展开按钮，悬停查看供应商、重置时间及更新时间；点击仪表内的箭头切换详细显示，展示进度条和可见倒计时。样式选择由插件自行原子保存到其数据目录的 `display.json`（`version: 0`、`display_mode: compact | detailed`），缺省为 `compact`；不在设置页声明显示样式字段。切换样式读取同一额度缓存，不额外请求接口；每次读取缓存也重算倒计时，已结束的窗口标记待刷新，不假定额度已恢复。当前接口未提供套餐到期日，不能将额度重置时间当作套餐到期时间。查询限时 15 秒、响应上限 1 MiB；错误保留成功读数并退避，凭据变化使用新缓存。MiniMax 普通按量密钥或没有对应额度的套餐可能返回错误；MiniMax 适配不提供账户余额查询。

智谱 / Z.ai 适配同时核对官方域名（`open.bigmodel.cn` / `api.z.ai`）与路径（`/api/coding/paas/v4` / `/api/anthropic`，允许末尾斜线），再查询套餐状态；普通 `/api/paas/v4` 不发出套餐查询；国内智谱转为账户余额查询，国际普通 API 与其他路径隐藏，即使同一 Key 已有缓存套餐额度也不展示。[官方接入说明](https://zcode.z.ai/en/docs/configuration)区分套餐与普通 API 的调用路径；Anthropic 路径仍需服务端确认套餐，不能仅凭 Key 格式或账户有套餐推断当前调用的计费方式。遵循[官方查询脚本](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs)，向对应站点的 `GET /api/monitor/usage/quota/limit` 发送原始 API Key（`Authorization` 不加 `Bearer`）。按[官方用量页面](https://bigmodel.cn/coding-plan/personal/usage)的字段含义解析：`percentage` 是已用百分比，显示时换算为剩余；`CREDIT_LIMIT` 为积分套餐，`TOKENS_LIMIT` 为旧套餐模型额度，`TIME_LIMIT` 为旧套餐独立 MCP 月额度。使用官方周期标识（`unit` 3 / 6 / 5 分别对应 5 小时 / 每周 / MCP 每月），有 `number` 时核对周期；优先采用积分套餐，避免把旧套餐额度混入。重置时间只取有效的 `nextResetTime` 毫秒时间戳，缺失时不推算。复用缓存、刷新、错误保留读数和中英文紧凑／详细显示；未开通套餐明确提示，不伪造余额或零额度。当前配置账户已实测“无套餐”响应；成功额度及国际站已用按官方字段构造的样本验证，尚无有套餐账户的成功实测。

智谱国内普通 API（`open.bigmodel.cn/api/paas/v4`，允许末尾斜线）使用 `GET https://open.bigmodel.cn/api/biz/account/query-customer-account-report`，`Authorization` 为原始 API Key，无需控制台登录。该接口来自[官方控制台前端](https://static.bigmodel.cn/wd-paas-front/js/app.808381fa.js)，已用当前普通 Key 实测成功，但未查到公开接口契约；国际站未验证，不复用国内接口或假设其币种。主读数取 `availableBalance`（CNY），详情按实际返回显示 `rechargeAmount`、`totalSpendAmount`、`frozenBalance`；不四舍五入为两位小数，缺失或 null 的详情字段不伪造为零，主读数缺失或金额格式异常视为错误并保留上次成功读数。账户余额不含资源包和 Coding Plan 额度，不以零余额推断模型不可用。余额与套餐按查询 URL 分别缓存，切换路径不串用；共享刷新、限时、失败退避和本地化显示。

百炼适配器位于 `data/plugins/_system/usage-meter/bailian.cjs`，通过本机 `bl` 的 JSON 输出查询中国站账户身份、Key 和用量；浏览器登录由插件按钮显式启动，后台独立管理并支持取消。Token Plan 使用 `/tokenplan/personal/api/v2/usage` 原始结果保留月度字段，Key 首尾匹配后才展示；剩余百分比在紧凑、详细及悬停视图统一显示两位小数，进度保留原始比例。普通 Key 详情完整匹配后限定工作空间和 Key ID 查询统计。账户身份在读取缓存前和新查询后核对；登录后清空缓存，错误不保留百炼读数。仅返回展示字段，不输出 CLI 原始错误、会话信息或完整 Key。

用量仪表展开视图优先显示主要读数和重置时间，悬停或键盘聚焦标题可查看完整详情；与紧凑视图读数的提示共用同一份内容，不另设详情图标或更新时间行。提示包含供应商、读数、重置时间、最后成功更新时间，以及接口返回的附加资料：百炼的账户、工作空间、套餐资料和普通 API 用量明细，余额类的余额构成和消费明细，MiniMax 的总额度、已用和加成说明等。查询失败、明确的余额不足及百炼套餐已失效等异常仍直接显示。悬停不新增请求，未返回字段不补造。

用量仪表同时支持以下官方接口，按 API URL 的精确主机名识别，复用所选供应商密钥。共享缓存、刷新、取消与错误保留机制；金额展示不渲染额度进度条，不跨币种相加，也不把无上限解释成账户有余额。

| 厂商 | API 主机与查询路径 | 展示内容 |
| --- | --- | --- |
| [DeepSeek](https://api-docs.deepseek.com/api/get-user-balance/) | `api.deepseek.com/user/balance` | 各币种可用余额、未过期赠金、充值余额；保留金额字符串精度，按 `is_available` 提示不可调用。 |
| [Moonshot/Kimi 国内](https://platform.kimi.com/docs/api/balance) / [国际](https://platform.kimi.ai/docs/api/balance) | `api.moonshot.cn` / `api.moonshot.ai` 的 `/v1/users/me/balance` | 可用、代金券、现金余额；国内 CNY、国际 USD。直接使用可用余额字段，现金为负时不自行重算。 |
| [OpenRouter](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key) | `openrouter.ai/api/v1/key` | 当前密钥额度、累计及 UTC 日／周／月消费、额度重置周期、接口提供的密钥到期时间。仅表示密钥级数据；不调用要求管理密钥的 `/credits`。 |

设置概览中的支持厂商列表复用插件已有的本地化 `plugin.description`，宿主通用描述保留换行，不添加厂商专用设置或配置字段。内置说明同时维护中文和英文。

接口核验（2026-10-15）：[硅基流动公告](https://docs.siliconflow.cn/docs/release-notes/overview)说明 `/user/info` 已于 2026-08-14 停用，因此未接入该旧接口；需要独立管理凭据或未确认官方查询协议的供应商不列为已支持。

接口参考：[MiniMax 官方查询说明](https://platform.minimaxi.com/subscribe/coding-plan)、[官方 CLI 额度语义](https://github.com/MiniMax-AI/cli/blob/main/src/utils/quota.ts)。

验证：`npm run test:e2e -- --plugin-widgets-only` 使用临时数据目录与受控 HTTP 响应运行真实内置后台，检查展示位置、刷新、失败保留、备份及启停；截图写入忽略的 `tmp/plugin-widgets/`。该测试不代表真实账户额度核验。

### 页面 SDK

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
await anas.moveView('window'); // 移动当前页面
await anas.moveView({ location: 'sidebar', instanceId: 'document-123' }); // 移动本插件已打开的指定实例
await anas.closeView({ instanceId: 'document-123' }); // 关闭本插件指定实例；不存在时无需操作
const unsubscribe = anas.onViewChanged(({ instanceId, location }) => { /* 更新位置相关业务 */ });
const value = await anas.data.get('draft'); // 未设置时返回 null
await anas.data.set('draft', { text: 'Hello' });
await anas.openExternal('https://example.com');
const result = await anas.backend.call('example', { value: 1 });
```

`await anas.resizeWindow({ width, height })` 按 CSS 像素申请当前插件页面的可用尺寸，宿主补齐标题栏、按应用缩放换算，并通过 Electron 内容区尺寸接口调整原生窗口，不反推边框大小。活动独立窗口及正在准备的目标独立窗口可用；目标在 `activate` 完成前保持隐藏，可先恢复布局再展示。侧栏、交接中的源页面及已关闭页面拒绝；尺寸允许超过当前显示器，定位时保持标题栏可触达，默认保留最大化／全屏状态；用户明确点击适配操作时可传 `restore: true`，等待退出全屏／最大化后调整，页面已关闭或不再是当前活动／准备目标时拒绝继续。可用 `restorePlacement: { displayId, x, y }` 同时恢复位置：`x/y` 是相对该显示器工作区左上角的 DIP 偏移，不随应用缩放。目标显示器仍在时按其新工作区恢复；已断开时定位到当前显示器并保留申请尺寸。拖出标签时鼠标指定的位置优先于该恢复提示。未指定恢复位置的新窗口从主窗口所在显示器打开。它不改变后台资源，也不持续锁定窗口大小。 macOS 独立面板在原生拖动结束时阻止系统恢复旧屏幕尺寸，同一原生事件的重复缩放请求一并处理；新的键鼠操作、窗口模式及显示器配置变化使该判定失效，正常手动缩放和平铺仍由系统处理。此策略只读公开原生状态，复用现有依赖，不要求额外的辅助功能或输入监控授权。

独立窗口的 `getContext().windowMode` 为 `normal`、`maximized` 或 `fullscreen`；侧栏不提供该字段。`getContext().windowPlacement` 提供普通窗口的显示器及位置。`getContext().viewport` 是宿主父文档分配给插件的页面内容区域 `{ width, height }`（CSS 像素，保留小数，不含宿主标题栏，隐藏时可为 0），不取 iframe 内部可能尚未完成 DPI 更新的尺寸。`windowResizeRevision` 是独立窗口内递增的用户尺寸操作编号：用户完成拖动边框或切换最大化／全屏状态时递增；移动、DPI／布局通知以及 `resizeWindow` 引发的调整不递增。`onViewChanged` 同样携带 `windowMode/windowPlacement/windowResizeRevision/viewport`，任一变化时通知。需要自适应内容的插件应以用户尺寸操作为触发，不能把每次视口测量变化都当作用户调整窗口；原生窗口的整数取整也不应反向修改插件指定的内容尺寸。宿主只报告事实、不持久化插件窗口状态；插件自行管理尺寸、位置记录、恢复和清理。需要从子页面测量内部布局时，应先确认 `innerWidth/innerHeight` 与宿主视口一致，再派发依赖该布局的操作。

`getInfo()` 返回 API 版本、应用版本、插件 ID、当前语言、明暗主题、字号及 `view: { instanceId, location }`。语言是宿主按可用语言包解析后的代码，包含 `system` 的解析结果。设置更新不会重建页面，插件可在聚焦时或以有界频率重新读取，以保留活动连接和输入状态。

### 首页位置

顶部“工作区菜单”按当前项目和插件分组：项目组提供文件改动，插件组只列出已启用且声明 `ui` 的有效插件。插件组标题右侧的齿轮打开插件设置；没有可打开首页时仍保留标题和齿轮。无首页的工具、技能和提示词插件在设置页管理，贡献按有效能力选择提供，工具调用按需启动后台；点击启动菜单不会代替“启动后台”操作。

工作区菜单中的插件条目、独立启动图标与 `openHome()` 使用同一打开流程：从插件自己的 `db/plugins/<id>/state.json` 中读取 `values.home_open_location`，不存在或为 `null` 时取清单默认值；无需加载首页或启动后台来决定位置。「设置 → 插件」选中界面插件后可修改首页打开位置，停用时仍可查看和保存，固定位置时控件只读。该键通过现有 `data.get/set` 读写，无第二份宿主配置，卸载默认保留、备份恢复包含。值只能是清单允许的 `sidebar`、`window` 或恢复默认的 `null`；无效值报错并保留原文件，不擅自重置。`getHome()` 返回实际位置及允许的位置列表，插件首页无需提供重复设置控件。

每个插件最多保留一份 `main` 首页，与侧边栏／独立窗口位置无关。工作区菜单、独立启动图标、`openHome()` 及 `openView({ instanceId: 'main', ... })` 均显示并聚焦已有首页，保留当前位置、连接和表单；关闭首页后，才按本次请求的位置创建。首页位置设置仅决定下次创建的位置，不迁移已有页面。`openView({ instanceId: 'main', ... })` 也受清单允许的位置约束。设置页可配置首页打开位置，以及默认关闭的“在标题栏显示启动图标”。开启后在主窗口工作区菜单旁显示快捷图标，仍使用同一首页打开流程。停用时隐藏快捷图标但保留选择；覆盖安装保留选择，卸载移除安装设置。窗口宽度不足时，放不下的快捷图标收回工作区菜单，菜单中的完整插件列表始终保留。其他实例的位置仍由插件独立指定，不受首页策略限制。停用、卸载及恢复继续回收所有实例。

### 多语言

声明 `"lang": "lang"` 后，宿主读取该包内目录的 `<语言代码>.json`。格式与 Anas 相同：`version: 0`、`_meta: { name, author? }`、嵌套翻译键和 i18next 的 `{{变量}}` 占位符。`plugin.name`（最多 120 字符）和 `plugin.description`（最多 2,000 字符）用于宿主菜单、设置和默认标题；未提供时逐项回退英文，再回退清单文本。显式 `openView` 标题为用户内容，不翻译。

```js
const { resources, errors } = await anas.getLanguageResources();
// resources: { en: { version: 0, _meta: { name: 'English' }, ... }, ... }
// 使用插件自己的 i18next 实例；不要导入宿主内部模块。
```

此接口只返回当前启用插件的资源，不暴露宿主或其他插件的内容。宿主不执行语言文件，不把翻译注入 HTML。语言选择按完整代码（不区分大小写）、同基础代码、英文回退；插件使用 i18next 的 `fallbackLng: 'en'`、`returnEmptyString: false` 逐项回退。

可选语种只由宿主内置及宿主数据目录 `lang/` 中的语言包决定，插件不能增加语言选项。用户在 ZIP 内新增或修改插件 `lang/` 文件，重打包后安装；插件匹配宿主当前语言，缺失翻译回退英文。宿主没有的语种不显示、不能选择，须先向宿主添加对应语言包并重新打开 Anas。语言是包的一部分，卸载重装不保留或合并旧翻译，无独立覆盖目录；完整数据备份照常包含插件包。

每插件最多 128 个语言 JSON，单文件 128 KiB，总计 512 KiB；语言文件名使用字母开头的字母、数字及短横线代码。资源路径须留在包内。损坏 JSON、未知格式或重复语种会在插件设置中报告，合法语言继续使用；目录或总量错误则拒绝加载该目录。原文件不修改，语言错误不阻止停用或卸载。

`openView()` 只打开当前插件的 UI，`location` 为 `sidebar` 或 `window`；`instanceId` 必填，允许 1–80 位英文字母、数字、下划线和短横线；可选 `title` 为最多 120 字符的非空标题。插件可把自己的配置 ID 用作页面实例 ID，通过 `getInfo().view` 读取。实例 ID 出现在页面 URL，不应放密码或其他秘密。默认菜单页面使用 `main`。

`openView({ instanceId, location, title, icon: 'assets/desktop.svg' })` 可覆盖该页面图标，格式与清单 `icon` 相同；未提供时使用清单默认图标。图标用于工作区菜单、独立启动图标、设置列表、首页／业务标签及独立窗口标题栏，跨窗口交接时保留，不放入插件 `restoreState`，也不修改操作系统任务栏图标。未配置时使用拼图图标；文件缺失、超限或无法解码时回退拼图并显示失败提示，清单图标的加载问题同时显示在插件设置中。图标资源独立于页面和后台，通过仅提供上述图片格式的 `anas-plugin://<id>/_anas/icon/` 读取，停用的插件仍可显示；其他页面资源仍要求插件启用。

`moveView(location)` 移动当前页面；`moveView({ location, instanceId })` 指定实例时，仅能移动本插件已打开的页面。目标不存在、已关闭或位置不受支持时明确失败，不创建替代页面；移动失败保留原页面及业务状态。

`closeView({ instanceId })` 按明确实例 ID 关闭本插件页面，等待 `dispose(closed)` 完成；不存在时成功返回，关闭失败保留可重试页面。并发关闭同一实例等待同一结果。工具栏 action 独立于串行的 prepare／activate／resume／dispose 调度，可以等待自身关闭；成功关闭或移动销毁原页面时，其 UI action 回执按页面退出结束，不误报操作失败。关闭未完成时再次打开同一实例，会先等待关闭再重新创建；关闭失败则向打开方报告失败，保留原页面。页面关闭是否结束业务连接由插件决定。

所有实例按插件 ID 和 instanceId 跨位置复用；需要独立业务实例时使用不同 instanceId。每插件最多 64 个面板，应用最多 32 个独立面板窗口。调用完成表示页面已确认恢复并激活。

数据键最长 80 个字符，允许字母、数字、点、下划线和短横线；数据为 JSON，单个插件的数据文件最多 1 MiB。写入按顺序原子保存。不存在的键使用 `null`，有效的 `false`、`0`、空字符串和空数组原样保留。

页面使用独立的 `anas-plugin://<id>/` 来源，通过专用消息接口访问宿主，没有 `window.gale`、Node 或任意文件读取接口。页面可以请求网络；允许 WASM、包内脚本和样式，禁止内联脚本。外部链接用 `openExternal` 打开。

插件页面允许表单事件和 HTML 表单校验，插件可以在 `submit` 监听器中调用 `preventDefault()` 后通过公开 API 执行操作。CSP 的 `form-action 'none'` 继续禁止表单网络提交；表单自身不会获得额外宿主权限。

### 页面交接

宿主创建页面与窗口，插件接入自身资源并保存、恢复界面状态。页面首先主动获取完整上下文，再显式确认就绪；不能依赖一次位置通知完成初始化。

```js
const page = await anas.getContext();
// panelId、pageId、location、phase、transferId、restoreState、view
await restoreInterface(page.restoreState);
await attachExistingResources(page.restoreState); // 不重新认证或重新创建任务
anas.registerLifecycle({
  async prepare({ signal, targetPageId }) {
    await finishPendingEdits(signal);
    return captureInterface(); // 有界 JSON，可包含草稿和稳定资源引用
  },
  async activate({ signal }) { await acquireInput(signal); },
  async resume({ signal }) { await reacquireInput(signal); },
  async dispose({ reason, signal }) {
    await releasePresentation(signal); // moved 或 closed；不无条件终止资源
  }
});
await anas.ready(); // 恢复失败调用 anas.failed()
```

源页面 prepare 期间暂停编辑，目标准备完成后 activate，再提交位置、释放源页面。失败销毁目标后 resume 源页面。异步处理器须检查 AbortSignal；后端应校验输入租约／版本，防止取消后的迟到操作接管资源。状态限制 1 MiB、深度 32、100,000 节点，不持久化、不写日志。页面的运行时 ID 不应代替插件自己的业务资源 ID。

同一面板的移动串行执行，关闭取消在途交接。目标侧栏确认和生命周期命令通常等待 15 秒，目标加载／恢复等待 30 秒。插件必须登记 prepare，否则移动明确失败，保留原页面。`onViewChanged` 仍用于布局、工具栏和位置变化；`getContext` 始终提供当前完整状态。

iframe 使用独立 `anas-plugin://<id>/` 来源和 sandbox。宿主把私有 MessagePort 交给指定 iframe；IPC 从已注册 pageId 推导插件身份。插件没有 Electron preload 或主界面 API。菜单、提示、弹窗直接使用 DOM，不隐藏侧栏避让。

### 窗口标题栏

页面可用 `setToolbar` 替换自己的标题栏状态和操作，传 `null` 清空；只在独立窗口显示；每个新页面恢复后提交自己的快照，关闭后清除，不写入配置。

```js
const unsubscribe = anas.onToolbarAction(async id => {
  if (id === 'disconnect') await disconnect(); // 当前活动页面执行
});
await anas.setToolbar({
  status: { label: '已连接', tone: 'success' },
  actions: [{ id: 'disconnect', label: '断开', icon: 'assets/unplug.svg', disabled: false }]
});
```

每页注册一个操作处理器，返回函数解除订阅。`actions` 必填，不限制为固定按钮数量；按标题栏可用宽度显示，溢出操作收进「更多」菜单，保留禁用及选中状态；`id` 为 1–64 位英文字母、数字、下划线或短横线，不能重复；`label` 为最多 120 字符的非空本地化文本，用于提示及无障碍名称。`icon` 必须为插件包内 SVG、PNG 或 WebP 的相对路径，不接受内置图标名称、绝对路径或 URL；`disabled` 缺失为 `false`。可选布尔 `pressed` 将操作呈现为带选中状态的图标按钮；省略则保留普通按钮。点击只派发操作，由插件读取真实业务状态后更新 `pressed`，宿主不自行切换。可选 `status` 的 `label` 遵守同样限制，`tone` 为 `neutral`（默认）、`success`、`warning` 或 `danger`。页面负责跟随业务状态及语言更新，宿主不读取插件业务状态、不代调后台。

操作可带 `items: [{ id, label, disabled?, checked?, separatorBefore? }]` 呈现下拉菜单，另可提供简短的 `description` 说明。菜单容器只负责展开，不派发操作；选中条目仍通过 `onToolbarAction(id)` 执行。条目 ID 与所有操作 ID 必须唯一，`checked` 由插件按实际业务状态更新；菜单和条目禁用状态共同生效；`separatorBefore: true` 在条目前添加分割线，用于分组。`items` 非空，不与 `pressed` 混用，不支持任意递归嵌套。标题栏空间不足时，菜单作为「更多」中的子菜单，保留完整操作。

工具栏图标复用插件图片资源入口及 256 KiB 限制，以 16×16 图片原样显示，不强制单色化；颜色及明暗适配由图标资源自身定义。建议使用透明背景 SVG（带 `viewBox`），可通过 `prefers-color-scheme` 适配主题。选中状态沿用按钮样式，禁用时图标灰显；不把 SVG 内容插入宿主 DOM。加载失败显示带错误提示的占位图标。插件页面使用 `<img>` 复用同一份资源，记事本示例和 RDP 插件均采用此方式。

宿主校验当前页面及窗口归属，只派发已登记且可用的操作。同页一次只执行一个标题栏操作，执行中按钮禁用；处理器拒绝时显示失败消息，30 秒无结果时显示超时消息，不自动重试，超时不代表业务被取消；操作保持禁用，直到处理器完成或页面关闭／刷新。关闭或刷新取消未完成回执，旧回执不能完成其他页面的操作。需要停止业务时由插件实现取消。页面确认 `setToolbar` 成功后再隐藏原操作栏；更新失败应保留可用入口并报告错误。


## 可选后台

`activate` 的 `packageDirectory` 是已安装包目录，`dataDirectory` 是插件持久数据目录；`tempDirectory` 是宿主创建的绝对临时目录，位于当前数据目录的 `tmp/anas-plugin-<插件 ID>/`。插件把可丢弃的截图和中间文件放在这里，不从持久数据路径反推宿主路径。临时文件不进入备份，可在宿主启动、退出或用户清理时删除；写入前应按需重建目录，不保存凭据、配置或需要长期保留的资料。

增加 `"backend": "backend.cjs"`，入口导出：

```js
module.exports = {
  async activate(context) {
    // context.pluginId / packageDirectory / dataDirectory / tempDirectory
  },
  async call(method, params, context) {
    // context.caller: { panelId, instanceId } 或 null；context.views 为本插件的存续面板。
    if (method === 'example') return { received: params };
    throw new Error('Unknown method');
  },
  async deactivate() {
    // 关闭连接、停止自己创建的子进程并完成落盘。
  }
};
```

三个函数都可省略；调用未提供的 `call` 会返回明确错误。后台按插件共享，页面 RPC 默认按顺序派发。复合操作可显式使用 `anas.backend.call(method, params, { concurrent: true })` 并发派发，避免操作等待页面关闭／交接、而生命周期回调又等待同一 RPC 队列。此选项不改变普通 RPC 的顺序、取消和容量限制；插件负责并发方法所需的业务互斥。`context.signal` 是当前调用的取消信号。启动限时 30 秒。页面 RPC（含排队）在 30 秒到期时取消该调用；工具使用各自声明的 deadline。未派发项到期即拒绝；在途调用只通知对应处理器取消，保留槽位、RPC 顺序和真实迟到回执直到实际结束或进程退出。单次取消、超时或处理器不响应均不终止共享后台；处理器须协作停止自身尚未完成的工作，不能假定 AbortSignal 会撤销外部效果。无响应调用仍在途且占用原有 32 个请求的容量限制，可显式停止插件进行回收。停止时取消待派发项，并通知在途调用取消；等待激活结束后立即调用 `deactivate`，与在途调用并行收尾；插件须在清理中关闭资源、阻止新资源创建，并让依赖这些资源的调用返回。宿主等清理和在途回执均完成后退出后台。清理失败或超出 3 秒停止宽限期会向停止操作报告错误，阻止当次备份或卸载继续。强制终止不保证撤销已发生的外部操作。插件创建的原生子进程由插件负责关闭，宿主不承诺任意后代进程沙箱或托管能力。

第三参数由宿主在派发时生成，不从页面参数读取。`views` 只包含当前插件的 `{ panelId, instanceId, location, activity: { visible, active } }`，包括正在加载、移动或关闭但尚未释放的面板；`panelId` 跨窗口移动不变。非页面调用的 `caller` 为 `null`；排队期间已关闭的调用页面会被拒绝。插件可据此管理自己的编辑互斥和资源引用，不依赖不可靠的页面卸载通知。它是调用时的快照，业务锁、打开预留及状态转换仍由插件负责。

`activate`、普通 RPC 和工具处理器上下文提供 `host.getViews()`，异步读取本插件的最新面板列表。插件等待自己的业务锁后应重新读取，不把旧列表当成持续有效的状态；接口不打开页面、不启动其他后台。

`host.onViewsChanged(listener)` 订阅本插件面板列表与活动状态变化，返回取消订阅函数。先订阅再读取 `getViews()`，丢弃读取期间已有事件更新的旧快照；停止后台自动清理订阅。通知不启动后台、不经过页面 RPC 排队。`visible` 表示当前面板在可见、未最小化窗口中显示；`active` 还要求窗口在前台。独立窗口直接按窗口焦点判断；侧边栏还要求用户选中或操作该面板区域，点击聊天等外部区域会让出活动状态，悬停和 tooltip 不改变状态。面板所属工具栏及菜单属于同一操作区域。该状态与交接生命周期的 `phase` 独立，准备、暂停或关闭的页面不活动。`getContext().view.activity` 也可读取当前活动状态；页面的 `onViewChanged` 在可见性或活动状态改变时同样通知，并通过 `activity` 提供新状态；资源调度宜在后台订阅，不能依赖页面销毁通知。宿主只提供活动事实，插件自行决定暂停哪些业务及如何完成在途操作。

同一上下文另有 `host.openView(options)`、`host.moveView({ instanceId, location })` 和 `host.closeView({ instanceId })`，复用页面同名 API 的实例复用、聚焦、异步交接和关闭。后台不借用页面身份，只能操作本插件；移动和关闭必须明确指定 instanceId。页面操作可能触发回调，插件不得在等待它们时持有页面回调也需要的业务锁。派发前检查取消，已派发的界面操作等待真实回执；取消／超时不表示界面未发生变化。后台停用后，尚未执行的请求不能由新后台接续执行。

同一上下文的 `host.getSettings()` 读取当前通用设置值，包括声明的默认值。插件应在操作时读取，不把激活时的值永久缓存；它不包含 revision，也不进入对话快照。

后台可使用 Node 能力与自带依赖，具有当前操作系统用户的权限；独立进程用于隔离依赖和故障，不是权限沙箱。插件自行打包 Windows/macOS 所需辅助程序，并在 `deactivate` 中清理。需要原生依赖的插件须自行适配 Electron 的运行时 ABI；纯 JS、WASM 或独立可执行程序可降低这类耦合。

## 验证与后续边界

示例源码位于 `data/examples/plugins/`。`npm run dev`、`npm run build` 先通过 `build:examples` 生成 `out/examples/`：保留技能、工具及说明文件，插件按目录分别生成 `notepad.zip`、`backend-demo.zip`、`text-tools.zip`、`writing-helper.zip`，每个 ZIP 根部包含 `PLUGIN.json`，不另包一层目录。ZIP 条目顺序和时间固定，不随源码文件时间变化；生成物不提交 Git。正式包从生成目录携带示例，不重复分发插件源码目录。

启动及恢复备份时，宿主从随包资源（开发时为 `out/examples/`）整体复制 `examples/`，校验技能、工具及插件 ZIP 后统一替换；ZIP 使用安装器相同的解包限制，清单校验失败保留原目录，验证产生的临时文件及时删除。恢复旧备份时也会用当前示例整体替换，清除旧示例源码目录。技能和插件模块另行刷新各自的 `_system/`。示例不直接注册或启用，安装对话框默认打开 `examples/plugins/`，直接选择 ZIP 安装；已安装副本不随示例刷新而覆盖。记事本验证纯 UI 和页面交接，可选后台示例验证延迟启动与 RPC，text-tools 验证模型工具与通用设置，writing-helper 验证纯静态贡献。测试覆盖不兼容清单、损坏包、路径边界、并发写入、排队取消与在途结果、慢资源加载隔离、停用／卸载、备份恢复和真实 Electron 页面通信。

在完成 `npm run build` 后运行 `node scripts/electron-plugins.cjs`，使用临时数据目录验证真实应用，不修改个人配置。

2026-10-11 已在 Windows x64 验证无页面模型工具、单次调用取消、跨对话保留后台状态且不传递对话身份、静态贡献、当前设置读取及深浅主题／大字号布局。插件工具 Electron 测试还验证卸载和重启后的历史图片，以及从备份恢复已删除会话、插件包和设置。模型请求使用受控测试端点，不代表外部视觉模型的识别效果；RDP 实机范围见其测试说明，平台限制见[面板框架](PANEL_FRAMEWORK.md)。

新增宿主接口需有具体插件需求、参数与生命周期约定、可观察的失败行为及测试。RDP 等具体插件自行管理连接、配置与输入控制；宿主只提供通用服务。

内置面板使用同一管理器，数据接口与插件分离；详见[面板框架](PANEL_FRAMEWORK.md)。

## 模型工具

清单可增加 `tools`（最多 128 项），必须有后台入口。定义的读取、展示和请求预览不会启动后台：

```json
"tools": [{
  "id": "echo",
  "description": "Return the supplied text.",
  "input_schema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] },
  "handler": "echo",
  "effect": "read",
  "timeout_seconds": 30
}]
```

后台显式导出工具处理器；只有声明的工具可进入模型目录，不自动暴露页面 `call` 方法：

```js
module.exports = {
  tools: {
    async echo(params, { signal, deadline }) {
      signal.throwIfAborted();
      return { text: params.text };
    }
  }
};
```

工具上下文只提供本次调用的 `signal`、`deadline` 和 `host`；`deadline` 为毫秒时间戳，`signal` 支持协作取消。宿主不向插件传递项目、会话、运行或模型调用身份，也不发送对话开始／结束通知。工具可并发且不会堵塞页面 RPC；插件应为同一业务资源提供必要互斥。每后台最多 32 项待处理请求。

插件独立管理自己的连接、桌面等业务状态；需要跨调用操作资源时，由插件返回资源 ID，后续工具显式传入该 ID。对话完成、失败或取消不主动清理已经建立的业务资源。取消立即通知该次工具调用，保留原调用期限、执行槽及真实结果回执；取消不把剩余执行时间缩短为后台停止宽限期，也不延长原期限。原期限到达只通知该调用取消，不终止共享后台；无回执时仍保留执行槽和结果记录，直到实际完成、进程退出或明确停止插件。插件应及时响应取消；无法中断的已接受操作应在原期限内完成并返回真实结果。明确停止插件仍使用独立的 3 秒停止宽限期，激活结束后立即调用 `deactivate` 关闭资源，同时等待在途操作的真实回执。

ID 和处理器名使用字母开头的小写字母、数字、下划线，最多 64 字符。输入 schema 使用 draft 2019-09，最多 64 KiB；参数与 JSON 结果各最多 1 MiB。字符串、JSON 和标准内容块数组直接返回，由现有 LangChain 工具链处理。期限 1～3600 秒，缺失时 30 秒；不包含宿主托管队列等待时间。图片使用 `{ type: "image", mimeType: "image/png", data: "Base64…" }`，可与 `{ type: "text", text: "…" }` 混合返回；不需要额外结果类型声明或临时文件协议。PNG／JPEG 单张最多 25 MiB，每次最多 4 张、合计 32 MiB，尺寸和像素预算沿用附件校验。图片沿用现有消息存储、历史显示和模型协议适配。

`effect` 必须声明为 `read`、`idempotent` 或 `confirm`，用于恢复策略。读取不记录外部写效果；幂等操作可按现有恢复机制有限重试；普通写入、点击等不确定效果须确认后重试。声明幂等需有实际业务保证；若需要去重，由工具参数和插件业务实现提供，不依赖宿主模型调用编号。执行后异常、取消或丢失回执不能假定没有发生效果。

项目和子 Agent 按插件集中选择工具、技能和提示词，每个插件独立使用“全部／定制／关闭”。全部动态包含可用贡献，定制仅使用明确选择，关闭保留选择并隐藏列表；新增插件在定制项目中默认关闭。未定制项目使用所有已启用插件的可用贡献。插件页只负责安装、整体启停和自身配置，技能页管理插件技能的全局快捷方式／模型可用性上限。作用域设置使用 `plugins: [{id, mode}]`，定制条目沿用 `plugin_tools`、`plugin_prompts` 和 `skills.entries`；运行开始解析为具体选择，恢复沿用已保存的选择，同时检查来源当前可用性，子 Agent 的项目范围限制继续取交集。稳定 ID 为 `插件ID:tool:工具ID`；定制模式下新增工具不自动选中。模型工具名参照 MCP 使用 `plugin__插件ID__工具ID`（如 `plugin__rdp__connect`），不添加哈希。完整名称最多 64 字符，声明超限时拒绝安装并提示缩短 ID。能力列表直接显示发送给模型的完整工具名，不拼接插件显示名称；项目和子 Agent 能力编辑器使用相同名称。运行配置仅保存原能力选择中的工具 ID，不重复保存插件版本、安装代次、内容指纹或工具定义。组装 Agent 时从当前启用插件解析工具，派发前检查工具仍可用；升级不因版本变化拦截后续运行。在途请求只属于原后台进程，不能转交给替换后的进程。

「设置 → 工具 → 插件」按插件展示清单中的静态工具定义，复用 MCP 目录的分组和详情弹窗，支持查看和复制完整模型名称、说明和输入 schema。停用的插件仍可查看；此目录不修改能力选择，也不启动后台。

最小无界面示例：[text-tools](../data/examples/plugins/text-tools/PLUGIN.json)。完整契约和职责边界见[插件能力契约](PLUGIN_CAPABILITIES_CONTRACT.md)。实际 Electron 验证命令：`npm run test:e2e -- --plugin-tools-only`。

## 技能与静态提示词

清单可声明纯静态贡献，无需 UI 或后台。示例见 [writing-helper](../data/examples/plugins/writing-helper/PLUGIN.json)：

```json
"skills": [{ "id": "proofread", "path": "skills/proofread/SKILL.md", "tools": [] }],
"prompts": [{ "id": "writing-tone", "path": "prompts/tone.md", "description": "Use clear prose.", "scope": "all", "tools": [] }]
```

两种贡献各最多 128 项，`id` 为不超过 64 字符的小写字母、数字和单个短横线；同种贡献的 ID 与路径不能重复。路径必须在包内。`tools` 默认为空，填写本插件声明的工具本地 ID，不能引用未声明工具；宿主不因此自动启用工具。工具名称映射作为单独上下文提供，不改写技能或提示词原文。

技能使用标准 `SKILL.md`，名称需与所在目录一致，同一插件不能提供同名技能，单文件最多 1 MiB。技能直接位于插件包中，设置页只读；相对资源继续从技能目录解析。稳定选择 ID 为 `插件ID:skill:贡献ID`，来源别名为 `plugin:插件ID`，例如 `/proofread@plugin:writing-helper`。同名优先级依次为项目、用户、外加目录、系统、插件；插件按 ID 排序，不按安装顺序。模型／快捷选择统一保存在所属能力配置的 `skills.entries`，按插件分组编辑，定制模式缺少条目时不选中，全部模式动态包含可用条目，不受普通技能的 `skills.mode` 控制；技能管理页的快捷方式／模型可用性是所有作用域的上限。脚本免审仍沿用现有技能配置，插件来源不会自动免审。所需工具未选中时不向模型提供该技能，显式快捷调用会说明缺失工具。

提示词必须是非空 Markdown 文件，单文件最多 16 KiB，所选正文合计最多 64 KiB；超限明确报错。`description` 必填，最多 1024 字符；`scope` 为 `all`（默认）、`main` 或 `subagent`。项目和子 Agent 的定制选择使用 `plugin_prompts`，缺失字段及新增贡献不选中；全部模式动态包含可用提示词。生效片段按稳定 ID 排序、去重，依赖及作用范围不满足时不注入；项目未开启定制能力时采用全部模式，子 Agent 沿用既有父级限制规则。

技能目录、提示词和请求预览都不执行插件代码。选中的静态内容在普通系统上下文章节中可见，运行配置只保存必要的能力选择，不保存插件版本或内容快照。停用、卸载或包校验失败后不再提供贡献；更新包后读取当前内容，原选择按稳定 ID 保留。

## 通用设置

清单可声明最多 64 个普通偏好字段。只有设置、没有 UI／后台／技能／提示词的包不构成功能插件。

```json
"settings": [
  { "key": "prefix", "label": "Prefix / 前缀", "type": "text", "default": "", "max_length": 100 },
  { "key": "repeat", "label": "Repeat / 重复次数", "type": "number", "default": 1, "minimum": 1, "maximum": 5 },
  { "key": "uppercase", "label": "Uppercase / 大写", "type": "boolean", "default": false },
  { "key": "separator", "label": "Separator / 分隔符", "type": "enum", "default": "space",
    "choices": [{ "value": "space", "label": "Space / 空格" }, { "value": "newline", "label": "New line / 换行" }] }
]
```

`key` 使用小写字母开头的 snake_case，最多 64 字符，不可重复。`label` 必填，最多 200 字符；可选 `description` 最多 1024 字符。每个字段必须有有效默认值；缺失新增字段时使用默认值，显式 `false`、`0` 和空字符串保持不变。文本默认最多 4096 字符，`max_length` 可调小；数字可限制范围，支持小数；枚举最多 64 项，值与标签最长 200 字符，值不能重复。前端与主进程共用校验。

插件管理页控制整体启停；项目和子 Agent 独立定制贡献，技能页设置全局用途上限。通用设置通过保存／取消编辑，后台状态刷新不覆盖草稿；保存失败保留输入，值或表单已变化时拒绝覆盖，重新加载前确认放弃草稿。停用时可以查看设置，不能保存。

页面通过 `anas.settings.get()` 获取 `{ values, revision }`，通过 `anas.settings.set(values, revision)` 传入完整值集合，原子保存并取得新结果；缺少字段会报错，不把遗漏当成恢复默认。对应 `plugins.invoke` 方法为 `settings.get`／`settings.set`。revision 只用于此设置表单的并发编辑，不绑定 Agent 运行或对话。后台通过 `host.getSettings()` 使用同一份当前值。

设置保存在 `db/plugins/<id>/anas-settings.json`，由宿主读写，插件不要直接修改；卸载默认保留并随普通数据备份，显式删除插件数据时一并删除。移除字段的已存值保留在磁盘，但当前接口不暴露它。若字段类型发生不兼容变化，插件发布方仍需遵守数据升级规则，不能靠默认值静默重置。

通用字段不存密码或令牌；凭据继续使用插件自身的加密与备份机制。复杂业务配置沿用插件页面，本轮不增加没有实际需求的专用设置页面钩子。示例 [text-tools](../data/examples/plugins/text-tools/PLUGIN.json) 的回显工具在每次调用时读取通用设置，无需打开页面或重启后台。

## 执行中的包资源

普通文件工具在实际访问期间按规范路径持有相关插件包；Shell 和自定义可执行工具可动态加载文件，因此在其托管执行期间持有插件目录。覆盖／卸载发现占用时，在关闭页面和后台前明确拒绝，原包及数据不动，待调用完成后重试。后台句柄提前返回不会释放占用，只有实际执行与清理结束才释放；失败、取消和正常结束走同一释放路径。读取和安装共用短期准入锁，排队读取在替换完成后解析当前包，不读取半个版本。

此机制不冻结整轮对话、不记录安装代次或内容指纹。外部终端以及显式 `keep_processes` 脱离托管后的服务属于用户管理的进程；需要长期运行的插件功能应使用插件后台，或先把运行资源复制到独立工作目录，不将已安装包当作可随时覆盖的服务工作目录。

## 本机目录与文件定位

插件页面可调用 `anas.selectDirectory({ title?: string })`，在所属窗口显示本机目录选择框，可新建目录；选择后返回绝对路径，取消返回 `null`。标题最多 200 字符，由插件提供对应语言。等待对话框不占用应用数据锁，关闭页面或停用插件后不返回可用结果。`anas.showItemInFolder(path)` 在系统文件管理器定位已存在的绝对路径，不读取内容、不启动文件。两个接口仅向插件页面提供；具体文件传输、写入、进度和清理由插件后台负责。
