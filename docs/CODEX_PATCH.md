# Codex 补丁移植

上游固定为 [openai/codex a6839a481223fb5faab539a9eb2b7174ae29e560](https://github.com/openai/codex/tree/a6839a481223fb5faab539a9eb2b7174ae29e560)。运行时只有 TypeScript，不依赖 Rust 可执行文件。

## 实现与调用

- [codexPatch.ts](../src/main/codexPatch.ts) 移植 `parser.rs`、`streaming_parser.rs` 的整批解析路径、`seek_sequence.rs`、`file_update.rs` 的 `compute_replacements` 和 `text_file.rs`。解析器直接产生修改块，事务层使用这些块计算结果，不再串行化并重新解析补丁。
- [codexPatchSpec.json](../src/main/codexPatchSpec.json) 原样保存该版本的 freeform 工具说明与 Lark 语法。OpenAI Responses 使用这份工具定义，模型直接生成补丁正文，LangChain 将原始输入表示为 `{ input }`。Chat Completions 与 Anthropic 接口使用 `{ patch, summary?, dry_run? }` 封装，并在说明中提供同一份语法。两种输入进入同一解析器；Responses 的 freeform 调用不携带预览或摘要参数，不增加模型设置。供应商需支持 Responses 的 `custom` 工具，接收该字段也不代表支持 Lark 约束；不支持时直接报告接口错误，不自动切换为 JSON。
- 匹配顺序、重复文本选择、空白与 Unicode 归一化、上下文保留、EOF 和换行行为均跟随上游。删除了旧实现的唯一匹配要求、候选片段诊断、锚点后纯插入扩展和 `\ No newline at end of file` 输入扩展。更新后的非空文件有末尾换行；插入行使用原文件首次出现的换行形式。新增文件的内容行使用 LF。
- LangChain 原生执行循环、checkpoint 和调度不变。Responses 转换边界处理 freeform 的流式完成参数及结果回传，已有 checkpoint 中的 JSON 与 freeform 调用均按原格式恢复与回传。不会尝试从补丁正文中猜测并剥离 `data`、`patch` 等额外 JSON 外壳。

## 宿主边界

移植的是补丁协议和文本算法，不是 Codex 的整个文件系统执行器。Anas 保留已有路径解析、授权、UTF-8/NUL 校验、20 项与字节数限制、事务暂存、并发修改检查、撤销与故障恢复。同一批次的重叠目标、新增时已存在的文件、移动时已存在的目的文件仍会拒绝；Codex 独立 CLI 在部分场景允许覆盖或部分成功。这些限制位于宿主层，不在匹配算法中增加回退规则。

更新文件和 `write_file(overwrite: true)` 跟随叶子符号链接，授权与执行均绑定解析后的真实目标；链接指向项目外时按当前访问模式处理，授权后链接改指向会拒绝执行。创建、删除和移动使用目录项语义；预镜像仍要求受支持的普通文本文件。文本算法对齐不改变这些宿主路径规则。

多环境路由不在本次范围内。默认上游工具定义不提供 `Environment ID`，纯解析器保留其解析行为，宿主在执行前明确拒绝此字段。已有编辑记录存储修改前后快照，不存储修改块；记录格式、历史查看和撤销流程不变。

## 对照验证与维护

普通行为测试读取 [参考语料](../src/main/test-fixtures/codex-patch.json)，比较完整解析结构、规范化补丁、修改内容和错误文本，并验证事务接入后的结果，不需要联网或 Rust。语料包含上游 25 组场景、用户报告的失败、格式与换行边界、Unicode 差异和固定种子的生成案例。

`npm run verify:codex-patch` 使用 Rust 原码重新校验语料，并核对工具说明和语法。需要 Cargo、Rust 2024 工具链及首次下载时的网络；源码按 Git blob SHA-1 校验，源码、编译器产物和下载缓存都在 Git 忽略的 `tmp/codex-patch-reference/`。仅裁去宿主路径解析依赖，解析、匹配、替换和换行函数保持原码。

更新上游时，先更新脚本中固定的提交和文件哈希，审阅原码与工具定义变化，再运行 `npm run verify:codex-patch -- --update` 生成新参考结果，并运行相关测试、`npm run typecheck` 和 `npm run build`。不得由 TypeScript 实现生成自己的预期结果。通过对照用例是已验证范围的证据，不代表对所有可能输入作出数学等价证明。

许可证与署名见 [Codex NOTICE](../data/licenses/codex/NOTICE) 和 [Apache-2.0](../data/licenses/codex/LICENSE)。
