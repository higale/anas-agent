# 工具与设置示例 / Tools and settings example

在插件设置中安装本目录的 `PLUGIN.json`。在项目或子 Agent 的对应插件分组中选择“全部”，或以“定制”按需选择 echo、image、wait；未定制项目使用已启用插件的全部可用工具，无需打开页面。设置页可编辑回显前缀、大写、重复次数和分隔符，默认返回原文。每次调用读取最新设置，不必重启后台。wait 支持取消，image 返回标准 Base64 图片块。

Install this folder's `PLUGIN.json` in plugin settings. In the plugin group of project or subagent capabilities, choose All or select echo, image, or wait with Custom. Uncustomized projects use all available tools from enabled plugins; no page is needed. Settings control the echo prefix, uppercase conversion, repetition and separator. Defaults preserve the input. Each invocation reads current settings without restarting the backend. wait supports cancellation; image returns a standard Base64 image block.
