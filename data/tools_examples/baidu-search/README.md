# 百度 AI 搜索 / Baidu AI Search

## 中文

依赖 Python 3（仅标准库）、网络连接和可调用百度 AI 搜索的 `BAIDU_SEARCH_API_KEY`。Anas 自动查找可用的 Python 3。

在系统环境变量中设置 `BAIDU_SEARCH_API_KEY`，或在 Anas“设置 → 环境”的应用 `.env` 中设置它；使用后者时，需要开启当前 Agent 的 `.env` 能力。密钥通过环境变量读取，不写入工具定义、脚本或参数。

通过“设置 → 工具 → 导入工具”导入本目录，再在默认、项目或子 Agent 的“自定义工具”能力中选中 `baidu_search`。导入保留 ID `baidu-search`，已有同名或同 ID 工具时不会覆盖。

参数示例：`{"query":"上海今天的天气","timeout":30}`。

- `query`：必填。去除首尾空白后，GB18030 编码最多 72 字节；常用汉字通常占 2 字节，部分字符占 4 字节。
- `timeout`：可选，单次网络操作超时为 1–120 秒，默认 30 秒；工具整体执行期限为 150 秒。

成功时 stdout 返回 JSON，`data` 中保留搜索结果及来源链接，回答时应引用相关来源。参数、凭据、服务或网络错误使用非零退出码，并将 JSON 诊断写入 stderr。每次调用仅提交一次请求。

## English

Requires Python 3 (standard library only), internet access, and a `BAIDU_SEARCH_API_KEY` authorized for Baidu AI Search. Anas discovers an available Python 3 interpreter automatically.

Set `BAIDU_SEARCH_API_KEY` in the system environment or in the application `.env` under Anas **Settings → Environment**. The latter requires the active Agent's **.env** capability. Supply credentials through the environment, not the tool definition, script, or arguments.

Import this directory through **Settings → Tools → Import tools**, then select `baidu_search` under **Custom tools** in default, project, or subagent capabilities. Import preserves the `baidu-search` ID and does not overwrite an existing tool with the same name or ID.

Example arguments: `{"query":"Shanghai weather today","timeout":30}`.

- `query`: required; after trimming surrounding whitespace, its GB18030 encoding must not exceed 72 bytes. Common Chinese characters usually use 2 bytes; some characters use 4.
- `timeout`: optional, 1–120 seconds per network operation, default 30. The tool's overall execution deadline is 150 seconds.

On success, stdout contains JSON with search results and source links preserved in `data`; cite relevant sources in the answer. Input, credential, service, and network failures exit nonzero and write JSON diagnostics to stderr. Each invocation submits only one request.
