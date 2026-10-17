# Anas — Local Desktop AI Agent

[简体中文](README.md) · [English](README.en.md)

**4.0 data change: previous projects and their settings, and input history (including pinned inputs), disappear from the interface after upgrading but can be restored manually as described below. Previous conversations and all long-term memory, including project memory, are no longer retained.** No automatic migration or import of pre-4.0 backups is provided. Global settings, project source files and user packages remain unchanged. Independent plugin data now lives in `db/plugins/`; the old `plugins_data/` directory is not loaded automatically and can be moved manually to restore it. Old-layout files stay on disk for now, but are not read, automatically deleted or included in new backups; review and remove residues through Data cleanup → Unknown files (unchecked by default).

To restore projects and input history, preferably before creating new data in 4.0, fully quit Anas, back up the original files, and move these two files from the data directory root into its `db/` subdirectory (create it if needed):

- `projects.json` → `db/projects.json`: restores project definitions and settings.
- `input_history.json` → `db/input_history.json`: restores input history and pinned inputs.

Both files retain their existing v0 format and need no content changes; restart Anas to load them. If files with the same names already exist in `db/`, back them up separately first. Overwriting replaces the corresponding new data; it does not merge it. This restores only projects and input history, not previous conversations or memory.

To restore plugin data, fully quit Anas, back up your data, and move the entire old `plugins_data/` directory to `db/plugins/` without changing its contents. If the destination already exists, back it up separately first; replacing the directory does not merge the two sets of data.

Avatar resources now live in `config/assets/`. The old root-level `assets/` directory is no longer read, so the default avatar is used until you restore your custom avatar manually. Fully quit Anas and back up your data, then move the entire old `assets/` directory to `config/assets/` without changing its files. If the destination already exists, back it up separately first; replace the directory rather than merging it.

Anas is a local desktop AI agent built with Electron, React, and TypeScript, powered by LangGraph and Deep Agents. Each project can choose its context, tools, skills, and subagents. Configuration and conversations stay locally; requests send the required task content to the selected model provider.

[GitHub](https://github.com/higale/anas-agent) · [MIT License](LICENSE) · [Contributing](CONTRIBUTING.md)

The public repository receives periodic source snapshots. Each synchronization adds one commit; release tags match `package.json`. Daily development history is kept separately.

## Documentation

- User guide: [English](data/help/USER_GUIDE.en.md) · [中文](data/help/USER_GUIDE.zh-CN.md)
- Agent Skills: [English](data/help/AGENT_SKILLS.en.md) · [中文](data/help/AGENT_SKILLS.zh-CN.md)
- [Coding mode and project rules (Chinese)](docs/CODING_MODE.md)
- [Custom tool packages](docs/CUSTOM_TOOLS.md)
- [Current state storage](docs/CURRENT_STATE_STORAGE.md)
- [Security and approval model](docs/SECURITY_MODEL.md)
- [Framework patches](docs/FRAMEWORK_PATCHES.md)
- [Coding evaluation](docs/CODING_EVALUATION.md)
- [Development rules](AGENTS.md)

The application's Help menu opens bundled guides in the right workspace pane, with a contents list and saved reading positions.

## Features

- OpenAI-compatible and Anthropic-compatible providers, streamed replies, context compression, and resumable approvals.
- Source availability in Settings, optional project customization, and independently configured subagents.
- The default project allows only icon (including color), tool access mode, and model (including reasoning options) changes. Its name, working folder, and other settings use defaults; all enabled capabilities apply.
- Built-in file, image, network, memory, and command tools; bundled ripgrep; MCP integration and custom tool packages.
- User and project Skills, prompt shortcuts, input history, and speech input/output.
- Text, image, PDF, and DOCX attachments. Images use native multimodal content blocks; documents are extracted locally.
- A resizable right workspace for subagents, help, and read-only Git or recorded file differences. Monaco supports inline and side-by-side comparison; settings retain a two-column layout.
- Local data backup, restore, logs, and startup recovery.

Capability selection and execution approval are separate. Projects can set the initial tool access mode for new conversations, defaulting to Allow read-only when omitted. Each conversation can change its own mode; changing the project default does not affect existing conversations. See the user guide for each capability's tools and dependencies, and the security model for the three conversation access modes.

## Runtime architecture

LangChain, LangGraph, and Deep Agents own the model/tool loop, messages, checkpoints, interrupts, retries, and subagent orchestration. LangGraph's current checkpoint state is the conversation source of truth. Anas owns Electron lifecycle, configuration, projects, presentation, backups, and other product services.

Each main conversation and its subagents share a SQLite database; the catalog stores conversation locations and shared memory. Completed messages are stored individually, without a second application-owned model history. The current implementation rejects unsupported storage formats and has no legacy-format migration path. Application-owned data now uses explicit `v0` as its compatibility baseline. Earlier unversioned and previously numbered formats are no longer supported; future upgrades follow the [migration policy](docs/DATA_MIGRATIONS.md). See [Current state storage](docs/CURRENT_STATE_STORAGE.md).

Ordinary tools share a managed executor with **8 execution slots** and a **64-call active/queued limit**. Busy slots and conflicting mutations queue automatically. With Background tools enabled, a call waiting or running for over 10 seconds returns a handle for supervision. Cancellation retains execution ownership until the real executor settles; uncertain external outcomes are explicit. Planning, subagent orchestration, user questions, and supervision remain outside this execution pool.

Custom tools run in their package directory. Sources include system packages, user packages in the data directory's `tools/`, added external directories, and project packages in each source folder's `.agents/tools/`. Tools and Skills share directory-tree and file-preview interactions; project tools appear only in project settings. Uncustomized projects use enabled tools; customized projects select All, Custom, or Off. See [Custom tool packages](docs/CUSTOM_TOOLS.md) for execution and import rules.

Shell commands preserve the model's command text, arguments, and search behavior. Supported read-only commands may be approved automatically after target and environment checks; analysis does not rewrite commands to obtain approval. Other commands follow the selected access mode. The security model defines platform support and recovery rules.

## Plugins

The built-in Usage Meter displays the selected model provider's quota, balance, or spend above Settings, with compact/detailed modes, hover details, and a refresh button. It recognizes MiniMax and GLM / Z.ai Coding Plan quotas, DeepSeek and Moonshot/Kimi balances, and OpenRouter key credits and spend by API URL, reusing the provider's API key. Bailian / Qwen China uses `bl` to verify the key and console account, then shows Token Plan quotas and subscription details or ordinary-key free quota and recent usage, with in-widget login. GLM / Z.ai Coding-specific and official Anthropic paths query plan quotas; the China GLM ordinary API shows the CNY account balance with top-up and spend details. The global ordinary API is not supported. Unsupported URLs are hidden; disable it in **Settings > Plugins**.

The overview in **Settings > Plugins** previews a plugin's instructions, skills, and tools. Hover over a name for its description, or click to inspect and copy its content or tool parameters. Previews also work for disabled plugins and never start a backend.

Anas 3.3.8 introduces plugin API 2; API 1 plugins must be updated. RDP plugin 0.1.9 requires Anas 3.3.13 or later: update the host before installing the plugin.

Install optional plugins in **Settings > Plugins** from a ZIP file or `PLUGIN.json`, or drag in one ZIP, manifest, or plugin folder containing `PLUGIN.json` at its root. Plugins can provide side panels, separate windows, optional backends, tools, skills, and static instructions. UI-only or declarative plugins need no backend process. Projects and subagents group contributions by plugin with **All / Custom / Off**; uncustomized projects use all available contributions from enabled plugins. Plugin management controls overall availability. See the [plugin API](docs/PLUGINS.md) and [examples](data/examples/plugins).

## Development

Read [AGENTS.md](AGENTS.md), check the working tree and recent Git history, then install dependencies for the host platform. Optional npm dependencies are required for bundled ripgrep and native modules.

Use Node.js 24 with npm and Git. Install on the target operating system; do not copy `node_modules` between platforms. Native modules may require platform build tools if a matching prebuilt binary is unavailable. Python is needed only for Python-based tools, Skills, or their tests. On Windows PowerShell, use `npm.cmd` if the execution policy blocks `npm.ps1`.

```bash
npm ci
npm run dev
npm run typecheck
npm test -- <test-file>
npm run build
```

Daily development keeps the release version unchanged; increment PATCH once when preparing a GitHub sync. The development repository records sync baselines with ordinary Git refs under `refs/anas/github/v<version>`, without creating tags. Both unpackaged and packaged development builds show a startup/build-time marker such as `3.1.3-dev.5+g9e8317f8.dirty` in the app menu and About dialog. Releases built from independent GitHub source snapshots show only the release version. Without Git or a baseline, no development marker is generated. See the [publishing workflow](docs/SOURCE_PUBLISHING.md).

After startup, add your model provider in **Settings > Model**, then select a model in the message toolbar. No model service credentials are bundled. `data/config/` and `data/.env` are distribution defaults; store personal settings and keys in the application's data directory.

Click the icon before a provider’s name, or drop an SVG, PNG, JPEG, static WebP, or BMP onto it, to replace it; hover to reset it. SVG files must not exceed 1 MB and retain their original vector data. Raster images are automatically center-cropped to a square, reduced to at most 512 × 512 pixels, and saved as PNG, preserving transparency without enlarging small images. GIF and animated WebP are not supported. Templates include brand icons. Images are stored as Base64 in provider configuration and included in backups. An empty image displays the generic icon directly. Only clicking Reset looks up the current API URL in the templates and saves the matching brand icon, or clears the image if no match is found.

`build` checks types, builds main/preload/renderer resources, and verifies main-process dependency boundaries. Run relevant tests for changed behavior. Electron checks use isolated data directories:

```bash
npm run test:e2e -- --help-only
npm run test:e2e -- --startup-only
npm run test:e2e -- --storage-only
npm run test:e2e -- --workspace-only
```

Run builds and packaging serially with backend tests because they share generated output and native dependencies.

| Directory | Responsibility |
| --- | --- |
| `src/main/agent/` | Agent construction, persistence, lifecycle, and IPC |
| `src/main/` | Electron and product services |
| `src/preload/` | Typed `window.gale` bridge |
| `src/renderer/` | React workspace, settings, and shared controls |
| `src/shared/` | Shared types and helpers |
| `data/` | Bundled configuration, help, languages, skills, examples, and assets |
| `patches/` | Required dependency patches applied by `postinstall` |

## Data directory

The default is `~/.gale<program-name>/`, normally `~/.galeAnas/`. The physical executable or application bundle name determines the packaged program name. A renamed copy can use a separate data directory.

Override it with the first application argument, `--data-dir <path>`, or `--data-dir=<path>`. Relative paths resolve from the launch directory; filesystem roots are rejected.

```bash
Anas.exe --data-dir "D:\Anas Data\Research"
./Anas.AppImage --data-dir "$HOME/Anas Data/Research"
npm run dev -- -- --data-dir "./runtime-data/research"
```

| Path under the data directory | Contents |
| --- | --- |
| `config/` | Settings, providers/models, subagents, MCP, Skill sources/availability, and custom-tool sources/ordering |
| `db/catalog.sqlite` | Main conversation directory and shared memory |
| `db/conversations/<threadId>/conversation.sqlite` | One main conversation and its subagents |
| `db/projects.json` | Project definitions and source folders |
| `db/input_history.json` | Global input history and pinned inputs |
| `.env` | Application environment variables |
| `attachments/`, `file_edits/`, `tool_results/` under `db/conversations/<threadId>/` | Attachments, file-edit recovery material and long tool results inside the main conversation directory; removed with that conversation |
| `skills/`, `tools/` | User-managed packages |
| `plugins/`, `db/plugins/` | Installed plugins and independent data; uninstalling retains data unless deletion is selected |
| `skills/_system/`, `tools/_system/`, `plugins/_system/` | Built-in packages refreshed by the app |
| `examples/skills/`, `examples/tools/`, `examples/plugins/` | Examples refreshed by the app; import or install them before use |
| `help/`, `lang/` | Help and language packs |
| `config/assets/` | Avatar source, crop settings, and generated icons |
| `log/`, `cache/`, `tmp/`, `electron/` | Logs, cache, temporary files, and Electron profile |

The `_system/` directory under `skills/`, `tools/` and `plugins/` is reserved for built-in packages refreshed by the app. User packages live alongside it and are not overwritten by these refreshes.

Project source folders are separate from application data. Backups include user tool/Skill packages and use SQLite snapshots, but do not back up project source folders or external Skill roots. They exclude `dev/`, `electron/`, `log/`, `cache/`, `tmp/`, and obsolete layout residues. Restore validates and stages the archive, creates a pre-restore backup, replaces application data, and reloads the app.

Bundled help, system Skills, examples, and built-in language packs are refreshed by the app; edit user packages or add a separate language file instead. See [Language packs](data/lang/README.md).

## Packaging

```bash
npm run pack       # local unpacked application
npm run dist       # alias for pack
npm run portable   # Windows x64 portable package
npm run pack:win:release  # Windows x64 application folder in a ZIP
npm run pack:mac:release  # ad-hoc signed DMG for the current Mac architecture
```

On macOS, `pack` creates an ad-hoc signed app in `release-build/`, without certificate signing, timestamps, or notarization. It does not require `sudo`. Packaging verifies bundled dependencies, including native ripgrep; cross-platform builds require the target platform's packages.

`pack:mac:release` runs on a Mac and produces an ARM64 DMG on Apple Silicon or an x64 DMG on Intel, under `release-macos/`. It uses ad-hoc signing without an Apple developer account, signing certificate, timestamp, or notarization. The build checks the signature and runs the packaged smoke checks. A downloaded app may require **System Settings > Privacy & Security > Open Anyway** after the first launch attempt.

`pack:win:release` runs on Windows x64, verifies the application, then writes `release-build/Anas-<version>-windows-x64.zip`. Extract it and run `Anas/Anas.exe`; keep the entire folder. User data still uses the normal application data directory. Release commands use the standard Electron download endpoints unless mirror environment variables are explicitly set, and never upload packages themselves.

The [GitHub Actions workflow](.github/workflows/release.yml) builds all three packages on native hosts when a `v<version>` tag is pushed. It publishes a GitHub Release with the three downloads and SHA-256 checksums only after all builds pass. **Run workflow** builds downloadable artifacts without publishing a Release. See [source snapshot publishing](docs/SOURCE_PUBLISHING.md) for repository setup and release steps.

### Opening the macOS download

Download the DMG matching your Mac from [GitHub Releases](https://github.com/higale/anas-agent/releases), open it, and drag Anas into Applications. Launch the installed copy. If macOS blocks it because the developer cannot be verified, use **System Settings > Privacy & Security > Open Anyway**, then confirm **Open**, as described by [Apple](https://support.apple.com/102445).

If that route does not resolve a download-quarantine block, and you trust this release, compare the DMG's `shasum -a 256` output with its entry in the release's `SHA256SUMS.txt`. Then remove only the installed Anas app's quarantine attribute:

```bash
xattr -r -d com.apple.quarantine "/Applications/Anas.app"
```

Adjust the path if installed elsewhere. Use `sudo` before this command only if it fails with a permissions error and the path is correct. This removes download quarantine; it does not repair a damaged app or provide Apple notarization. For a signature verification failure, download a fresh copy; do not bypass a malware warning.

The release build already applies and verifies an ad-hoc signature. Users should not normally run `codesign --force --deep --sign -`: it replaces nested signatures, and [Apple reserves deep signing for emergency repairs](https://developer.apple.com/library/archive/technotes/tn2206/). Developers can rebuild with `npm run pack:mac:release` instead. A future release using [Developer ID signing and Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) would avoid the unidentified-developer/notarization block; current releases use ad-hoc signing.

## License

Anas is distributed under the [MIT License](LICENSE), copyright © 2026 gale. Third-party components retain their own licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md).

Maintainers can follow [source snapshot publishing](docs/SOURCE_PUBLISHING.md) to publish a version without exposing daily development history.
