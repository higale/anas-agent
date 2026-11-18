# 模型级图片输入限制

更新时间：2026-11-18。状态：已实施，真实供应商边界由用户配置；本机验证范围见文末。

用户附件和工具返回图片可能不符合当前模型的输入要求。本方案按模型配置图片输入限制：附件在添加与提交时检查，工具结果在模型请求副本中处理，保留所有原始内容。

## 产品规则

- **默认不启用任何新增图片限制。只有用户在具体模型设置中填写规则后，才按这些规则拦截。**
- 配置归属于模型，每个模型独立保存，不作为供应商统一设置。
- 处理对象是**用户图片附件和 tools 返回的图片数据**，包括内置工具、MCP、自定义工具和插件；添加、提交和模型请求路径共用单图规则。

这里的“默认不拦截”指本次新增的模型级图片限制；现有文件完整性、协议能力和本地资源预算检查属于独立边界，不通过本次功能顺带删除。当前本地图片预算见 [imageLimits.ts](../src/shared/imageLimits.ts)，不能将其表述为供应商的模型上限。

## 配置与界面

模型编辑窗口在“视觉”旁提供小设置按钮，打开独立的“图片输入限制”弹窗；主界面不新增表单区块。已配置规则显示圆点，悬停查看摘要。二级弹窗确认只修改当前模型草稿，主窗口保存后持久化，任一层取消均撤销该层未确认的修改。

各项均可不填写；未填写的项目不增加限制，不自动根据模型名、供应商域名或 API 协议套入内置规则。

| 可选字段 | 含义 |
| --- | --- |
| 最小短边 | 宽、高都必须达到的最小像素值；填写值为包含边界的下限 |
| 最大长边 | 宽、高都不得超过的像素值 |
| 最大总像素 | 宽乘高的上限 |
| 最大长短边比 | 长边除以短边的上限 |
| 单图大小 | 以字节为单位；明确计量口径为原始文件，或 Base64 编码后的大小 |
| 单次请求图片数量 | 按本次实际发送的附件与未消费工具图片累计，含仍在有效上下文的历史附件；提交前超限拒绝提交，工具执行后超限整批失效并说明原因，不保留前若干张 |

配置保存在模型的可选 `image_limits` 分组，字段依次为 `min_short_side`、`max_long_side`、`max_pixels`、`max_aspect_ratio`、`max_bytes` 与 `max_count`。`byte_basis` 为 `original`（默认）或 `base64`，后者只计算编码正文，不含 Data URI 前缀。尺寸和像素为正整数，比例至少为 1；大小和数量允许 0，表示不接受对应图片，而非无限制。最小短边不能大于最大长边。清空规则恢复默认行为；不能把供应商的整次请求体上限当作单图上限。

大小输入和持久化使用整数字节数，输入框复用上下文窗口大小设置的 [CommitNumberInput](../src/renderer/src/ui/CommitNumberInput.tsx)，用逗号作千位分隔，例如 `1,500,000` 字节。简化显示采用用户指定的十进制口径：`1 K = 1,000` 字节，`1 M = 1,000,000` 字节，例如 `1.5 M`；不使用 1024 进制。简写仅用于展示，校验与错误原因中的精确值使用实际字节数，不使用舍入后的简写值判断边界。

新字段是当前配置格式的可选扩展：贯通默认值、持久化结构、共享类型、IPC、模型解析与界面；缺少整个分组或其中某项时正常读取，不升级格式版本、不迁移或自动改写旧配置。持久化键使用 snake_case，TypeScript 设置使用 camelCase。

## 附件检查

- 选择或拖入附件时按当前模型检查单图尺寸、像素、比例和大小；无法读取或不合规的图片拒绝添加并显示文件名及原因，合法文件仍可添加。不自动缩放、压缩或删除原文件。
- 提交前主进程重读新附件、复检当前模型配置，按实际请求中的附件和未消费工具图片合计数量。失败不创建本次消息或运行，输入框草稿保留；已排队消息保持可修正和重试。
- 默认 `one_turn` 附件在来源运行内携带，后续新轮次不计入；`conversation` 附件在有效上下文中仍会发送并计数。已被摘要覆盖的附件、已消费工具图片不计入。
- 模型执行时继续复检。工具执行后新增图片导致合计超限时，附件和工具图片整批在请求副本中替换为说明；用户附件单图规则失败则停止请求并要求调整附件或模型。远端 URL／file ID 仍不检查、不计数。

## 运行时行为

1. 工具正常执行并保留原始结果。按本次实际使用的模型解析规则，检查即将传入模型的附件和工具图片。
2. 在构造模型请求的公共路径处理，覆盖三种协议、流式与非流式调用、子 Agent、延迟读取工具结果及后续仍需携带的历史图片。只在单个工具适配器中实现会漏掉其他来源。
3. 优先复用已有“仅改变请求内容、保留原始结果”的投影方式。先确定本次有效历史和现有工具图片携带策略，再按模型规则处理实际会发送的图片，不能重新带回已消费的历史图片。
4. 未配置任何规则时跳过新增检查，不为此解码图片、下载 URL 图片或增加网络请求。配置变更应在下一次实际模型请求生效，不修改已经发出的请求。
5. 附件单图错误或提交前合计数量超限会阻止提交，保留草稿。工具执行后数量超限时，本次纳入检查的附件和工具图片在**模型请求副本**中整批替换为文字说明，包含实际总数、上限及整批未发送的原因，不截取部分图片。数量检查在工具单图规则过滤前进行；工具单图尺寸、比例或大小超限时仅替换该图片。工具文字和原始结果保持不变，模型收到原因后仍可继续处理。
6. 原始工具结果、图片和调用成功状态保持真实。不能把图片未发送描述成工具执行失败，不能自动重跑已经成功的工具，也不静默缩放、压缩、裁切或删除原图。
7. 说明中包含工具或结果标识、图片序号、实际值、限制值及未传入模型的事实；不输出 Base64 正文。界面应能区分“工具成功返回图片”和“图片未发送给当前模型”。
8. Token 估算、请求缓存标识和实际发送必须使用一致的请求内容，避免估算仍计入已过滤图片或复用旧请求的校准结果。

上下文统计和压缩选段不执行附件拒绝：对会阻止发送的附件保留图片用量估算，工具图片仍按实际省略规则估算。这样修改模型限制后，旧附件仍可通过纯文本摘要压缩；最终请求与提交前检查继续严格校验，压缩后保留的超限附件仍不能发送。

示例：用户为 Qwen 设置最小短边 11 px 后，工具返回 8×6 图片，可向模型提供：

> 工具返回的第 2 张图片未传入模型：尺寸为 8×6 px，当前模型配置要求宽、高至少为 11 px。请重新获取符合要求的图片。

这是请求兼容性处理，不新增审批或内容审核，也不改变服务端参数错误不自动重试的原则。

## 已确定的处理边界与后续范围

- Base64／Data URI 图片在本地检查。远端 URL／file ID 本次不处理：原样沿用现有请求路径，不下载、不解析远端资源、不新增校验，也不纳入本机制的图片数量统计或整批失效范围；不能将跳过检查表述为已通过校验。现有协议能力和资源预算检查仍保持不变。
- Base64 编码损坏、尺寸无法读取与“合法图片超出用户规则”分别说明。模型规则的尺寸检查最多解码前 1,048,576 字节的文件头；无法识别时拒绝附件，工具图片则向模型说明无法检查尺寸并省略该图片，不进行位图完整解码，也不宣称已验证整张图片完整性。只配置数量时不解码图片。
- 整体请求体上限和供应商特殊多图条件仍属于后续范围，不自动导入供应商规则。

## 相关代码入口

- [conversationImageLimits.ts](../src/main/agent/conversationImageLimits.ts)：模型级图片输入请求投影；本地检查与逐图／整批省略原因。
- [modelImageValidation.ts](../src/shared/modelImageValidation.ts)：添加附件、提交复检和模型请求共用的单图检查。
- [modelImageLimits.ts](../src/shared/modelImageLimits.ts)：共享规则、配置校验与十进制大小展示。
- [ModelImageLimitsDialog.tsx](../src/renderer/src/ui/model/ModelImageLimitsDialog.tsx)：独立弹窗与确认／取消草稿边界。
- [conversationContext.ts](../src/main/agent/conversationContext.ts)：`projectConversationToolImages` 只修改请求投影，保留持久化原文；同文件包含请求标识和 Token 估算。
- [conversationModelExecution.ts](../src/main/agent/conversationModelExecution.ts)：实际模型解析、历史与附件准备。
- [conversationCompression.ts](../src/main/agent/conversationCompression.ts)：模型调用前的上下文与压缩路径，需避免投影和估算不一致。
- [conversationModel.ts](../src/main/agent/conversationModel.ts)：Chat Completions、Responses、Anthropic 的统一模型调用入口。
- [inputContent.ts](../src/runtime/inputContent.ts) 与 [openAiChatInput.ts](../src/providers/openAiChatInput.ts)：图片块规范化与工具图片协议编码。Chat Completions 可能将工具图片放入后续 user 消息，检查时需保留其工具来源。
- [pluginToolResult.ts](../src/main/plugins/pluginToolResult.ts)：现有插件结果预算，只覆盖插件来源，不能代替统一模型规则。
- [ModelEditor.tsx](../src/renderer/src/ui/model/ModelEditor.tsx) 与 [modelConfigMapper.ts](../src/main/config/modelConfigMapper.ts)：模型设置与配置映射。

## 官方规则核对结论

文档查阅日期为 2026-11-18，未调用真实供应商验证边界。官方限制会随模型、托管平台、接口、上传方式和图片数量变化，以下仅为配置参考，不生成默认配置。

- [Qwen／百炼](https://help.aliyun.com/zh/model-studio/vision/) 明确要求宽、高都大于 10 px、长短边比不超过 200:1。原图、编码后 Data URI、整次请求体有不同限制，DashScope 域名还存在较低的请求体上限。
- [Claude](https://platform.claude.com/docs/en/build-with-claude/vision) 单图一般最大 8000×8000 px；多图请求另有限制，Claude API 与 Bedrock 的编码后大小限制也不同。
- [GLM](https://docs.bigmodel.cn/api-reference/模型-api/对话补全) 文档给出单图小于 5M、尺寸不超过 6000×6000，并按型号限制图片数量。
- [DeepSeek](https://api-docs.deepseek.com/zh-cn/guides/vision/) 单边一般最多 8192 px；单次包含 15 张及以上时降为 4096 px。
- [OpenAI](https://developers.openai.com/api/docs/guides/images-vision)、[Gemini](https://aistudio.google.com/docs/image-understanding)、[方舟](https://console.volcengine.com/ark/region:cn-beijing/docs/image-understanding)、[MiniMax](https://platform.minimax.io/docs/api-reference/text-chat-openai)、[MiMo](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/image-understanding)、[Grok](https://docs.x.ai/developers/model-capabilities/images/understanding)、[Groq](https://console.groq.com/docs/vision) 和 [Mistral](https://docs.mistral.ai/resources/known-limitations) 的计量口径不同；推荐分辨率、模型内部缩放范围、Token 预算不能直接当作原图拒绝阈值。

## 验收范围

- 原配置缺少字段及全部规则留空时，工具图片维持现有行为；不产生新增解码或远端请求。
- 每项规则的边界值、混合文本与图片、多工具合计数量；数量超限时整批图片不发送、不截取部分图片，模型收到明确错误原因后仍可继续处理。
- 远端 URL／file ID 原样沿用现有路径，不触发新增检查、下载、数量统计或整批失效；混合来源时只处理纳入本机制的图片。
- 用户配置的大小口径正确；字节输入采用逗号千位分隔，K／M 按 1000 进制简化显示，实际边界使用精确字节数；非法配置在设置边界明确报错，不误当作无限制。
- 已消费图片不重复发送；切换模型或修改规则后采用当前值；原始结果及持久化内容不被改写，工具不重跑。
- Chat Completions、Responses、Anthropic，流式与非流式，以及内置工具、MCP、自定义工具、插件与子 Agent 的实际请求验证。
- 相关行为测试、`npm run typecheck`、主进程与渲染进程集成后的 `npm run build`，以及模型设置的界面检查。测试使用隔离数据目录；本地受控服务不等同真实供应商验收。

本机已验证配置兼容与边界、三种协议的流式／非流式请求捕获、请求估算与标识、原始工具结果不变、响应省略原因的持久化及重启读取，以及弹窗确认／取消和主窗口保存。模型活动详情显示“图片未发送给本轮模型”，与工具成功返回图片分开；省略原因随成功模型响应保存，不改写原工具正文。显示索引只保存有无说明的标记，详细原因按需读取。新增响应上下文字段为可选扩展，不修改数据库结构或版本。

Electron 使用隔离数据目录检查模型设置布局和实际保存链路，不读取日常 `~/.anas`。这些受控测试不等同真实供应商、跨平台或公开发布验收。

附件扩展已通过隔离 Electron 检查：添加时拒绝不合规图片、提交前合计数量、源文件变更复检、草稿与附件保留、整个对话附件参与后续请求计数，以及调整限制后成功发送。三种协议的流式／非流式请求捕获验证附件与工具图片合计超限时整批省略；未调用真实供应商。
