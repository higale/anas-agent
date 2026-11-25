## Anas v5.2.26

### 中文

- 新增离线文档工具 `document_to_markdown`。将 PDF、DOCX 或 PPTX 拖入聊天即可插入路径，模型可按需转换到指定的 Markdown 文件。图片保存在相邻的 `<输出文件主名>_images` 目录，结果返回文件路径、行数和字节数。
- PowerPoint 转换可提取表格、演讲者备注和公式，跳过手写墨迹及其预览图。可转换的公式写为 LaTeX，无法准确转换的结构保留为 XML。聊天中的工具都可以用可选的 `summary` 说明当前操作。
- 技能、自定义工具、子 Agent 和插件导入后是可独立编辑的完整副本。批量导入技能时，已成功的项目会保留，失败项单独说明原因。内置资源、示例、帮助和语言直接从程序包读取，数据目录中的旧副本留在原处。
- Windows 和 macOS 的内置 Python 由程序包维护，额外依赖请安装在自己的 Python 环境。普通 Python 工具优先使用系统解释器，缺少时使用包内解释器。“设置 → 环境”中的内置 rg 和 Python 开关控制模型看到的说明，默认开启。升级前关闭过相关说明的用户，请在新开关中重新关闭。

### English

- The new offline `document_to_markdown` tool converts PDF, DOCX and PPTX files to a Markdown file at a specified path. Drag a document into chat to insert its path. Images are saved beside the output in `<output stem>_images`. The result includes the file paths, line count and byte count.
- PowerPoint conversion extracts tables, speaker notes and equations, and skips handwritten ink and its previews. Supported equations use LaTeX, while unsupported structures are preserved as XML. Any tool can supply an optional `summary` to describe its current action in chat.
- Imported skills, custom tools, subagents and plugins are complete, independently editable copies. Batch skill imports retain successful items and report failures individually. Bundled resources, examples, help and languages are read directly from the application package. Existing copies remain in the data directory.
- On Windows and macOS, Anas manages its bundled Python inside the application package. Install additional dependencies in your own environment. Ordinary Python tools prefer the system interpreter and can use bundled Python when needed. The bundled rg and Python switches in Settings → Environment control what the model is told and default to on. If you previously disabled either description, turn it off again after upgrading.
