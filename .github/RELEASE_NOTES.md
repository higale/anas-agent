## Anas v3.3.4

- 插件支持按实例打开多个侧边页或独立窗口，同一位置重复打开复用原页面；停用、卸载和备份恢复回收全部实例。
- 插件可声明首页默认位置及允许位置；宿主设置提供位置控件，偏好保存在插件自己的数据中，顶部入口在加载首页前读取，下次打开生效。
- 插件名称、说明及默认窗口标题支持包内 i18next JSON 语言文件，跟随宿主语种，缺失文字回退英文。语言选项仍仅来自宿主；重装不保留或合并旧插件翻译。
- 卸载确认框新增「删除插件数据」选项，默认保留。勾选后仅删除当前插件数据，操作失败时回滚或保留暂存文件。
- 修复 Windows 恢复备份时，插件停止后的短暂目录占用导致恢复失败的问题；原子移动采用有界重试，持续失败仍回滚并保留原数据。
- 开发版同步基点改用普通 Git 引用，不再使用开发标签；更新中英文档和插件界面、存储、语言及生命周期回归测试。插件 API 和持久化格式保持兼容。

- Open multiple named plugin views in sidebars or separate windows and reuse existing views in the same location. Disabling, uninstalling, and backup/restore clean up all instances.
- Plugins can declare default and allowed home locations. Host settings save the preference in the plugin's own data; the top menu reads it before loading the home page, taking effect on the next opening.
- Localize plugin names, descriptions, and default window titles with packaged i18next JSON files, following the host language with English fallback. Only host language packs create language choices; reinstalling does not preserve or merge old plugin translations.
- Add an optional Delete plugin data checkbox to uninstall confirmation, keeping data by default. Deletion targets only the selected plugin, with rollback or staged-file preservation on failure.
- Fix Windows backup restoration failing on a brief directory lock after a plugin stops. Atomic moves use bounded retries; persistent failures still roll back and preserve existing data.
- Track development sync baselines with ordinary Git references instead of development tags. Update bilingual documentation and plugin UI, storage, language, and lifecycle regression coverage while retaining plugin API and data-format compatibility.

## 下载与安装 / Downloads & installation

- **macOS**：选择 ARM64（Apple Silicon）或 x64（Intel）DMG，拖入“应用程序”。未经过 Apple 公证；首次启动受阻时，在“系统设置 → 隐私与安全”选择“仍要打开”。[详细说明](https://github.com/higale/anas-agent/blob/main/README.md#打开下载的-macos-应用)
- **Windows x64**：解压 ZIP，运行 `Anas/Anas.exe`，保留完整文件夹。

- **macOS**: Choose the ARM64 (Apple Silicon) or x64 (Intel) DMG and drag Anas into Applications. Builds are not notarized; if blocked on first launch, use **System Settings → Privacy & Security → Open Anyway**. [Details](https://github.com/higale/anas-agent/blob/main/README.en.md#opening-the-macos-download)
- **Windows x64**: Extract the ZIP and run `Anas/Anas.exe`; keep the complete folder.

校验值 / Checksums: `SHA256SUMS.txt`.
