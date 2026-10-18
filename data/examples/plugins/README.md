# 插件示例

[English](README.en.md)

在“设置 > 插件”点击“安装插件”会默认打开应用数据目录的 `examples/plugins/`，直接选择下面的 ZIP 即可。每个 ZIP 是独立完整的插件，根目录含 `PLUGIN.json`，无需手动解压。启动和恢复备份时同步 ZIP 与本说明；示例不会自动注册或启用，刷新示例不会覆盖已安装的副本。

- `notepad.zip`：中英文记事本，无需后台；演示包内 SVG 图标、共享保存操作、语言包、跟随宿主语言、数据保存和未保存状态保留。
- `text-tools.zip`：无页面工具，演示文字、Base64 图片、取消、后台复用和无需启动后台的通用设置。
- `writing-helper.zip`：纯声明技能和静态提示词，不启动后台。
- `backend-demo.zip`：纯英文的可选 Node 后台示例，首次点击“Call”才启动后台；可测试正常结果、错误返回和停止后重启。

仓库的 `data/examples/plugins/` 保留同名源码目录，无需为示例安装 npm 依赖。`npm run dev` 和 `npm run build` 自动生成 `out/examples/`，也可单独运行 `npm run build:examples`；生成的 ZIP 不提交 Git。需要研究或修改时，可查看仓库源码或解压 ZIP，再通过 `PLUGIN.json` 或拖入目录安装。

记事本在清单中声明 `"lang": "lang"`，通过 `anas.getLanguageResources()` 读取 `lang/en.json`、`lang/zh-CN.json`，通过 `anas.getInfo()` 获取宿主语言。`plugin.name` 和 `plugin.description` 同时用于宿主菜单、设置及默认窗口标题；页面在聚焦时及可见期间每 5 秒刷新语言、主题和字号，保留草稿及保存状态。缺失或空白文案回退英文。

记事本不在页面内重复显示标题；侧栏底部的保存按钮右对齐，独立窗口隐藏该按钮，使用标题栏保存入口，保存状态仍在页面底部显示。两处入口共享 `assets/save.svg` 与保存处理器；工具栏用 `icon: 'assets/save.svg'` 注册，页面通过 `<img>` 使用同一图标，图标自身适配明暗主题。

为保持免构建示例简洁，`app.js` 只演示静态文案查表；需要插值、复数等功能时使用插件自己的 i18next 实例。新增语种可复制英文 JSON 修改文本，宿主也需有对应语种，详见[多语言接口](https://github.com/higale/anas-agent/blob/main/docs/PLUGINS.md#多语言)。

安装会复制产物，修改源码后重新安装同 ID 并确认覆盖；默认保留数据，不勾选删除旧数据即可。插件接口、清单和生命周期见[插件文档](https://github.com/higale/anas-agent/blob/main/docs/PLUGINS.md)。
