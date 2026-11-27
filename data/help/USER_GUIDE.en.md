# Anas User Guide

Languages: [English](./USER_GUIDE.en.md) | [中文](./USER_GUIDE.zh-CN.md)

GitHub: [higale/anas-agent](https://github.com/higale/anas-agent) · License: [MIT](https://github.com/higale/anas-agent/blob/main/LICENSE)

Anas is a local desktop agent. Configure context, tools, skills, and subagents for each project. Settings, conversations, and memory stay on your computer; content needed for a task is sent to your configured model provider.

Choose Help from the lower-left menu to read this guide in the right workspace. Use Contents to jump to sections and links to open related guides. Closing, maximizing, or switching tabs does not interrupt chat.

## Quick Start

1. Add a provider in Settings > Model, including its address, model name, and key.
2. Select a model in the toolbar at the bottom of the message input box.
3. Type and send a message. Add attachments or select a project as needed.

New conversations use the project model, then the global default, then the model selected before creating the conversation. If none is available, select a model before sending. Project models use the project reasoning selection; global defaults use the model's default reasoning; reusing the previous model retains its reasoning selection. Existing conversations and restored drafts keep their selection. Full prompt and request previews in the project editor follow the same order.

During tool execution, one continuous shimmer moves across the entire tool header, including its icon, name, description, status indicators and controls, without affecting clicks or expansion. It stops when awaiting user approval or an answer, or when the call ends. The system's reduced-motion setting keeps the text static.

In Settings → General → Appearance, choose System, Light, or Dark in the Theme row. The “Titlebar icon” checkbox controls the theme shortcut and is on by default. Left-click the theme icon immediately to the left of the chat titlebar menu to toggle between Light and Dark based on the current appearance. Right-click to choose System, Light, or Dark. Each change is saved automatically. Left-clicking in System mode selects a fixed theme; choose System from the right-click menu to resume following your system.

## Projects And Capabilities

When creating or editing a project, a blank name becomes the first available name in “Untitled project 1, 2, 3…”. Folders may be left empty. They then follow **Settings → Conversation → Default project directory**, which defaults to the system Documents directory. The project keeps an empty folder list instead of saving the resolved default path.

Project and subagent settings only allow top-level capability sections to expand or collapse. Headings show selected counts. Inner sources and directories are displayed directly, without disclosure arrows. Clicking an item name toggles its checkbox. In Custom mode, a single bulk-selection icon is always visible beside each main section and subgroup heading, including collapsed main sections. It selects all selectable entries in that group, or clears the group if they are already all selected. Lists grow naturally; scroll the settings area for longer lists. Project directories appear as **Project - directory name** alongside other sources. Within Custom tools and Skills, only the project area has a divider above it; the entire Custom tools section also has a divider above it. Add-directory buttons remain beside the top-level Skills and Custom tools headings, including when collapsed. Open-folder and remove-reference actions remain beside directory headings. Hover over a directory name to see its full path; unavailable directories retain their error details.

Use the add button beside the **Capabilities > Skills** or **Capabilities > Custom tools** heading to select roots containing individual skill or tool package folders. References apply only to this project, without copying files, adding workspace folders, or granting write permissions. Changes take effect when the project is saved; canceling leaves saved settings intact. Removing a reference never deletes files. Empty and unavailable roots remain visible; unavailable roots show errors and can still be removed. Sources keep independent selections, with project directory order taking precedence for duplicate names. Back up referenced files separately. Projects no longer automatically discover `.agents/skills/` or `.agents/tools/` under source folders. Existing files remain intact; to keep using them, add those roots manually and check their selections in the capability list.

The sidebar shows pinned projects, projects, then the separate default project. Drag a project name to reorder it within its group, or a conversation name to reorder it within its project. Pinned and unpinned items sort separately; dragging cannot move items between groups. Release to save or press Esc to cancel. After manual sorting, new items appear before unpinned items, and message updates preserve the saved order. The default project stays last.

All projects share the same settings. Former simple-chat projects retain their names, prompts, model selections and conversations. Missing settings use the project defaults: all available capabilities enabled, coding mode off, and the global default project directory (system Documents when unset) when project folders are absent. Disable unwanted capabilities in project settings.

The project editor directly offers prompts, context, tools, skills, and subagents. New projects default to all available capabilities; each setting can be adjusted without a master switch. Existing projects use their saved choices and prompts directly, without automatic conversion or reset. Settings manages source availability; there is no global default-capability page. Coding mode controls the development workflow without increasing access permissions.

The default project name cannot be changed. All other settings work the same as for regular projects, including its icon, color, working folders, permission mode, model and reasoning option, coding mode, and capability selections. An empty folder selection follows the global default project directory; saved folder selections are preserved. Project and compression prompts and capability selections can be edited directly and take effect when saved.

Click the project icon to choose a built-in icon or upload an image. Project and provider icons use the same import rules: raster images are center-cropped to a square of up to 128 × 128 pixels without enlarging small images. SVGs retain their vector format. Choose a built-in icon to switch back, then save the project.

- File read, File write, and Memory expand into individual choices. Use each group switch to select or clear all items. Saved selections that are deleted or unavailable can still be deselected.
- Every tool listed below requires a model that supports tool use with **Tool use** enabled. Context-only capabilities do not require tool use. Using a skill also requires tools for reading its instructions and performing its task.
- Capabilities select available tools; the conversation's access mode determines when an operation needs approval. Disabling File read, File write, or Network access removes those specific tools. Commands and MCP tools may still provide similar operations.
- Changes apply to tasks started afterward. Running tasks and tasks awaiting recovery retain their original selection.

Projects and subagents use standard checkboxes for custom tools, MCP servers, plugins, subagents and skills, with multiple entries per row and no item icons. Disabled or unavailable entries use warning-colored names, with reasons in tooltips instead of status labels. Top-level resource groups retain All / Custom / Off and show selected counts; choosing All or Off preserves custom choices. Each MCP server or plugin is selected as a whole; individual entries have no mode controls or nested contribution selections. Global availability, load errors, dependencies and project limits still apply.

Defaults include newly available MCP servers and plugins; configurations that explicitly limit sources keep unselected new sources off. Switching top-level modes retains custom lists; editing an individual checkbox switches its group to Custom. If the complete MCP catalog is unavailable, saved servers can still be deselected.

Selected ordinary skills follow global shortcut and model availability. Selected project skills enable both uses; subagents only use skills through the model. Globally disabled uses remain unavailable while the local checkbox may stay selected.

- **Enable all** enables built-in capabilities, sets the MCP, Plugins, and other groups to All, and clears the project capability limit. Global availability still applies.
- **Disable all** turns capabilities off while retaining custom MCP, plugin, tool, skill and subagent selections.

In **Settings > Tools**, select Built-in tools or MCP to view tools grouped by capability or server. Below the divider, browse custom tool sources and package files. Select a built-in or MCP tool name to inspect its parameters and full description.

Project skills appear in **Project - directory name** groups alongside other sources in **Capabilities > Skills**. Selecting a skill enables both shortcuts and model use. Directory actions are independent of selections. Changes are saved with the project; Cancel does not write them.

### Coding mode

**Coding mode** is independent of capability selections. It adds development guidance such as inspecting code before editing, preserving existing changes, and verifying results. Its compression summary preserves file changes, test evidence, and unfinished work. Models, tools, and access permissions continue to follow their separate settings.

The application automatically reads applicable AGENTS rules in full and adds them directly to the system context; the model does not need to call a read tool first. Within a directory, `AGENTS.override.md` takes precedence; `AGENTS.md` is used only when the override is absent. Deeper rules apply only to their directory trees. Rules consume input tokens, and each run retains snapshots of directories already checked.

The initial context includes rules applicable to the primary working directory. Other directories are discovered from structured file operation targets. A write requiring rules the model has not yet seen first returns “NOT EXECUTED”, allowing the model to reconsider with the new rules. Arbitrary shell commands, MCP tools, and custom tools without declared file targets do not automatically check every affected path.

Regular workspace projects provide **Project prompt** and **Compression prompt** tabs. Leave the compression prompt empty to use the current mode's built-in default, or choose **Load default** to start editing its full text. Nonempty text replaces the default entirely; clearing it restores the default. Changes are saved or canceled with the project. Both prompts can be edited directly and take effect when the project is saved. Custom compression applies only to the main conversation; subagents use built-in templates. Changing coding mode does not overwrite custom text.

Custom compression prompts allow up to 50,000 characters and must contain exactly one `{conversation}` placeholder; `{output_language}` is optional. Automatic and manual compression use the same template. Existing tasks and their resumptions retain the custom content selected at launch.

The menu beside the left-hand title area opens full prompt, compression prompt, and request previews. The read-only compression preview shows the effective template for the current draft: the built-in default when the custom text is empty, otherwise the full custom template. Previews do not include subdirectory rules that would only be discovered by future operations.

### Profile

Supplies the assistant name and role from **Settings > General**. Older custom instructions remain in the settings file and can be copied into the role setting. With **Update configuration** enabled, the Agent can change the assistant name, role and avatar on request. The selected memory mode handles preferences such as forms of address and response style. View and edit global preferences under **Settings > Memory**. Existing user profile values remain in configuration and are excluded from conversations and automatic memory import. Subagents receive assistant profile context according to their own capabilities and project limits.

### Runtime Environment Information

Supplies the system, date, directory, command environment, and custom information selected in **Settings > Environment**. It provides context without installing programs or enabling command execution.

Projects and subagents with **Runtime environment information** enabled receive the instructions selected in **Settings > Environment**. These instructions remain visible when command execution is disabled. See [Runtime environment and variables](#runtime-environment-and-variables).

### Project Information

Supplies the current project name, source folders, and path instructions, with no separate tool. Turning it off leaves the source folders in use as working directories and for access checks. The project prompt is controlled separately.

### .env

Controls whether commands and custom tools additionally receive variables from the application data directory's `.env` file. Edit the file in **Settings > Environment**.

It has no separate tool. Turning it off preserves inherited system environment variables and the `.env` file. It does not change model connections or shared MCP server configuration.

### Background Tools

Allows long-running built-in, custom, and MCP tool calls to continue in the background so the Agent can inspect, wait for, or cancel them. The following tools depend on one another and are enabled or disabled as a group, not selected individually. Turning this off makes new calls wait for completion; it does not cancel existing calls.

| Tool | Function |
| --- | --- |
| `read_call` | Inspect this conversation's background call status, progress, and terminal information. |
| `read_call_output` | Read ranges of output and results. |
| `wait_call` | Wait for a call to finish or for the wait to time out. |
| `cancel_call` | Request cancellation of a background call. |
| `write_call` | Send text or keys to an interactive terminal, or resize it. |

`write_call` requires **Command execution** or a selected interactive custom tool, with a terminal allocated at launch. A normal command cannot gain interactive input afterward. Background subagent tasks are controlled separately by **Subagents**.

Calls queue automatically when tools are busy; do not submit them again. Calls that take longer to wait or execute return an ID so the Agent can check their results later.

### Planning

Provides `write_todos` to create and update the current task's plan and completion status. Useful for multi-step work. A plan does not execute commands or edit files; those actions still require the relevant capabilities.

### Command Execution

Runs programs, scripts, searches, tests, and builds through the system command interpreter. The tool uses its actual program name, such as `zsh` on macOS or `pwsh` or `powershell` on Windows. A supported command interpreter must be available.

Bundled rg supports file and text searches without a separate installation. Python and Node.js must be installed as needed. Follow-up terminal input requires **Background tools**; application `.env` variables are controlled separately by **.env**. Commands follow the conversation’s access mode.

Command execution manages only the directly launched Shell. Its exit completes the call; cancellation, timeout and exiting Anas stop only that Shell. Stop its children explicitly when needed. With Background tools enabled, a long-running Shell can continue across turns after returning a call ID; stopping the reply does not cancel that yielded Shell. Use `read_call` / `wait_call` for status and `cancel_call` to stop a live Shell. Cancelling a completed call does not stop its children. Completed results directly include known remaining direct child processes.

Open **Process list**, below **Project memory** in the workspace menu, to view the Shell and its direct child processes for the current conversation in the right sidebar. Descendants started internally by those applications are excluded. It refreshes automatically and supports manual refresh and individual termination after identity checks. Only identified associations are shown; applications launched by system services or reused instances may be absent. Closing an interactive terminal can cause attached programs to exit through operating-system console-close or hangup behavior.

On Windows and macOS, successful Shell commands with complete standard output and no additional status to report return that output verbatim to the model. Errors, truncation, or remaining processes add only the necessary fields; the original command and internal process snapshot are not repeated. `read_call` / `wait_call` recheck recorded process identities and return only the names and PIDs of direct children confirmed alive at query time. Observation failures are reported explicitly.

### Network Access

Provides `http_request` for HTTP/HTTPS requests, API calls, uploads, and downloads. The destination must be reachable and any required authentication must be supplied. This is not browser automation.

The tool can upload or download files independently of **File read** and **File write**, while still following file access approval rules. This switch does not control MCP connections or network access through commands.

### Update Configuration

Provides `update_config` to change supported application settings at your request, such as the theme, font size, and profile. It currently supports application settings fields, not arbitrary changes to project, model, or MCP configuration files.

It does not require **File write**. **Strict approval** requires confirmation for each call; **Smart approval** uses the model’s assessment; **Full access** skips that prompt.

### User Interaction

Provides `request_user_input` so the Agent can present questions with choices or a text answer. Useful for missing information, clarification, and decisions. You can cancel; ordinary questions may also time out.

It does not require **Background tools**. When disabled, the Agent can still ask in chat but cannot open this question dialog. Execution approval dialogs are controlled separately.

### Wait

Provides `sleep` so the Agent can pause before continuing, for example before checking a webpage or chat reply again. The required `seconds` parameter accepts integers from 1 through 300; the optional `summary` describes the reason. Completion returns the actual elapsed seconds; observing changes still requires the appropriate tool afterward.

This capability has its own switch in project and subagent settings, independent of **Command execution** and **Background tools**. It waits inline without switching to a background call after 10 seconds. Stopping the run cancels the wait.

The chat entry shows a clock icon and remaining seconds. When the countdown reaches zero it waits for the actual result, then shows the elapsed time.

### File Read

Reads and inspects local files without requiring **Command execution**. Verified reads are exempt in every access mode, including files outside project folders.

| Tool | Function |
| --- | --- |
| `read_file` | Read one UTF-8 text file, optionally by line range; binary contents are not supported. |
| `read_multiple_files` | Read several text files with individual results. |
| `view_image` | Send one local image to the current model for visual inspection. |
| `view_multiple_images` | Inspect up to 10 images in order, labeled by path, with per-file errors. |
| `list_directory` | List a directory's immediate children. |
| `directory_tree` | Inspect a directory tree in pages, up to 64 levels, without following symlinks. |
| `get_file_info` | Inspect type, byte size and timestamps; automatically include image dimensions/orientation or audio/video duration and tracks. |

Image tools require a vision-capable model with vision enabled in its configuration. They support PNG, JPEG and WebP without Command execution. Original images are sent without resizing or re-encoding; limits are 8 MiB per image and 16 MiB of image data per batch.

`get_file_info` reads file information without interpreting image contents. No extra media analysis program is required.

For text searches, use rg through **Command execution**. This group has no separate search tool.

### File Write

Creates, changes, moves, or deletes local files without requiring **Command execution**. Select only the tools needed. Enable a suitable reading tool when the Agent should inspect existing content first. Write approval follows the current mode, safe directories, and model assessment; see [Tools And Approval](#tools-and-approval).

| Tool | Function |
| --- | --- |
| `apply_patch` | Edit files by context using the Codex patch format; the JSON tool interface supports a preview without writing. |
| `write_file` | Create a text file or explicitly replace the entire contents of an existing file. |
| `document_to_markdown` | Convert a PDF, DOCX or PPTX to a new Markdown file and export embedded images. See [Attachments and voice input](#attachments-and-voice-input). |
| `restore_file_edit` | Undo a complete recorded `apply_patch` or `write_file` operation. Recovery data must still be available; conflicting edits are not overwritten. |
| `get_file_edit_diff` | Inspect recorded Agent file changes, rather than Git working-tree changes. This tool itself is read-only. |
| `create_directory` | Create a directory and missing parents. |
| `move_file` | Move or rename files and directories. |
| `delete_file` | Delete files or directories. |

OpenAI Responses uses the native Codex freeform patch call and requires provider support for `custom` tools; other interfaces wrap the patch in JSON arguments, with no separate tool-format setting. Matching tolerates the whitespace and punctuation differences defined upstream. Updated nonempty files receive a trailing newline. Use `write_file` when complete text and its trailing-newline state must be preserved exactly.

### Memory

In **Settings → Memory**, choose **Foreground memory** or **Background extraction** (default). In foreground mode a chat model with tool support can call `update_memory` for global or current-project preferences. The call and result appear in chat. A successful write advances that chat’s progress through the current user message. Switching back resumes background extraction after that point. Chats without a successful write retain their previous progress.

Background processing extracts reusable preferences from saved workspace conversations and consolidates global and project memory. With the project's Memory capability enabled, requests include both completed preference documents. One-off requirements, code-version facts and transient progress are not permanent preferences. The first message you send after creating or switching to a chat triggers a check for unprocessed content in all other memory-enabled workspace chats. Browsing chats, sending more messages in the same chat and restarting the app do not trigger a check.

Choose the background memory model in the upper right of **Settings → Memory**. You can change this selection in either mode. Background extraction uses the selected model. The button then shows the model name. Click it again to change or clear the selection. Without a selection, or when the model is unavailable, generation pauses and existing preferences remain readable. Changes may take time; request corrections or forgetting in conversation.

Open **Workspace menu → Memory activity** below Plugins. Use **Title bar button** in the upper-right corner of the panel to toggle the shortcut. It is shown by default and animates while processing. Open it to inspect sources, stages, model, evidence, inputs, outputs and the resulting memory text in a sidebar or separate window. Closing the panel does not stop processing. Call details stay in memory until the next run starts or the app exits. The panel shows reported input and output tokens and how many calls reported usage. View and edit global Markdown under **Settings → Memory**. If memory changes while you edit, compare your draft with the latest text before saving. In the chat window, open **Workspace menu → Project memory**, just below **File changes**, to view and edit the current project’s Markdown. The panel title identifies the project, and moving between the sidebar and a separate window preserves your draft. Save or cancel your edits before closing the panel. The old memory tools are removed; old tables remain untouched and are neither read nor migrated. Fresh installations do not create them.

### Custom Tools

Provides your configured programs or scripts as tools for the model. Prepare their programs, dependencies, and accounts. **Command execution** is not required; interactive tools also need **Background tools**. See [Manage Custom Tools](#manage-custom-tools) for setup and selection.

### MCP

Each MCP server has one checkbox. Selecting it includes all available tools from that server, including future tools; clearing it disables them all. Globally disabled servers and servers without saved catalogs provide no model tools; a server with a saved catalog can start when a tool is called.

Enable the server in **Settings > MCP** and start it at least once to save its tool catalog. Project selection only chooses available tools; it does not open a connection or override global disabling. Tool functions, parameters, required software, and accounts depend on the server. They do not require similarly named built-in file or network capabilities. Saved selections remain removable when unavailable.

### Subagents

Delegates independent tasks to other Agents for parallel investigation and division of work. The following tools depend on one another and are enabled or disabled as a group, not selected individually.

| Tool | Function |
| --- | --- |
| `start_subagent` | Start an allowed subagent. |
| `read_subagent` | Inspect a subtask's status and progress. |
| `wait_subagent` | Wait for progress, completion, or a request for approval. |
| `cancel_subagent` | Cancel a specified subtask. |

Configure and enable subagents in **Settings > Subagents**. Projects and subagents select permitted definitions with checkboxes. An empty selection prevents new launches. Globally disabled or incomplete definitions cannot be launched. This capability does not require Background tools.

Subagents use their own capability settings. Further delegation cannot exceed the original project’s allowed set. **Limit subagent capabilities** separately constrains context, tools, and skills at every level to the intersection of project and subagent choices. Otherwise each subagent uses its own configuration. It receives the delegated task, not the complete parent conversation automatically.

For custom subagents, choose a model and parameter preset beside **Identifier**. **Use parent Agent's model** uses the nearest ancestor's selected model and preset. An explicit selection applies to newly created subtasks; clear it to restore inheritance. Editing a subagent definition does not change existing subtasks' model bindings. Missing models or presets produce an error rather than switching to another model.

Subagents use directory packages:

```text
subagents/<folder>/
  AGENT.json
  PROMPT.md
  skills/<skill>/SKILL.md
  tools/<tool>/TOOL.json
```

New custom Agents start disabled with every capability turned off; enable capabilities as needed.

`AGENT.json` contains `version: 0`, a stable `id`, `name`, `description`, `capabilities`, and optional model selection. `PROMPT.md` contains the system prompt. Create an Agent in Settings, then use **Show in folder** to add standard Skills, tools, and supporting files. **Import subagent** at the top right accepts multiple package folders. The entire selection is checked before import; a conflicting ID or name, or an invalid package, stops the batch. Import includes scripts, skills, tools and the contents of linked files and directories. The copy stays editable after the source moves. **Add directory** at the top right references external Agent directories. The left pane groups packages and their files under All, Built-in, User, and external directories; the right pane shows Agent settings or a file preview. Preview and edit custom prompts through `PROMPT.md` in the file tree; the Agent settings form no longer duplicates the prompt editor. Refresh after external changes.

**Add external directory** selects a parent folder containing Agent packages and references the original files without copying them. Rename, reorder, or remove directory references; removing a reference preserves its files, while deleting an Agent deletes its package. Newly created and imported packages are saved in the user directory. Agents can be reordered within their source. Missing directories, invalid packages, and ID/name conflicts show errors without blocking other valid packages. Unavailable packages retain their enabled states. Backups include external directory references, not their files; back up those directories separately.

The left toolbar's move-up, move-down, and delete buttons act on the selected external directory or Agent. These actions are unavailable for built-in Agents, fixed groups, and package files.

Only `general-purpose` is built in under `data/subagents/` in the application package, handling general execution tasks. Its definition and all package files are maintained by the app and can only be viewed, not edited, renamed, or deleted. It always uses the parent Agent’s model with all capabilities enabled, subject to global availability and the project’s subagent limits. Settings retain only the Agent’s enabled switch; there is no **Restore default** action. Custom Agent packages remain editable.

`data/examples/subagents/` in the application package provides `web-researcher` (external research and source verification) and `project-analyst` (read-only project analysis). Examples are not loaded automatically. **Import subagent** opens this directory by default; select one or more packages to copy them into the user directory, where they can be edited, disabled, or deleted. Examples are read directly from the application package; imported copies are stored independently. **Add directory** cannot reference bundled examples as an external source. Existing references are retained in configuration and shown as unavailable, without exposing package files for editing.

Custom package Skills and tools start enabled and can be disabled individually in that Agent's resource section. They are available only to their owning Agent and do not appear in global catalogs or the main Agent's resources. Turning a capability group off disables its package resources too. When **Restrict subagent capabilities** is enabled, the project must also allow these resources. Project sources labeled **Subagent only** grant access to subagents only. Within the allowed selection, package resources take precedence over resources with the same name. Skills still require file reading. Definition changes, package deletion, and file edits are rejected while a package tool is running; retry when it finishes.

Package resource switches are part of capability settings: `capabilities.skills.package` and `capabilities.custom_tools.package` map package-local names or IDs to `true` or `false`; omitted entries default to enabled. Custom packages store these choices in `AGENT.json`, so copying or importing a package carries them along. Built-in packages do not expose resource switches.

`config/subagents.json` now uses v1 for order, external directory references, and whole-Agent enabled states; it stores no built-in overrides. The previous v0 array format is not migrated or supported. Old files are retained with an error; backups containing that format cannot be restored directly. Quit the app, preserve the old file separately, then move `config/subagents.json` out of the data directory. Restart and recreate or import your Agent packages. Do not simply change the old file's version number.

### Skills

Supplies the names, purposes, and instruction paths of available skills, or lets you invoke them with `/name`. Skills are instructions, not separate callable tools, and do not grant file, command, or network capabilities.

Skills use individual checkboxes; only the top-level section can collapse. Plugin skills are selected with their plugin, independently of the ordinary Skills list.

Ordinary skills have separate Shortcut and Model availability settings on the Skills page; plugin skills have these options in plugin settings. These choices are the upper limit for each skill’s uses. Projects and subagents select whole skills and cannot enable globally disabled uses. Subagents only use skills through the model. Selected project-local skills enable both shortcuts and model use.

Explicit invocation sends the unchanged skill file and its source path, keeping the user request separate; expand the skill entry to inspect the submitted text. Autonomous loading and reading supporting files require `read_file`, `read_multiple_files`, or **Command execution** capable of reading files. Scripts also need their command interpreter, runtime, tools, and accounts. Selecting a skill does not satisfy those dependencies automatically. Manage global sources and availability in **Settings > Skills**; add project skill roots beside the **Capabilities > Skills** heading in the project editor. See the [Skills Guide](./AGENT_SKILLS.en.md) for installation, name conflicts, and authoring, and each skill's `SETUP.md`, if supplied, for installation requirements.

## Models

OpenAI-compatible and Anthropic-compatible services are supported. Manage models in Settings > Model and switch between them below the message input.

**New** at the top left offers a blank provider configuration or a template. The same toolbar provides move-up, move-down, and delete actions for the selected provider. The model list on the right has its own actions. **Fetch available models** remains in the add/edit model dialogs and updates only the candidate list, preserving configured model capabilities and parameters.

Provider menus offer separate OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages templates for confirmed endpoints, with Responses listed first where available. Each template fills in its protocol, Base URL, and model list URL separately. When changing an existing provider's protocol, check its Base URL as well. Template updates do not overwrite saved configurations. Endpoint availability and tool support still depend on the provider, model, and local server version.

As specified in the [official Zhipu documentation](https://docs.bigmodel.cn/cn/guide/develop/responses/introduction), the GLM Responses template uses `https://open.bigmodel.cn/api/v1`, while Chat Completions uses `https://open.bigmodel.cn/api/paas/v4`; both fetch models from `/api/paas/v4/models`.

Tencent Cloud templates are under China → Tencent, grouped into [TokenHub pay-as-you-go](https://cloud.tencent.com/document/product/1823/130079), [Token Plan](https://cloud.tencent.com/document/product/1823/130060), and [Coding Plan](https://cloud.tencent.com/document/product/1823/130092). The first two provide protocol templates for Guangzhou and Singapore. Token Plan's Guangzhou endpoint serves both personal and enterprise plans; personal General and Hy plans share an endpoint and API key. Use the key and model ID for your purchased plan and region. Enterprise Lite supports only `auto`; personal Auto uses `tc-code-latest`. Token Plan templates fetch the platform model catalog from `/v1/models` in the same region while model calls continue through the plan endpoint. The list includes online models and is not filtered by purchased plan. For an existing provider, restore the template defaults in its model list URL settings, then fetch the list again. Coding Plan provides Chat Completions and Anthropic Messages templates with separate endpoints and keys. If model discovery is unavailable, enter a model ID from the Tencent Cloud console.

The Responses protocol currently sends `apply_patch` as a custom/freeform tool. [MiMo requires Responses Lite for these tools](https://mimo.mi.com/docs/tokenplan/integration/codex-configuration), which Anas does not yet implement. Selecting the MiMo Responses template does not remove this limitation; use its Chat Completions or Anthropic Messages template when you need the patch tool.

Click the icon before a provider’s name, or drop an SVG, PNG, JPEG, static WebP, or BMP onto it, to replace it; hover to reset it. SVG files must not exceed 1 MB and retain their original vector data. Raster images are automatically center-cropped to a square, reduced to at most 128 × 128 pixels, and saved as PNG, preserving transparency without enlarging small images. GIF and animated WebP are not supported. Templates include brand icons. Images are stored as Base64 in provider configuration and included in backups. An empty image displays the generic icon directly. Only clicking Reset looks up the current API URL in the templates and saves the matching brand icon, or clears the image if no match is found.

The API key field accepts a literal key or a `${VARIABLE_NAME}` reference. Its dropdown groups suggestions from the application `.env` file and system environment, matching names containing `KEY`, `TOKEN`, or `SECRET` without case sensitivity. It shows names and empty-value status, with no search box. Manually entered references need not match those keywords. Names can contain spaces, Unicode characters, and hyphens, or begin with digits. Names inside references are preserved exactly: `${ TEST_API_KEY}` differs from `${TEST_API_KEY}`. Dropdown names with leading or trailing whitespace are quoted for display only; the quotes are not part of the name. The reference syntax excludes empty names, equals signs, braces, line breaks, and null characters. The `.env` parser continues to trim whitespace around assignment names. Valid references can be saved before the variable is configured. Missing or empty values produce an explicit error when requesting a model, fetching the model list, or querying usage. References remain visible; literal keys are masked when the field loses focus.

A non-empty value in the application data directory's `.env` takes priority over the same system variable. Saving `.env` in Settings reloads it immediately. External edits are not watched; reopening the dropdown or restarting the app rereads the file. System variables come from the current Anas process environment, so operating-system changes require restarting Anas; in development mode, also reopen the terminal used to launch it. Changes do not affect requests already sent. Configuration stores the reference, and an empty field never selects a variable automatically. The project's `.env` capability switch does not affect model connections.

The settings list and model picker use the same two-line layout: the model name above, followed by the context limit, maximum output, compression threshold, and capability and reasoning icons below. An unset maximum output or disabled compression is shown as “—”.

Changes to the model name, capabilities, context limits, extra parameters, and reasoning options remain drafts until you choose **Save**. Choosing **Cancel** or closing the editor discards those changes.

Vision models with image limits configured have a theme-colored center in their eye icon. Hover over the eye, a model option, or the current model selection button to see the configured image limits and size measurement basis. Models without configured limits show “Image input limits: not configured”.

The small settings button beside Vision opens Image input limits: minimum short side, maximum long side, pixel count, aspect ratio, bytes per image and images per request. Empty fields add no limits. Byte inputs use comma grouping and decimal K/M abbreviations; choose original-file or Base64-payload size. Attachments are checked for dimensions, aspect ratio and size when added; invalid images are rejected with a reason. Submission rechecks the current model and counts images actually sent, including retained historical attachments and pending tool images; failures preserve the draft. Count overflow after tool execution omits the entire image batch with an explanation; other tool image rules omit only the affected image. Originals remain intact, with omission details in the activity view. One-turn attachments do not carry over to later turns; conversation attachments count while retained in context, and consumed tool images are no longer sent. Remote URLs and file IDs are not checked or counted. Confirm the child dialog, then Save in the model editor to apply the changes.

Set Vision and Tool use to match the model's actual capabilities. Turning Tool use off prevents calls to built-in tools, MCP tools, and subagents. Profile, runtime information, project information, skill listings, and automatic memory recall still follow capability settings; saved choices are unchanged.

### Usage information

In **Settings → Models**, select a provider. **Show usage information** on the right of the API Key label controls the sidebar meter. Supported API URLs default to on; unsupported or invalid URLs disable and clear the checkbox. Switching back to a supported type enables it by default. Editing a URL within the same supported type, reopening settings, or restarting preserves a manual off choice. Models under the same provider share this setting.

Tencent and Bailian have a settings button after the checkbox, available even while display is off. Enter Tencent SecretId / SecretKey or Bailian AccessKey ID / Secret. Cancel discards edits. Secrets are visible only while their input has focus and are masked again on blur. Credentials are saved per provider in `config/models.json` and included in ordinary backups; masking is not encryption. Query credentials do not use the application `.env`. Changing the URL retains saved provider credentials.

The meter follows the current model at the bottom of the conversation sidebar. It supports compact/expanded views, hover and keyboard-focus details, and immediate refresh. Layout is saved per provider and defaults to compact. Automatic queries cache results for five minutes; changing layout or language only redraws cached data. Disabling display stops queries; URL or credential changes clear old-context readings. Unsupported addresses hide the meter. Ordinary query failures retain successful readings from the same context; Bailian failures clear them.

Supported services:

- MiniMax Token Plan: independent five-hour and weekly quotas, including returned weekly boosts. Percentages show remaining quota; reset time is not subscription expiry.
- GLM / Z.ai: Coding Plan quotas; the China ordinary GLM API shows CNY available balance and returned breakdowns. Balance excludes resource packages and plan quotas. The international ordinary API is unsupported.
- DeepSeek and Moonshot / Kimi: balance and breakdowns. Moonshot China uses CNY and the international service USD; currencies are not summed.
- MiMo: ordinary spendable balance after frozen funds; personal Token Plans in China, Singapore and Europe show Credits, periods and auto-renew information.
- OpenRouter: current-key credits and spending. “No cap” does not indicate a funded account.
- Tencent: the query credentials’ cloud account balance and current-month ordinary TokenHub usage in Guangzhou or Singapore; Guangzhou personal General / Hy plans are shown separately. These are not current-model-key statistics. Enterprise plans are not queried; Singapore plans and Coding Plan show cloud account balance only.
- Bailian China: direct RAM AccessKey queries, without installing `bl` or browser login. Plan keys are checked against sufficient visible masked-key prefixes and suffixes, then actual quota windows and subscription details are shown. Ordinary keys require a full match before querying current-model free quota and seven-day online calls for that key. Missing Token details are explicitly reported, never filled with zero or replaced with workspace-wide statistics. International and dedicated team-plan endpoints are unsupported.

For Tencent queries, grant `ReadOnlyAccess` to the Tencent Cloud user associated with the query credentials, then enter its SecretId and SecretKey in **Settings → Models → Usage query settings**.

Tencent and Bailian usage settings both provide **Show balance**. Tencent defaults to on. Turning it off stops the independent balance request while retaining supported usage and plan queries; balance-only endpoints hide the meter. When enabled, balance appears before usage.

Bailian defaults to off. When enabled, Anas independently queries the Alibaba Cloud account cash balance with the same RAM credentials, requiring `AliyunBSSReadOnlyAccess`; details include available credit and credit limits. Usage and balance report their results separately, so one failing does not hide the other’s successful result.

Bailian RAM users need [both authorization layers](#bailian-ram-authorization-and-query-troubleshooting). For missing credentials or authorization errors, **Configure** returns to the current provider’s settings.

Usage information reads only model settings and does not import the retired Usage Meter plugin’s enabled state, credentials or display preference. Existing native usage settings remain valid. Missing settings default to enabled for supported endpoints, compact display and empty query credentials; enter any additional credentials in model settings. Usage information no longer appears in the plugin list and requires no plugin backend. Model configuration and database versions are unchanged.

### Bailian RAM authorization and query troubleshooting

1. Create a user and AccessKey in the [RAM console](https://ram.console.aliyun.com/) and grant `AliyunTokenPlanReadOnlyAccess`, `AliyunBSSReadOnlyAccess`, and `AliyunModelStudioFullAccess`.
2. Add that RAM user in [Bailian → Account Management](https://bailian.console.aliyun.com/settings/workspace), then go to **Permission Management → Add Permission → Select Workspace** and add “Agent operations” (智能体-操作).
3. Enter the AccessKey ID and Secret in Anas under **Settings → Models → Usage query settings**, save, and refresh usage.

## Tools And Approval

Project capability settings select available tools; the model's Tool use setting determines whether it can call them. See [Projects And Capabilities](#projects-and-capabilities) for functions and dependencies.

Below the folders in project settings, choose the default permission mode on the left and the model and reasoning option on the right. New conversations inherit this mode and can override it beside the input. Changing the project default does not affect existing conversations. An omitted setting defaults to Smart approval.

The permission mode button below the message input shows the full name when it fits and keeps the shield and dropdown arrow when space is limited. Hover over it or focus it with the keyboard to see the current mode. Open the menu for a description of each mode. Select “Learn more” in its upper-right corner to open this guide in the sidebar at “Tools And Approval”.

- **Strict approval**: verified reads anywhere and writes inside project, application temporary, or system temporary directories run automatically. Other operations require confirmation.
- **Smart approval**: the default. In addition to strict-mode exemptions, writes inside Desktop, Downloads, Documents, and Pictures are allowed. The model assesses remaining operations; omission requests confirmation. Code-verified safe operations always run automatically. Freeform patches use target checks only and require confirmation for writes outside safe directories.
- **Full access**: skips pre-execution permission approval while retaining validation, cancellation, and recovery confirmation. Change modes beside the input; queued calls recheck the current mode before dispatch, while operations already started are not interrupted.

Only Smart approval adds the required `needs_approval` parameter to model-facing JSON tool definitions. The model must explicitly provide it on every call; execution still falls back to `true` if it is omitted. Automatic code exemptions take priority, then remaining operations use the model’s value. Strict approval, Full access, and Freeform patches do not expose this parameter. Tool details in Settings let you switch modes and patch formats to inspect their definitions. Mode changes preserve historical call arguments; queued calls recheck the current mode before execution.

An external operation with an uncertain outcome still requires confirmation before retrying. A conversation awaiting confirmation cannot accept messages, history edits, regeneration, or compression. Other conversations remain available.

Subagents can work in the background. Select a subagent status entry to view its task, tool calls, and result. Unfinished subagents, including those awaiting approval, are cancelled when the main task ends.

## Runtime Environment And Variables

**Settings > Environment > Bundled rg** controls rg instructions for projects and subagents with runtime environment information enabled. It defaults to on.

Python custom tools require system Python 3 or an explicitly configured interpreter. Install any extra packages in that environment. For a tool whose command explicitly uses `{{bundled_python}}`, change the command to a `.py` entry or the absolute path of your interpreter.

Existing data-directory `runtimes/` contents are preserved without reading, migrating or automatically deleting them. They remain excluded from backups and retained during restore and unknown-file cleanup. **Detect System Environment** inserts system command information at the last cursor position in Custom Environment Information, replacing selected text.

Custom Environment Information is enabled by default. If selected and empty at startup, it is filled by background detection without blocking startup. Existing content is preserved; deselecting it during detection discards the result.

Edit the application `.env` in Settings > Environment to prepare variables for commands, custom tools, and skill scripts. The relevant Agent's .env capability determines whether they receive these variables.

## Manage Custom Tools

The bundled `tool-manager` Skill guides the model through creating, modifying, and troubleshooting custom tools, with a format reference and Python examples. Enable the Skill and required file capabilities, then ask the model to create a tool for the current project. Script testing also requires command execution and the appropriate runtime. Check the capability list to confirm the generated tool is selected.

In **Settings > Tools**, Built-in tools and MCP appear above a divider. Below it, the custom-tool tree lists all packages, system tools, user tools, and added directories. Select a group name to list its tools on the right; use the boxed arrow to expand or collapse it. Select a tool from the list to view its details. Click a detail title to locate its directory, or expand packages to browse and preview files. User and added-directory tools support creation, editing by double-click, deletion, and ordering; deletion moves the entire tool package to the trash.

**Add directory** at the top right references an external source in place. Rename its display label, reorder it, or remove the reference without deleting files. Name changes save on Enter or focus loss. The left toolbar provides refresh, plus move-up, move-down, and delete actions for the selected directory or tool. Tools can only move within their source. Fixed groups and package files cannot be deleted or reordered here.

Each directory contains a `TOOL.json` manifest with explicit `"version": 0`, plus scripts or resources. User tools live in the application data directory's `tools/`; project tool roots are manually referenced using the add button beside the **Capabilities > Custom tools** heading and are available only to that project. The editor configures names, descriptions, JSON parameter rules, and commands; it does not generate scripts or install dependencies.

The **New tool**, **Import tools**, and **Add directory** icon-and-text buttons stay at the top right. They use the User directory by default, or the selected external directory when browsing that source, its tools, or its files. Button tooltips show the destination. Import accepts multiple directories and opens the bundled examples by default. The examples provide text reading, Baidu AI Search, file SHA-256, and JSON formatting, all using the Python 3 standard library. Baidu AI Search also requires internet access and `BAIDU_SEARCH_API_KEY`; see its bundled README for setup. Import copies the package and the contents of its file and directory links into the selected destination. You can edit that copy independently. Existing tools keep their names and files.

**Edit information** and **Edit parameters** open the same editor on the corresponding section. Switching sections preserves the draft. The parameter section supports **Parameters / Source**, with controls for names, types, required status, descriptions, enums, limits, and nested object or array parameters. Edit each parameter within the same window and apply it to return to the list. Save the tool to apply all changes together; discarding unsaved changes requires confirmation. Update scripts separately. Use Source for advanced references and composed schemas; other untouched attributes are preserved. Defaults are annotations and are not automatically supplied during calls.

Click a package-local script path in the command to locate it in the file list. If missing, confirm to create an empty file and its parent directories. Existing files are never overwritten.

Import examples and tool templates from the application package into independent user copies first. Project and external directories cannot reference bundled resource directories, their parents, or directory aliases; existing references remain in configuration and appear unavailable. File editing checks the actual target, so links to files in the application package are read-only.

Manage global availability in tool details, and select tools with checkboxes in project and subagent capabilities. Entries are grouped by source, with multiple tools per row. Subagents have independent choices, may select Use current project tools, and follow project limits. For duplicate names, the first valid enabled entry wins: project tool directories in order, then user tools and external directories in order.

Commands run in the tool directory, where relative paths resolve, for example `scripts/run.py {{args}}`. A `.py` entry uses system Python 3. A standalone `{{args}}` receives complete JSON; `{{tool_dir}}` supplies the absolute tool directory. A command starts one program with fixed arguments, without pipelines or redirection. Standard output is returned to the model; pass large inputs through files.

**Interactive terminal (PTY)** supports programs needing follow-up input and requires **Background tools**, without requiring **Command execution**. Leave it off for ordinary text results. A blank timeout means no limit; positive seconds set an execution limit, including time spent waiting for input. Cancellation or timeout terminates the process tree but does not undo changes already made.

## MCP Setup

Add and edit servers in Settings > MCP using stdio, HTTP, or SSE. The server and its tools must be enabled, the model must have Tool use enabled, and the project must allow the server.

Application startup does not connect MCP servers, even when enabled. Models use saved tool catalogs. Start any server without a saved catalog once in settings to discover its tools. A server cannot be switched from disabled to enabled without a non-empty tool list. Manual startup remains available, and an existing enabled selection can still be turned off. Every successful start refreshes and saves tool definitions, including an empty list. Connection or discovery failures retain the previous catalog.

Settings provides Start / Stop and tool checkboxes, including a select-all / clear-all action. Clicking a checkbox or tool name changes availability; hover for the description. View and copy saved tool definitions through **Settings → Tools → MCP**, without starting the server. Servers can be started manually whether enabled or disabled to discover or refresh tools. Enabled controls model availability only; changing it does not start or stop the connection. Catalogs and selections are saved as they change, independently of Stop. Stopping closes the connection and retains the catalog and selections; later calls can start it on demand. Disabling a server or an individual tool removes the corresponding model tools.

Calling a stopped server shows its startup progress in the original tool activity. A successful start continues that call; a startup failure returns an error through the same call. If discovery shows the tool no longer exists, that call returns a missing-tool error. Subsequent model requests use the refreshed catalog without removed tools. Concurrent calls share one startup. Connections remain open until stopped or the application exits.

Use **New MCP server** at the top right to create a configuration. The top-left toolbar moves the selected server up or down or deletes it. The refresh icon checks running servers and reconnects failed or unreachable ones; it does not start servers that have never run or were stopped manually.

For stdio servers, leaving Working directory blank uses the current user's home directory. Enter an absolute path to run the server in another directory.

Disabled servers remain editable. Changing connection settings stops that connection and invalidates its old catalog; start it again to discover tools. Renaming, reordering, and tool selections do not start or restart servers. The tool catalog in Settings > Tools groups tools by server. Projects can further limit tool availability by selecting whole servers.

## Attachments And Voice Input

Attachment descriptions provide the model only with the original full path when known, without the archive path. Cards show the filename; hover to see the original path. Content is read from the archive. When historical image data is omitted, the filename and original path remain available for the model to reopen the source file as needed. App previews continue to use the archived copy of the submitted content. Older attachments without an original path provide only their filename.

Conversation databases automatically upgrade from v3 to v4 at startup or when restoring a backup. Original paths for existing attachments remain empty. Startup preserves the original databases and recovery logs under `Anas/backups/before-upgrade/` in your system Documents folder before conversion; failed upgrades can be retried. Backup restoration upgrades only the extracted copy and leaves the original archive intact. It does not validate individual database records or require attachment files to exist or match their saved sizes; availability is checked when attachments are loaded.

Sending an attachment saves a local copy, so moving or deleting the original does not prevent viewing it. Attachments apply to the current turn by default; pin one to keep using it in later turns of the same conversation. Before sending, hover over an attachment to show its remove, keep-in-conversation, and Convert to path buttons. Converting removes the pending attachment and appends its original absolute path when known, without replacing existing text, one path per line. This also applies when editing historical messages. Only temporary attachments without an original path are retained in the conversation directory and converted to that retained copy's path; these retained files are deleted with the conversation.

Plain text, Markdown, HTML and SVG source are sent as text attachments. Images require a model with Vision enabled. Selecting or dropping other files and folders appends their original paths to the input, one per line.

The built-in file tool `document_to_markdown` converts PDF, DOCX and PPTX files to UTF-8 Markdown offline. Projects and subagents can select it under File write.

- `input_path` is required. Supply the absolute path to the source document.
- `output_path` is required. Supply an absolute path for a new Markdown file. The tool creates missing parent directories and reports an error if the file already exists.
- `summary` is optional. Chat shows the model’s summary beside the tool name, or the source path when omitted.

On success, the result contains the `[Converted document · Markdown]` marker, the source and saved file paths, and the Markdown line and byte counts. With File Read enabled, the model can use `read_file` to read line ranges. A script can read exceptionally long lines in smaller chunks when Command Execution is enabled.

When the document contains embedded pictures, the tool creates a sibling folder named after the output file. For example, `report.md` links to images in `report_images/`. Word and PowerPoint pictures appear in place. PDF images follow the text of their respective pages and carry the page number. Keep the folder beside the Markdown file when moving or sharing it. If the image folder already exists, choose a new output path.

PowerPoint conversion skips ink strokes and their preview images. Text, tables, and regular pictures in the same group are preserved. Office equations in text boxes, tables, and speaker notes are written as LaTeX when supported. An equation with an unsupported structure or mathematical alphabet (such as the double-struck ℝ) is preserved in full as Office Math XML. Embedded MathML appears in XML code blocks. If the MathML cannot be parsed, the tool keeps an available alternative, such as a preview image. A preview of an entire group is accompanied by the group's readable text and tables. If no alternative is available, a message appears in place of the formula.

Embedded SVG images can be opened in a browser. On Windows, ordinary EMF and WMF pictures appear inline as PNGs when rendering succeeds. Other platforms and pictures that Windows cannot render use links to the original files. TIFF pictures also use file links. For diagrams built from separate shapes, the output contains the shape text. Refer to the slide for spatial relationships.

The source size limit is 64 MiB. Office archives can expand to 256 MiB and contain up to 32,000 entries. Scanned PDFs retain their page images. Extracting searchable text requires a text layer in the original. Save legacy .doc and .ppt files in a newer format first.

The microphone button invokes Windows voice typing or macOS Dictation. The system controls starting, stopping, and recognition language. On macOS, enable Dictation in System Settings > Keyboard > Dictation first. Confirm that system dictation has started, then review the recognized text before sending. Anas does not record or save audio.

Spoken replies connect directly to Microsoft Edge online speech services and require internet access. Text to be read is sent to Microsoft. Choose the voice and speed in settings. Audio is buffered only in memory; stopping playback or switching conversations cancels unfinished synthesis and releases queued audio.

Automatic speech reads the main model's reply in chunks. If a subsequent tool call, approval wait, or subagent task appears before playback begins, pending narration is cancelled. Once playback has begun, the reply continues, including during synthesis gaps between chunks. A new main-model reply's body text stops the old audio and switches to the new reply; reasoning and tool-only calls do not interrupt speech that has already begun. Final messages do not replay text already read or cancelled.

## Conversations And Context

In the chat activity, a tool call with a nonblank `summary` string shows the model’s description beside the tool name. This applies to built-in, shell, custom, plugin and MCP tools. Tools can omit this parameter from their schema. When the call has no summary, the activity shows the first available description, path, URL, query or command. If none is available, it shows the tool name alone.

In **Settings → Conversation → Chat display**, adjust chat content width, running process display, and model round information. Processes can open expanded or collapsed; they collapse when a new reply appears or the run ends, and can be reopened manually. Model round information shows each model call's number and duration.

The Agent page has projects and conversations on the left, chat in the center, and a right workspace for Help, subagents, and File changes. Drag the divider to resize or maximize the right pane; narrow windows use a resizable drawer. Collapsing the pane or switching conversations preserves tabs and view positions. Closing a subagent tab does not stop its task.

Right-click a Help, File changes, subagent, or plugin tab and choose **Move to window** to detach it. Use the window titlebar icon to move it back to the sidebar. Moving preserves page state and connections. File changes uses one panel that follows the current project and conversation, with the project name in its title. Switching projects keeps the sidebar open; reopening a detached panel focuses its existing window. Select the run and file again after switching context. Detached subagent panels stay bound to their original project and conversation; moving back returns to that conversation.

Drag right-side tabs to reorder them; the strip scrolls automatically near its edges. Drag clearly outside the titlebar and release to open a separate window, or press Esc to cancel. Order is retained across conversation changes, collapsing and expanding panels, and moving out and back. Sidebar-only plugins cannot be dragged out.

Fullscreen panels keep their actions in a draggable floating toolbar. Plugins can also provide grouped toolbar menus. Moving between displays and programmatic window fitting are distinguished from user resizing to avoid unintended changes to plugin content dimensions.

In **File changes**, choose a comparison scope and file to view a read-only diff. The top toolbar switches inline/side-by-side views and folds unchanged regions. Git comparisons support the working tree, staging area, branches, tags, and commits. Missing history, binary files, and files over 1 MB show why their diff is unavailable.

**Run changes** shows recorded file edits in the current conversation, including subagent edits, and also works outside Git repositories. By default, each file compares its contents before the turn's first edit with its last recorded result. **Compare with current file** uses current disk content instead, which may include later edits. The message's **Run changes** shortcut opens that turn directly. It is enabled when records exist, disabled while checking or while a run has no records yet, and hidden once the run and its subagents have finished with no records. Edits that were later undone remain available to inspect.

Choose **Review selected scope** to have the Agent review the diff. The submitted message shows the actual review instructions and diff content.

Conversations are saved automatically. The sidebar counts user turns, and earlier messages can be loaded as needed. Task progress shows tool calls, approval requests, failure reasons, and elapsed time. New output scrolls into view automatically. Scroll up or expand details to pause; scroll back down or click Scroll to bottom to resume.

Long conversations are compressed automatically. You can also compress manually using the context indicator beside the input. It shows estimated usage by category; reserved output space is displayed separately and is not counted as used context.

When context exceeds its limit, oversized tool results can be shortened to a preview with a path to the complete result; the original chat history is preserved. Files are stored in `db/projects/<projectId>/conversations/<main-conversation-ID>/tool_results/` under the data directory and included in application backups. They are deleted with the entire conversation; clearing caches does not remove them.

Preview request in the project editor shows the context and tools that would be supplied for the current project.

## Plugins

Install plugin opens `data/examples/plugins/` in the application package by default, offering four independent ZIP examples: Notepad, Backend demo, Text tools, and Writing helper. Select a ZIP directly without extracting it. You can extract it to read or modify the source; installed user copies are stored independently and are not overwritten by application updates.

The overview in **Settings → Plugins** groups instructions, skills, and tools. Hover over a name for its description. Configure skill and tool availability here; preview them through **Settings → Skills** and **Settings → Tools → Plugins**, respectively. Instructions retain their clickable previews, rendered/source views, and copy action. Previews work while a plugin is disabled or stopped and never start its backend.

Settings → Tools → Plugins lists tools grouped by plugin, with names, descriptions, and complete input parameters available to view and copy. Details also show the operation type and timeout. Disabled plugins and tools remain inspectable, with warning-colored names and a tooltip explaining why. Browsing the catalog does not start plugin backends.

Settings → Plugins provides individual and group controls for instructions and tools. Each plugin skill has separate **Shortcut** and **Available to model** options on the same page; clearing both disables the skill. Both uses default to on for new skills. The skill group’s select-all / clear-all icon switches both uses for every skill in that plugin. A partial selection offers select-all. Choices remain editable and are preserved while the plugin or a required tool is disabled, with the reason shown in the name’s tooltip. Projects and subagents select entire plugins. The Skills page provides browsing, read-only usage choices, and a link to the owning plugin’s settings.

Plugin tools selected for a project or subagent run without opening plugin pages, with text, JSON, or image results handled like other tool results. Disabled plugins cannot run tools. After an update, current tool definitions are used without requiring a new conversation solely because the version changed. Cancellation or timeout asks the backend to stop that call without terminating the entire backend. Sending cancellation does not confirm that the operation has stopped; the backend's response determines the outcome.

Anas 3.3.8 requires plugin API 2. Update older plugins before use. RDP plugin 0.1.9 requires Anas 3.3.13 or later: update the host before installing the plugin.

In **Settings > Plugins**, click **Install plugin**. The file picker defaults to ZIP files; switch to the plugin manifest filter to select `PLUGIN.json` in a prebuilt plugin folder. ZIPs are extracted automatically; the manifest must be at the archive root or inside its sole top-level folder. Selecting `PLUGIN.json` installs its entire folder. You can also drop one ZIP, `PLUGIN.json`, or plugin folder onto the plugin page; folders must contain `PLUGIN.json` at their root. Drag installation uses the same validation and replacement confirmation; further drops are blocked while installation or confirmation is pending. The Workspace menu at the top of the conversation groups File changes under the current project and launchable plugins under Plugins. The gear beside the Plugins heading opens plugin settings, even when no plugin has a home page. Each home opens in the right workspace or a separate window according to its configured location. In a UI plugin's overview, enable Show launch icon in the title bar (off by default) to add a shortcut beside the menu. Disabling hides the icon while retaining the choice, and package replacement preserves it. Shortcuts that do not fit remain accessible in the full menu. Manage plugins without a home page in settings; their tools, skills, and instructions follow capability selections and need no manual launch. UI-only plugins create no backend process. An optional backend starts automatically on its first call and can also be started or stopped in settings.

If the same plugin ID is already installed, Anas shows the installed and incoming versions and asks before replacing it. Confirmation closes its pages and backend, preserves its enabled state and titlebar icon setting, and replaces the package. **Delete plugin data** is unchecked by default, retaining configuration, credentials, and other saved data; selecting it clears that plugin's data while preserving these two installation settings. Canceling leaves the current plugin untouched. If installation fails, Anas attempts to restore the old package, installation settings, and data; if restoration fails, it preserves the files and reports their location.

User plugin code is installed directly in `plugins/<id>/`; settings and data share `db/plugins/<id>/`, with installation settings in `anas-installation.json`. The old nested `package/` layout is not migrated automatically. Existing user plugins show a loading error until you reinstall them with replacement confirmed. Leave **Delete plugin data** unchecked to retain home location, configuration, credentials, and other saved data. Built-in plugins are unaffected. The old `plugins/<id>/installation.json` is no longer read; a missing new installation settings file defaults to enabled with the titlebar icon hidden. Restoring backups containing the old paths follows the same rule. Uninstalling removes the installation settings file, so reinstalling resets the enabled state and icon setting even when business data is retained.

Hiding a panel, switching conversations, or opening settings preserves its page state. Closing a tab destroys that page. On Windows/Linux, closing the main window quits the application and closes independent panels and plugin backends. On macOS, closing the main window only hides it; use Quit to exit the application. Use **Move to window** in the tab context menu and **Move to side panel** in the window title bar to change location. The plugin saves its UI state and restores it in the destination page while backend connections continue running. If the handoff fails, the original page remains available. Each plugin has at most one home page. Opening it again shows and focuses its current sidebar or window. Other business pages share saved data and the backend while retaining their own page state. Reloading a window releases its pages; backend resources remain managed by the plugin, which determines what can be restored when reopened. Select a plugin in Settings → Plugins to change its home page location, even while disabled. The choice applies when a new home page is created after the previous one closes; plugins with a fixed location cannot switch. Disabling or uninstalling closes its pages and backend. Uninstalling retains saved data by default for a later installation with the same ID. Select Delete plugin data to also remove its configuration, credentials and other data; existing backups are unaffected.

If Anas exits during plugin replacement or removal, the next startup rolls back unfinished operations and cleans up completed operations. Clearing caches or temporary files does not delete recovery material. If a journal is damaged, paths conflict, or recovery fails, the startup recovery screen reports where the files are preserved so you can resolve the problem and retry.

Application backups include plugins and their data. Backups stop plugin backends first; restoring does not restart them automatically. A plugin backend has your operating system user's permissions, so install plugins you choose to trust. Plugin errors appear individually in settings and do not require resetting application configuration.

## Local Data And Backups

**When upgrading from a pre-4.0 version to 4.x, previous conversations and all long-term memory, including project memory, become unavailable. Projects, input history, plugin data, and avatars can be recovered manually.** Back up the entire data directory first. See the [4.x upgrade data guide](UPGRADE_TO_4.en.md) for affected data, old and new paths, manual recovery, and cleanup.

Anas 5.0 uses `~/.anas/` in both development and packaged builds; renaming the application does not change it. Data in the previous `~/.anas-next/` directory or older Anas directories is not automatically read or migrated. To use a different isolated directory, specify `--data-dir <path>` explicitly.

**Upgrading from the old framework to 5.x requires fresh native databases.** Do not copy the old framework's `db/` or restore its full backups; its conversations, memory, and execution records are not migrated. After quitting and backing up, you may copy supported settings, `.env`, user skills, tools, subagents, and plugin code. External references must remain accessible; recreate projects and database contents. The current formats are catalog v2, conversations v3, and separate memory v1, with backup and repair supported. Data already using the current formats does not need another reset. See the [5.x upgrade data guide](UPGRADE_TO_5.en.md) for earlier 5.x layout and conversation-version changes and the steps for copying settings.

You can also specify a directory at launch, for example `Anas.exe "D:\Anas Data\Research"` or `--data-dir <path>`. Relative paths use the launch directory; filesystem roots are not allowed.

ZIP backups default to `Anas/backups/` under the current system user's Documents folder; a previously selected backup folder is preserved. Backups include user tools and skills. Back up project source folders and externally referenced skill and tool files separately. Backups exclude runtime logs, temporary files, developer request traces, application caches, interface caches and sign-in state, and obsolete layout residues.

Before importing a backup, current data is automatically backed up under `Anas/backups/before-restore/UTC-timestampZ-random-suffix/` in the system Documents folder. Automatic preservation directories must be outside the active data directory. If saving fails, the operation stops without falling back to a temporary directory. Existing backups stay in their original locations.

Data cleanup in Settings > General hides categories confirmed to have no removable data. Conversation cleanup keeps pinned, running, and approval-pending conversations. Unknown files is unchecked by default and shows a preview of paths outside the allowlist; directory paths end in `/`. This includes obsolete layout residues and backup files inside the data root. Before cleaning up old projects, input history, plugin data or avatars that you want to restore manually, move them to their new locations or back them up separately. Cache cleanup owns `cache/`; conversation deletion owns `db/projects/<projectId>/conversations/`.

Deleting an entire conversation from its menu does not require repairing a missing, damaged or unsupported-version conversation database first. Deletion also removes its attachments, file-edit recovery material, long tool results and temporary drafts. If the operating system refuses to delete files, deletion progress is retained so you can retry after resolving file locks or permissions.

| Path under the data directory | Contents |
| --- | --- |
| `config/` | Settings, providers/models, subagent order and switches, MCP, Skill sources/availability, and custom-tool sources/ordering |
| `db/catalog.sqlite` | Main conversation directory and shared memory |
| `db/projects/<projectId>/conversations/<threadId>/conversation.sqlite` | One main conversation and its subagents |
| `db/projects/<projectId>/project.json` | Project definitions and source folders |
| `db/input_history.json` | Global input history and pinned inputs |
| `.env` | Application environment variables |
| `attachments/`, `file_edits/`, `tool_results/` under `db/projects/<projectId>/conversations/<threadId>/` | Attachments, file-edit recovery material and long tool results inside the main conversation directory; removed with that conversation |
| `skills/`, `tools/` | User-managed packages |
| `subagents/` | Subagent definitions, prompts, and private Skills and tools |
| `plugins/`, `db/plugins/` | Installed plugins and independent data; uninstalling retains data unless deletion is selected |
| `lang/` | User language packs; built-in English and Chinese are read from the application package |
| `config/assets/` | Avatar source, crop settings, and generated icons |
| `log/`, `cache/`, `tmp/`, `electron/` | Logs, cache, temporary files, and Electron profile |

Built-in skills, subagents, examples, help and languages are read directly from `data/` in the application package, without copying them into user data. Old `_system`, example, help and built-in language copies are preserved but no longer used as built-in sources. Settings, resource selections and imported packages remain independently stored; backups need not include built-in copies.

The package's `data/` is located at `<application directory>/resources/data/` on Windows and `<Anas.app>/Contents/Resources/data/` on macOS. Development reads the repository's `data/` directly, with generated examples in `out/examples/`. The user's `lang/` may be empty and is reserved for custom languages; old `en.json` and `zh-CN.json` copies do not override current built-in translations.

## Troubleshooting

Settings > Dev provides developer tools, logs, and Start in console. Console startup preserves the data directory and restarts the app in a system terminal to show startup and runtime output.

- **Automatic recovery**: malformed tool calls, interrupted responses, and output-length limits can trigger recovery. Recovery and network retries share at most two automatic retries per failure point, normally waiting 0.5 and 1 second, or longer when requested by the service. You can stop while waiting. Completed tools are not repeated; truncated tool calls are regenerated, while generated answer text is retained and continued. The interface shows the recovery reason and attempt count; exhausted recovery leaves the error and manual retry available. Unreadable attachments or extraction failures are reported to the model as missing content. Images are not blocked or converted based on local decoder compatibility.
- **Model request fails**: check the service address, model name, key, and network connection. Use **Retry** below the error to resume the failed model request without repeating completed tools. **Retry (without tool results)** appears only when the error directly follows tool results with no later user input. Those tool return values are replaced in the database with an explicit notice that you chose to withhold them. The conversation record and future model requests use the same updated content. Executed actions are not undone, and the replacement persists in backups, across restarts and later turns. Earlier errors can also be retried: after confirmation, later conversation content is removed and execution continues from that error. Actions already performed by tools are not undone.
- **Skill fails**: check its instructions, environment variables, and required programs.
- **MCP tools are missing**: confirm that the server is enabled and has a saved tool catalog, the tools are selected, the model has Tool use enabled, and the project allows the server.
- **Operation awaits confirmation**: allow or reject it as prompted. If the outcome is uncertain, retry only when repeating the operation is acceptable.

### Startup Recovery

If startup data cannot load, the recovery page lists affected files. View error details, open logs, and choose:

- **Repair**: restores invalid settings to their defaults while keeping valid settings. Capability selections are checked field by field against the current configuration format. Unrecognized values use the corresponding defaults without translating old formats or resetting the whole file, projects, or conversations. Invalid selection lists without item defaults use the list default. Unparseable configuration files can still be reset individually. Damaged project definitions are salvaged using their directory identity, with defaults for missing fields. Changes are listed in the error details.
- **Reset**: configuration reset affects only the selected configuration. **Reset conversation database** clears conversations, runs, shared memory, attachments, tool results and file-edit recovery material while retaining project definitions and settings. **Reset all projects and conversations** also removes all project definitions. Both preserve originals first and retain project source files, other configuration, skills and input history. The confirmation lists the actual files and directories; directories explicitly include all contents. If the execution list changes, refresh and confirm it again.

Before changes, original data is saved under `Anas/recovery/UTC-timestampZ-random-suffix/` in the system Documents folder. If that fails, no changes are made. Restart after recovery.

Application-owned persisted data uses explicit format version `0` as its current baseline. Automatic upgrades and manual recovery are separate: missing or mismatched versions and failed upgrades do not prevent trying **Repair**. Input history and avatar asset errors also open recovery before the main interface loads. Originals are preserved before configuration, input history, avatars, project metadata, and associated databases are salvaged, retaining valid settings, project identities, conversations, and memories where possible. Project repair rebuilds the catalog from valid conversations and isolates unrecoverable content from active data while retaining its original bytes in the preservation copy. Required structures are rebuilt and validated for startup before publication. Reports distinguish recovered data from remaining issues so damaged content does not keep blocking access to the application.

Input history can recover readable entries individually while retaining their order and pinned state. Invalid entries remain in the preserved original, and the result reports partial recovery. A nonempty history with no readable entries is not replaced with an empty list. Project repair preserves and isolates unfinished deletion journals and staging files without replaying deletions. Valid pending project writes are used to recover the latest settings.

Avatar repair rebuilds required assets from a readable source, crop, or display image after preserving the originals. If no image can be recovered, it reports the problem without automatically replacing the avatar with the default. Backup imports also validate avatar parameters before replacing data, rejecting unsupported versions or invalid parameters. Missing optional avatar parameters can still be initialized normally.

### Opening the macOS download

Download the DMG matching your Mac from [GitHub Releases](https://github.com/higale/anas-agent/releases), open it, and drag Anas into Applications. Launch the installed copy. If macOS blocks it because the developer cannot be verified, use **System Settings > Privacy & Security > Open Anyway**, then confirm **Open**, as described by [Apple](https://support.apple.com/102445).

If that route does not resolve a download-quarantine block, and you trust this release, compare the DMG's `shasum -a 256` output with its entry in the release's `SHA256SUMS.txt`. Then remove only the installed Anas app's quarantine attribute:

```bash
xattr -r -d com.apple.quarantine "/Applications/Anas.app"
```

Adjust the path if installed elsewhere. Use `sudo` before this command only if it fails with a permissions error and the path is correct. This removes download quarantine; it does not repair a damaged app or provide Apple notarization. For a signature verification failure, download a fresh copy; do not bypass a malware warning.

The release build already applies and verifies an ad-hoc signature. Users should not normally run `codesign --force --deep --sign -`: it replaces nested signatures, and [Apple reserves deep signing for emergency repairs](https://developer.apple.com/library/archive/technotes/tn2206/). Developers can rebuild with `npm run pack:mac:release` instead. A future release using [Developer ID signing and Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) would avoid the unidentified-developer/notarization block; current releases use ad-hoc signing.
