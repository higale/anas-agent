## Anas v5.2.19

- Windows 和 macOS 随包提供备用 Python，保留 pip 和 venv；窗口加载后后台释放到应用数据目录，耗时或失败不阻塞聊天，并可在设置中重置。
- 项目和子 Agent 默认启用“内置 Python”：与 rg 一起在初始上下文说明版本、绝对路径和准备状态，由模型选择调用；不修改 Python 的 PATH 或用户保存的系统环境说明。
- `.py` 自定义工具优先实际探测系统 Python，不可用时使用内置保底，普通与交互式工具行为一致。拒绝未安装的商店占位链接，探测禁用自动安装；脚本失败不换解释器重跑，显式解释器命令不自动替换。
- 运行时目录不进入备份，恢复备份保留本机环境；更新双语指南与工具参考。配置与数据库版本不变，已有能力配置缺少新增字段时默认启用，不自动改写配置。

- Bundle fallback Python with pip and venv on Windows and macOS. Prepare it in the application data directory after the window loads, keep chat available during slow or failed preparation, and offer a reset action in Settings.
- Enable Bundled Python by default for projects and subagents. Present its version, absolute path and preparation status alongside rg in initial context for the model to choose, without changing Python's PATH or saved system-environment information.
- Probe system Python first for `.py` custom tools, then use the bundled fallback when needed, including interactive tools. Reject uninstalled Store aliases and disable automatic installation during probes. Failed scripts are not retried with another interpreter; explicit interpreter commands are unchanged.
- Exclude runtimes from backups and preserve local environments during restore. Update bilingual guides and tool references. Configuration and database versions are unchanged; existing capability files without the new field default to enabled without being rewritten.
