## Anas v5.2.25

- 用量信息内置到模型设置与侧栏，按 API 地址判断支持并默认开启；腾讯、百炼提供查询凭据设置。旧用量插件的开关、凭据和显示偏好不接续，原文件保留；已有模型用量配置继续有效，配置仍为 v0，数据库不变。
- 支持腾讯 TokenHub 广州／新加坡本月用量与广州个人 General／Hy Token Plan，修正当天用量统计；腾讯云余额可独立开关。新增和整理腾讯、百炼模型模板，腾讯目录仅显示在线模型，完善套餐模型列表地址。
- 百炼通过 RAM AccessKey 直接查询，无需 CLI；设置中提供授权说明，可选独立查询阿里云现金余额。余额排在用量前面，人民币紧凑显示使用 ￥，订阅状态支持中文，查询密钥仅输入聚焦时显示。模型 Key 环境变量缺失不再阻断独立账户查询。
- 完善模型添加菜单的品牌图标，新建空白供应商默认使用 Responses；插件设置支持本地化标题和密码字段，概览只列已填写／未填写字段。
- 修复 Responses 多段推理摘要组装，以及流取消时 HTTP 记录状态和收尾竞争。

- Move usage information into model settings and the sidebar, enabled by default for supported API URLs, with query credentials for Tencent and Bailian. Retired usage-plugin preferences and credentials are not imported; existing files are retained. Existing model usage settings remain valid, configuration stays at v0, and databases are unchanged.
- Support current-month Tencent TokenHub usage in Guangzhou/Singapore and Guangzhou personal General/Hy Token Plans, including corrected current-day statistics. Tencent Cloud balance queries can be toggled independently. Add and organize Tencent/Bailian templates, show only online Tencent models, and improve plan model-list endpoints.
- Query Bailian directly with RAM AccessKeys, without a CLI. Include authorization guidance and optional independent Alibaba Cloud cash-balance queries. Show balances first, use ￥ for compact RMB amounts, localize subscription status, and reveal query secrets only while focused. Missing model-key environment variables no longer block independent account queries.
- Improve brand icons in model menus and default blank providers to Responses. Plugin settings support localized titles and password fields, with an overview of completed and empty fields.
- Fix assembly of multiple Responses reasoning summaries and HTTP trace status/finalization races during stream cancellation.
