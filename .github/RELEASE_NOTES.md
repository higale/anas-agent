## Anas v5.2.21

- 移除全局、单技能和项目技能的脚本免审设置，技能脚本统一遵循对话权限。旧免审配置不再生效，历史自动免审记录不再作为后续授权依据；读取不改写原配置。
- 技能描述超过 1024 个字符时显示叹号警告，仍可正常加载、通过快捷方式调用和提供给模型，保留完整描述。
- 项目技能与自定义工具统一手动添加总目录，仅对当前项目生效；不再自动发现源文件夹中的 `.agents/skills/`、`.agents/tools/`。继续使用原目录需手动添加，并在定制模式下重新选择；原文件不会删除，子 Agent 包内目录加载保持不变。
- 添加目录的加号移到“技能”和“自定义工具”标题旁，目录以“项目 - 目录名”与其他来源并列显示。支持打开目录、移除引用和取消编辑，移除引用不删除文件。同步双语文档，并消除工具模块混合导入的构建警告。
- 配置及数据库格式版本不变；缺少项目目录引用字段时使用空列表，不自动补入旧来源。备份保存目录引用，外部文件需单独备份。

- Remove global, per-skill, and per-project script auto-approval settings. Skill scripts now follow conversation permissions. Old exemptions no longer apply, and historical automatic approvals are not reused as authorization; reading does not rewrite existing configuration.
- Show an exclamation warning for skill descriptions longer than 1024 characters while retaining the full text and allowing loading, shortcut invocation, and model use.
- Add project skill and custom-tool roots explicitly, with references scoped to the current project. Source folders' `.agents/skills/` and `.agents/tools/` are no longer discovered automatically. Add existing roots manually and reselect their resources in Custom mode to keep using them. Existing files remain intact, and subagent package directory discovery is unchanged.
- Move add-directory buttons beside the Skills and Custom tools headings. Display roots as **Project - directory name** alongside other sources, with open-folder, remove-reference, and cancel-edit behavior. Removing a reference never deletes files. Update bilingual documentation and remove the mixed-import build warning for the tool module.
- Configuration and database format versions are unchanged. Missing project directory reference fields default to empty lists without adding old sources automatically. Backups preserve references; back up external files separately.
