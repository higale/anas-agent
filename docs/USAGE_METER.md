# 内置用量信息

用量信息是模型设置和侧栏的系统功能，不经过插件后台或 HTML widget。主进程实现位于 [usage/](../src/main/usage/usageService.ts)，前后端共用 [Base URL 识别与设置类型](../src/shared/usageMeter.ts)，界面位于 [UsageSettingsField](../src/renderer/src/ui/model/UsageSettingsField.tsx) 和 [UsageMeter](../src/renderer/src/ui/model/UsageMeter.tsx)。

## 配置与生命周期

- API Key 标签右侧提供“显示用量信息”。按 URL 的精确主机、路径和地域识别，支持类型默认开启，不支持或无效地址关闭且禁用；从不支持切回支持类型默认开启，同一类型保留手动选择。
- 腾讯、百炼提供额外凭据设置按钮，关闭显示仍可编辑。凭据按供应商隔离，切换类型不删除。弹窗取消不保存，保存沿用供应商的串行自动保存和失败重试；查询密钥仅输入聚焦时显示，失焦遮蔽，悬停不显示；遮蔽不代表加密。
- 腾讯设置及中英文手册说明：为查询凭据对应的腾讯云用户添加 `ReadOnlyAccess` 权限，再填写 SecretId 和 SecretKey。
- `config/models.json` v0 的供应商可选 `usage` 分组保存 `enabled`、`display_mode`、`tencent_secret_id`、`tencent_secret_key`、`tencent_show_balance`、`bailian_access_key_id`、`bailian_access_key_secret`、`bailian_show_balance`。百炼余额开关缺失默认关闭，腾讯缺失默认开启；显式 false 保留，不升级格式或回写已有文件。缺失默认支持地址开启、紧凑显示、空凭据；读取不回写。查询凭据不附加到模型执行快照。
- 侧栏跟随当前模型。窗口可见且仪表活动时每分钟读取，成功数据缓存五分钟；手动刷新绕过缓存。展示、语言与字号变化不触发网络查询。普通接口失败保留同一上下文的成功数据，百炼失败清空。请求去重、有界缓存、响应上限 1 MiB；普通接口限时 15 秒，百炼完整链路限时 30 秒。
- 模型配置或凭据变化使旧上下文失效；关闭显示、恢复数据和退出会取消相关工作，包括一个并行请求失败后的其他请求；恢复期间尚在加载配置的旧请求不会再启动网络查询，迟到结果不能发布到新上下文。查询不持有应用数据锁等待网络。临时令牌和读数仅在内存，不需要持久化用量数据库。
- 模型 Key 环境变量缺失时，仅依赖该 Key 的查询提示配置错误；腾讯账户查询和已开启的阿里云余额查询继续使用各自凭据。查询账户优先使用现有身份响应的昵称、用户名，缺失时显示账号 ID，不单独请求名称。

## 厂商范围

| 厂商 | 查询及显示边界 |
| --- | --- |
| MiniMax | `GET /v1/token_plan/remains`，使用 `general` 或旧 `MiniMax-M*` 共享额度；5 小时和周额度独立。周剩余比例包含 `weekly_boost_permille` 加成，进度表示剩余／实际总量。重置不等于订阅到期。 |
| GLM／Z.ai | Coding Plan 路径查询 `/api/monitor/usage/quota/limit`，原始 Key 放入 Authorization；国内普通 API 查询 `/api/biz/account/query-customer-account-report` 余额，国际普通 API 不支持。余额不包含资源包或套餐，缺失明细不补零。 |
| DeepSeek | `/user/balance`，按币种分别显示可用、赠金和充值余额。 |
| Moonshot | `/v1/users/me/balance`，中国站 CNY、国际站 USD，可用余额不自行由分项补算。 |
| MiMo | `/v1/platform/balance` 使用整数分扣除冻结金额；中国、新加坡、欧洲套餐主机查询 `/v1/platform/token_plan`，按实际周期显示 Credits 和订阅信息。 |
| OpenRouter | `/api/v1/key`，当前 Key 剩余额度和消费；无额度上限不意味着账户有余额，不查询需要管理密钥的账户总余额。 |
| 腾讯 | “显示余额”控制独立 `DescribeAccountBalance` 请求，缺失默认开启；关闭后保留支持的用量和套餐请求，仅余额地址隐藏仪表。余额开启时排在用量前面。TC3 签名查询云账户余额、广州／新加坡普通 TokenHub 当月用量和广州个人 General／Hy Token Plan。历史与当天统计使用不重叠区间；不标成当前模型 Key 用量，不查询企业套餐，新加坡套餐和 Coding Plan 只显示余额。 |
| 百炼 | 下述 RAM AccessKey 直接 HTTP 链路；个人套餐、当前模型免费额度和完整匹配 Key 的近七天在线统计。 |

厂商响应解析保留既有行为测试；接口未返回的字段不补造，不跨币种求和，不在本地重置到期额度。

## 百炼 HTTP 链路

参照[官方鉴权说明](https://help.aliyun.com/zh/model-studio/cli/installation)与[官方 CLI 协议实现](https://github.com/modelstudioai/cli)，独立实现 HTTP 请求，不安装、运行或读取 `bl`。

1. ACS3-HMAC-SHA256 签名请求 `POST https://modelstudio.cn-beijing.aliyuncs.com/modelstudio/cli/generateAccessToken`，Action `GenerateCLIAccessToken`、Version `2026-02-10`，空正文、空查询串。返回 `cliAccessToken`；未提供有效期时只在内存缓存五分钟。并发换令牌合并，`NotLogined` 最多换令牌重试一次。
2. 使用 Bearer 令牌请求 `POST https://bailian-cs.console.aliyun.com/cli/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=<接口名>`。表单 `region=cn-beijing`，`params={Api,V:"1.0",Data:{...}}`；`cornerstoneParam` 使用 `protocol: V2`、`console: ONE_CONSOLE`、`productCode: p_efm`、`switchUserType: 3`、`consoleSite: BAILIAN_ALIYUN`。
3. 逐层检查 `success`、`failed`、`successResponse`、`ret`，HTTP 200 不能当作业务成功。错误仅返回本地分类文案，不展示完整响应、令牌或 Key。

| 查询 | 接口与关键参数 |
| --- | --- |
| 身份 | `zeldaEasy.cornerstone-portal.cs-console.loginInfo`；每次实际查询前后核对 uid／parentUid。RAM uid 不等同于主账户 uid。 |
| 套餐 Key | `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/api-keys/getKeyByUid`，校验已观察到的充分长度脱敏首尾。 |
| 套餐读数 | 同前缀 `/usage`、`/subscription`；订阅参数 `queryInstanceInfoRequest: {}`。按实际 `per<数量><Hour|Day|Week|Month>Percentage/ResetTime` 解析，Percentage 为 0～1 已用比例，超额剩余钳制为零。 |
| 普通 Key | `zeldaEasy.bailian-dash-workspace.api-key.listApiKeys4Agent` 分页；候选再通过 `.getApiKey` 完整匹配。返回仍脱敏时不能视为匹配。 |
| 免费额度 | `zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuota`，`queryFreeTierQuotaRequest: {models:[模型名]}`；读取 `freeTierQuotas`，`UNKNOWN` 不显示成零。 |
| Key 统计 | `zeldaEasy.bailian-telemetry.platform-model.getModelStatistic`，`reqDTO` 含 `workspaceId`、`apikeyIds:[字符串ID]`、毫秒 `startTime/endTime`、`modelCallSource: Online`。仅 taskId 时按 500ms 间隔、有限次数携带 `asyncTaskId` 轮询。 |

用量设置直接显示两段授权说明，按用户指定列出 `AliyunTokenPlanReadOnlyAccess`、`AliyunBSSReadOnlyAccess`、`AliyunModelStudioFullAccess` 三项 RAM 系统策略；其中 `AliyunModelStudioFullAccess` 的[官方内容](https://help.aliyun.com/zh/ram/developer-reference/aliyunmodelstudiofullaccess)包含 `modelstudio:*`。`GenerateCLIAccessToken` 是 API 操作名，不是系统策略名。百炼内部授权按用户确认的路径：账号管理添加 RAM 用户，再进入“权限管理 → 添加权限 → 选择业务空间”，添加“智能体-操作”即可，无需额外添加“订阅套餐”。用户步骤见[中文手册](../data/help/USER_GUIDE.zh-CN.md#百炼-ram-授权与查询排障)和[英文手册](../data/help/USER_GUIDE.en.md#bailian-ram-authorization-and-query-troubleshooting)。不自动修改授权。

2026-11-24 单项 RAM 系统策略复验：用户确认新测试用户仅保留 `AliyunModelStudioFullAccess` 后，使用该用户凭据独立查询，换令牌、身份、套餐 Key、用量、订阅均成功，成功返回月额度剩余、订阅状态 VALID。验证范围为该用户既有百炼业务授权下的个人套餐接口链路；未使用本机模型 Key 做匹配，也未复测普通 Key 链路。该策略属于模型服务管理权限，更小的自定义权限组合未验证。

2026-11-24 Windows 本机直接查询：实际配置中的一项套餐 Key 和一项普通 Key 匹配成功；另一项套餐配置返回不匹配。普通 Key 的近七天调用查询成功；Key 范围与工作空间范围的调用数不同，均未返回 `usages` Token 明细。因此产品保留 Key 范围调用数及接口实际明细，并明确提示缺失；不接入另一个工作空间 Token 汇总接口来替代 Key 用量。完整最小 RAM 权限组合、主账号身份、国际站及团队版未实测；账单不在实现范围。

## 阿里云账户余额

百炼用量设置的“显示余额”默认关闭；开启后通过同一组 RAM AccessKey 独立调用 `https://business.aliyuncs.com/` 的 `QueryAccountBalance`（2017-12-14，RPC HMAC-SHA1 签名）。使用 `AliyunBSSReadOnlyAccess`，不依赖百炼临时令牌或模型 Key 匹配。余额排在用量前面，主行显示 `AvailableCashAmount` 现金余额，详情区分可用额度与信用额度，账户范围说明只放悬浮详情；紧凑人民币使用“￥”，不混加不同币种。

余额与用量请求分别校验、报告失败，成功项保留。余额限时 15 秒，并行时用量限时 25 秒，仍受整体 30 秒及取消信号控制；关闭余额或更换凭据立即废弃旧缓存与请求。配置恢复和执行快照边界沿用现有 models usage 处理。

2026-11-24 使用新增查询实现及用户授权的 RAM 凭据完成真实只读查询：成功返回现金余额、可用额度与信用额度，具体读数不写入公开文档。凭据未写入文件；此验收仅覆盖该账户余额接口，不代表其他站点或账单验证。

## 配置与验证

经用户明确要求，新功能只读取 `models.json` 的供应商用量设置，不接续旧插件的开关、凭据或显示偏好；专用迁移、修复和保全逻辑已移除。缺失新设置时采用默认值，已有新设置继续有效。旧插件文件存在或损坏均不影响启动、模型配置修复与备份恢复，不生成转换标记或专用原件副本。应用管理的 `_system` 镜像会移除已退役的插件代码；通用插件 widget 与用户插件保持可用。

行为测试位于 `src/main/usage/`、`src/shared/usageMeter.test.ts` 及现有模型修复／备份测试；Windows 原生界面检查使用 `npm run test:e2e -- --usage-only`，隔离数据与受控 HTTP 响应，截图位于忽略的 `tmp/native-usage/`。真实接口验证只证明上述账户与范围，不等同于所有厂商、跨平台或公开发布验收。

## 退役插件复审

- 仓库中已无旧插件清单、后台、HTML 生成器、图标和独立语言包；新查询链路仅使用模型配置、原生 IPC 与 React 组件，不导入插件宿主、不启动子进程或读取 CLI 配置。
- `data/plugins/_system/README.md` 和通用插件 widget 仍属于插件系统，支持既有用户插件；共享排版和自适应文字组件不是旧用量插件的业务依赖。
- 无旧用量插件的兼容模块或数据读取入口；已有磁盘文件不参与新功能，不自动删除用户文件。
- 百炼 Token Plan 的 Anthropic 路径与随包模板统一为 `/apps/anthropic`；回归覆盖全部六个百炼模板。缓存只按当前厂商需要的凭据区分，不保存重复的供应商配置副本。
