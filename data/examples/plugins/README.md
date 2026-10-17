# 插件示例

[English](README.en.md)

本目录随应用资源分发，启动和恢复备份时将示例同步到应用数据目录的 `examples/plugins/`。在“设置 > 插件”点击“安装插件”会默认打开该目录，选择下面某个子目录中的 `PLUGIN.json`，或选择打包好的插件 ZIP。选择清单时会将整个插件目录复制到用户安装目录 `plugins/`。示例无需安装 npm 依赖，也不会自动注册或启用；刷新示例不会覆盖已安装的副本。

- `notepad/`：中英文记事本，无需后台；演示包内 SVG 图标、共享保存操作、语言包、跟随宿主语言、数据保存和未保存状态保留。
- `text-tools/`：无页面工具，演示文字、Base64 图片、取消、后台复用和无需启动后台的通用设置。
- `writing-helper/`：纯声明技能和静态提示词，不启动后台。
- `backend-demo/`：纯英文的可选 Node 后台示例，首次点击“Call”才启动后台；可测试正常结果、错误返回和停止后重启。

记事本在清单中声明 `"lang": "lang"`，通过 `anas.getLanguageResources()` 读取 `lang/en.json`、`lang/zh-CN.json`，通过 `anas.getInfo()` 获取宿主语言。`plugin.name` 和 `plugin.description` 同时用于宿主菜单、设置及默认窗口标题；页面在聚焦时及可见期间每 5 秒刷新语言、主题和字号，保留草稿及保存状态。缺失或空白文案回退英文。

记事本的页面保存按钮和独立窗口工具栏共享 `assets/save.svg` 与保存处理器；工具栏用 `icon: 'assets/save.svg'` 注册，页面通过 CSS mask 使用同一图标，随主题继承按钮颜色。

为保持免构建示例简洁，`app.js` 只演示静态文案查表；需要插值、复数等功能时使用插件自己的 i18next 实例。新增语种可复制英文 JSON 修改文本，宿主也需有对应语种，详见[多语言接口](https://github.com/higale/anas-agent/blob/main/docs/PLUGINS.md#多语言)。

安装会复制产物，修改源码后重新安装同 ID 并确认覆盖；默认保留数据，不勾选删除旧数据即可。插件接口、清单和生命周期见[插件文档](https://github.com/higale/anas-agent/blob/main/docs/PLUGINS.md)。
