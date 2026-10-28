# 第三方声明 / Third-party notices

## 中文

Anas 使用 `LICENSE` 中的 MIT 协议。第三方代码和资源保留各自的版权和协议。

- OpenAI Codex：Skill 目录指导内容、补丁算法的 TypeScript 移植、补丁语法、工具说明和参考测试依据 Apache-2.0 使用，协议和署名位于 `data/licenses/codex/`；移植范围见 [补丁实现](docs/CODEX_PATCH.md)。
- 供应商品牌图标：来源、修改说明及协议见 [图标声明](data/licenses/provider-icons/README.md)。
- node-edge-tts：内置语音及 Sec-MS-GEC v2 算法的来源、修改说明和 MIT 协议位于 `data/licenses/node-edge-tts.txt`。
- Deep Agents 1.13.0：沿用的特定模型提示文本位于 `src/main/agent/modelGuidance.json`，保留原文并合并相同文本；版权属于 LangChain, Inc.，MIT 协议位于 `data/licenses/deepagents/LICENSE`。不包含其框架实现。
- LangChain Core 1.2.10：`src/runtime/compression.ts` 的摘要文本排版依据导入版本的角色、工具调用和媒体占位行为实现；`src/runtime/inputContent.ts` 保留输入媒体归一化行为；`src/providers/assistantContent.ts` 保留产品所用 OpenAI／Anthropic 响应的内容、引用和服务端工具呈现。实现均使用应用普通数据接口；版权属于 LangChain, Inc.，MIT 协议位于 `data/licenses/langchain/LICENSE`。
- LangChain 1.5.11：`src/runtime/planningDescription.ts` 保留任务清单工具说明；规划 schema、更新确认和并行更新校验依据原产品行为改为应用实现。调用预算、审批批次、工具错误处理与结构化审核报告保留导入版本的产品行为，改为应用实现。版权属于 LangChain, Inc.，MIT 协议位于 `data/licenses/langchain/LICENSE`。
- LangChain OpenAI 1.5.9：`src/providers/openAiChatInput.ts` 和 `openAiResponsesInput.ts` 的协议映射参考其转换器行为，改为普通请求数据和官方 SDK 类型；`src/providers/openAiResponsesOutput.ts` 保留协议映射，应用消息转换和原生聚合由项目实现。`src/providers/openAiParameters.ts` 保留原参数与工具声明行为，`openAiProfiles.json` 保留能力数据。版权属于 LangChain, Inc.，MIT 协议位于 `data/licenses/langchain/LICENSE`。
- LangChain Anthropic 1.5.10：`src/providers/anthropicInput.ts` 的媒体和消息映射、`anthropicParameters.ts` 的参数规则参考导入版本行为；`anthropicProfiles.json` 保留其能力数据，用户配置的容量仍优先。代码改为普通数据和官方 SDK，原生响应聚合由项目实现。版权属于 LangChain, Inc.，MIT 协议位于 `data/licenses/langchain/LICENSE`。
- `patches/` 中的依赖补丁会修改对应的上游包；重新分发时须保留这些包的协议声明。

源码分发包含 `data/licenses/` 下的内置声明。打包应用将其放在 `resources/data/licenses/` 下（macOS 上位于 `Contents/Resources/` 内）。应用归档中的依赖包在 `node_modules/` 下保留各自的声明。编译进渲染进程资源的构建时组件，其声明位于该归档的 `licenses/monaco-editor/`、`licenses/dompurify/` 和 `licenses/marked/` 下。

安装依赖或添加第三方 Skills、工具、模型和服务不会改变其协议条款。请查阅所分发内容附带的协议。

## English

Anas is licensed under the MIT License in `LICENSE`. Third-party code and assets retain their own copyrights and licenses.

- LangChain Core 1.2.10: summary rendering in `src/runtime/compression.ts` preserves the imported role, tool-call and media-placeholder behavior; `src/runtime/inputContent.ts` retains input media normalization; `src/providers/assistantContent.ts` retains content, citation and server-tool presentation for the product's OpenAI/Anthropic responses. All implementations use plain application data. Copyright LangChain, Inc.; the MIT license is in `data/licenses/langchain/LICENSE`.
- LangChain 1.5.11: `src/runtime/planningDescription.ts` retains the task-list tool description. Planning schemas, acknowledgements and concurrent-update checks preserve the original product behavior in application-owned code. Application-owned call budgets, approval batches, tool error handling and structured review reports retain the imported product behavior. Copyright LangChain, Inc.; the MIT license is in `data/licenses/langchain/LICENSE`.

- OpenAI Codex: Skill catalog guidance, the TypeScript port of the patch algorithm, patch grammar, tool description, and reference tests are used under Apache-2.0. The license and attribution are in `data/licenses/codex/`; port scope is documented in [the patch implementation notes](docs/CODEX_PATCH.md).
- Provider brand icons: sources, modifications, and licenses are listed in the [icon notices](data/licenses/provider-icons/README.md).
- node-edge-tts: source attribution, modifications and the MIT license for bundled speech code and the Sec-MS-GEC v2 algorithm are in `data/licenses/node-edge-tts.txt`.
- Deep Agents 1.13.0: model-specific guidance in `src/main/agent/modelGuidance.json` retains the original text with identical entries grouped. Copyright LangChain, Inc.; the MIT license is in `data/licenses/deepagents/LICENSE`. This retained material does not include its framework implementation.
- LangChain OpenAI 1.5.9: protocol mappings in `src/providers/openAiChatInput.ts` and `openAiResponsesInput.ts` are informed by its converters and rewritten around plain request data and official SDK types. `src/providers/openAiResponsesOutput.ts` retains protocol mappings, while application message conversion and native aggregation are application-owned. `src/providers/openAiParameters.ts` retains request parameter and tool declaration behavior; `openAiProfiles.json` retains capability data. Copyright LangChain, Inc.; the MIT license is in `data/licenses/langchain/LICENSE`.
- LangChain Anthropic 1.5.10: media and message mappings in `src/providers/anthropicInput.ts` and parameter rules in `anthropicParameters.ts` retain imported product behavior; `anthropicProfiles.json` retains its capability data, with user-configured capacities taking precedence. Implementations use plain data and the official SDK; native response aggregation is application-owned. Copyright LangChain, Inc.; the MIT license is in `data/licenses/langchain/LICENSE`.
- Dependency patches in `patches/` modify the corresponding upstream packages; retain those packages' license notices when redistributing them.

Source distributions include the bundled notices under `data/licenses/`. Packaged applications place them under `resources/data/licenses/` (under `Contents/Resources/` on macOS). Package dependencies retain their notices under `node_modules/` in the application archive. Build-time components shipped in renderer bundles have notices under `licenses/monaco-editor/`, `licenses/dompurify/`, and `licenses/marked/` in that archive.

Installing dependencies or adding third-party Skills, tools, models, or services does not change their license terms. Review the licenses supplied with anything you redistribute.
