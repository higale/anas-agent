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

## Projects And Capabilities

The sidebar shows Projects, Simple chats, then the separate default project. Drag a project name to reorder it within its category, or a conversation name to reorder it within its project. Pinned and unpinned items sort separately; dragging cannot move items between groups. Release to save or press Esc to cancel. After manual sorting, new items appear before unpinned items, and message updates preserve the saved order. The default project stays last.

Enable **Customize capabilities** in the project editor to choose prompts, context, tools, skills, and subagents. Turning it off uses all enabled capabilities and retains custom choices. Settings manages source availability; there is no global default-capability page. Coding mode controls the development workflow without increasing access permissions.

The default project name cannot be changed. All other settings work the same as for regular projects, including its icon, color, working folders, tool access mode, model and reasoning option, coding mode, and customized capabilities. Its initial working folder is the current system user's Documents folder, with no extra subfolder created; saved folder selections are preserved. Enable “Customize capabilities” to edit project and compression prompts and capability selections. Turning it off preserves those custom settings while using the default prompt behavior and all enabled capabilities.

- File read, File write, and Memory expand into individual choices. Use each group switch to select or clear all items. Saved selections that are deleted or unavailable can still be deselected.
- Every tool listed below requires a model that supports tool use with **Tool use** enabled. Context-only capabilities do not require tool use. Using a skill also requires tools for reading its instructions and performing its task.
- Capabilities select available tools; the conversation's access mode determines when an operation needs approval. Disabling File read, File write, or Network access removes those specific tools. Commands and MCP tools may still provide similar operations.
- Changes apply to tasks started afterward. Running tasks and tasks awaiting recovery retain their original selection.

Each MCP server and plugin, plus Subagents, Skills, and Custom tools, uses **All / Custom / Off**. All includes current and future available entries. Custom includes only explicit choices and starts collapsed. Off hides the list and retains those choices. Newly added MCP servers and plugins start off in customized projects. Disabling a whole source does not lock customization: known entries remain editable but inactive. If the complete MCP catalog is unavailable, saved tools can still be deselected.

Skills follow global shortcut/model availability: a globally disabled use cannot be newly selected and shows no notice while unselected. Saved selections remain checked with a warning about the conflict and can be cleared. Selecting that use again requires enabling it globally. Project-local skills are independent of these global restrictions.

- **Enable all** enables built-in capabilities, sets current MCP servers, plugins and the other groups to All, and clears the project capability limit. Global availability still applies.
- **Disable all** turns capabilities off while retaining custom MCP, plugin, tool, skill and subagent selections.

In **Settings > Tools**, select Built-in tools or MCP to view tools grouped by capability or server. Below the divider, browse custom tool sources and package files. Select a built-in or MCP tool name to inspect its parameters and full description.

### Coding mode

**Coding mode** is independent of **Customize capabilities**. It adds development guidance such as inspecting code before editing, preserving existing changes, and verifying results. Its compression summary preserves file changes, test evidence, and unfinished work. Models, tools, and access permissions continue to follow their separate settings.

The application automatically reads applicable AGENTS rules in full and adds them directly to the system context; the model does not need to call a read tool first. Within a directory, `AGENTS.override.md` takes precedence; `AGENTS.md` is used only when the override is absent. Deeper rules apply only to their directory trees. Rules consume input tokens, and each run retains snapshots of directories already checked.

The initial context includes rules applicable to the primary working directory. Other directories are discovered from structured file operation targets. A write requiring rules the model has not yet seen first returns “NOT EXECUTED”, allowing the model to reconsider with the new rules. Arbitrary shell commands, MCP tools, and custom tools without declared file targets do not automatically check every affected path.

Regular workspace projects provide **Project prompt** and **Compression prompt** tabs. Leave the compression prompt empty to use the current mode's built-in default, or choose **Load default** to start editing its full text. Nonempty text replaces the default entirely; clearing it restores the default. Changes are saved or canceled with the project. Both prompts can be edited and take effect only when **Customize capabilities** is enabled. Turning it off uses defaults and retains custom text for later use. Custom compression applies only to the main conversation; subagents use built-in templates. Changing coding mode does not overwrite custom text.

Custom compression prompts allow up to 50,000 characters and must contain exactly one `{conversation}` placeholder; `{output_language}` is optional. Automatic and manual compression use the same template. Existing tasks and their resumptions retain the custom content selected at launch.

The menu beside the left-hand title area opens full prompt, compression prompt, and request previews. The read-only compression preview shows the effective template for the current draft: the built-in default when customization is disabled or the custom text is empty, otherwise the full custom template. Previews do not include subdirectory rules that would only be discovered by future operations.

### Profile

Supplies the assistant's name, role, instructions, and user information from **Settings > General**, so the Agent can follow your preferences. It has no separate tool and does not allow profile edits; tool-based edits require **Update configuration**. A subagent receives profile information according to its own capabilities and any project limits.

### Runtime Environment Information

Supplies the system, date, directory, command environment, and custom information selected in **Settings > Environment**. It provides context without installing programs or enabling command execution.

Bundled rg instructions require both **Command execution** and **Bundled commands** in environment settings. Turning runtime information off does not remove available programs. See [Runtime Environment And Variables](#runtime-environment-and-variables) for automatic detection of empty custom information.

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

Bundled rg supports file and text searches without a separate installation. Script runtimes such as Python or Node.js must still be installed as needed. Follow-up terminal input requires **Background tools**; application `.env` variables are controlled separately by **.env**. Commands follow the conversation's access mode.

### Network Access

Provides `http_request` for HTTP/HTTPS requests, API calls, uploads, and downloads. The destination must be reachable and any required authentication must be supplied. This is not browser automation.

The tool can upload or download files independently of **File read** and **File write**, while still following file access approval rules. This switch does not control MCP connections or network access through commands.

### Update Configuration

Provides `update_config` to change supported application settings at your request, such as the theme, font size, and profile. It currently supports application settings fields, not arbitrary changes to project, model, or MCP configuration files.

It does not require **File write**. Each call requires approval in **Allow read-only** and **Strict approval** modes; **Full access** permits execution without that prompt.

### User Interaction

Provides `request_user_input` so the Agent can present questions with choices or a text answer. Useful for missing information, clarification, and decisions. You can cancel; ordinary questions may also time out.

It does not require **Background tools**. When disabled, the Agent can still ask in chat but cannot open this question dialog. Execution approval dialogs are controlled separately.

### Wait

Provides `sleep` so the Agent can pause before continuing, for example before checking a webpage or chat reply again. The required `seconds` parameter accepts integers from 1 through 300; the optional `summary` describes the reason. Completion returns the actual elapsed seconds; observing changes still requires the appropriate tool afterward.

This capability has its own switch in project and subagent settings, independent of **Command execution** and **Background tools**. It waits inline without switching to a background call after 10 seconds. Stopping the run cancels the wait.

The chat entry shows a clock icon and remaining seconds. When the countdown reaches zero it waits for the actual result, then shows the elapsed time.

### File Read

Reads and inspects local files without requiring **Command execution**. The conversation's access mode determines whether reading outside project folders needs approval.

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

Creates, changes, moves, or deletes local files without requiring **Command execution**. Select only the tools needed. Enable a suitable reading tool when the Agent should inspect existing content first. Writes outside project folders usually need approval; see [Tools And Approval](#tools-and-approval).

| Tool | Function |
| --- | --- |
| `apply_patch` | Locate and edit content using surrounding text; supports a preview without writing. |
| `write_file` | Create a text file or explicitly replace the entire contents of an existing file. |
| `restore_file_edit` | Undo a complete recorded `apply_patch` or `write_file` operation. Recovery data must still be available; conflicting edits are not overwritten. |
| `get_file_edit_diff` | Inspect recorded Agent file changes, rather than Git working-tree changes. This tool itself is read-only. |
| `create_directory` | Create a directory and missing parents. |
| `move_file` | Move or rename files and directories. |
| `delete_file` | Delete files or directories. |

### Memory

Stores preferences, facts, and experience globally or for the current project. The following four items are independent choices.

| Item | Function and dependencies |
| --- | --- |
| Automatic recall | Finds records relevant to the current user message and supplies them to the model. It calls no tool and does not automatically save memories. |
| `read_memory` | Search or list global and current-project records. |
| `save_to_memory` | Create or update a record with global or current-project scope. |
| `forget_memory` | Delete a record by ID; search first if the ID is unknown. |

Select only **Automatic recall** to use relevant existing memories, or leave it off and enable search or save tools. Clearing selections does not delete records. Search, edit, or delete them in **Settings > Memory**.

### Custom Tools

Provides your configured programs or scripts as tools for the model. Prepare their programs, dependencies, and accounts. **Command execution** is not required; interactive tools also need **Background tools**. See [Manage Custom Tools](#manage-custom-tools) for setup and selection.

### MCP

Each MCP server uses **All / Custom / Off**. All includes newly added tools; Custom only includes checked tools. Switching modes retains custom choices.

The server must be enabled in **Settings > MCP** and connected successfully. Selecting it in a project does not start a globally disabled server. Tool functions, parameters, required software, and accounts depend on the server. They do not require similarly named built-in file or network capabilities. Saved selections remain removable when unavailable.

### Subagents

Delegates independent tasks to other Agents for parallel investigation and division of work. The following tools depend on one another and are enabled or disabled as a group, not selected individually.

| Tool | Function |
| --- | --- |
| `start_subagent` | Start an allowed subagent. |
| `read_subagent` | Inspect a subtask's status and progress. |
| `wait_subagent` | Wait for progress, completion, or a request for approval. |
| `cancel_subagent` | Cancel a specified subtask. |

Configure and enable subagents in **Settings > Subagents**. Projects and subagents use **All / Custom / Off**: All includes enabled, complete definitions; Custom includes only checked available definitions. An empty list prevents launches. Custom starts collapsed and shows entries directly when expanded, without a search field. Globally disabled definitions cannot be enabled locally. This capability does not require Background tools.

Subagents use their own capability settings. Further delegation cannot exceed the original project’s allowed set. **Limit subagent capabilities** separately constrains context, tools, and skills at every level to the intersection of project and subagent choices. Otherwise each subagent uses its own configuration. It receives the delegated task, not the complete parent conversation automatically.

Choose a model and parameter preset beside **Identifier**. **Follow parent Agent** uses the nearest ancestor's selected model and preset. An explicit selection applies to newly created subtasks; clear it to restore inheritance. Editing a subagent definition does not change existing subtasks' model bindings. Missing models or presets produce an error rather than switching to another model.

### Skills

Supplies the names, purposes, and instruction paths of available skills, or lets you invoke them with `/name`. Skills are instructions, not separate callable tools, and do not grant file, command, or network capabilities.

Skills use **All / Custom / Off**. Custom starts collapsed and has no search field. All and Off retain custom choices. Plugin skills are selected under their plugin and are independent of the ordinary Skills group.

Settings lists **Shortcut**, **Available to model**, then **Auto-approve scripts**. The first two match the project's **Shortcut** and **Model** options and also apply to plugin skills. Projects and subagents cannot enable a globally disabled use. Subagents configure model availability only. Project skills in `.agents/skills/` are independent of these global switches and are selected within the project.

Explicit invocation sends the unchanged skill file and its source path, keeping the user request separate; expand the skill entry to inspect the submitted text. Autonomous loading and reading supporting files require `read_file`, `read_multiple_files`, or **Command execution** capable of reading files. Scripts also need their command interpreter, runtime, tools, and accounts. Selecting a skill does not satisfy those dependencies automatically. Manage global sources and availability in **Settings > Skills**; put project skills in `.agents/skills/` under source folders. See the [Skills Guide](./AGENT_SKILLS.en.md) for installation, name conflicts, and authoring, and each skill's `SETUP.md`, if supplied, for installation requirements.

## Models

OpenAI-compatible and Anthropic-compatible services are supported. Manage models in Settings > Model and switch between them below the message input.

Click the icon before a provider’s name, or drop an SVG, PNG, JPEG, static WebP, or BMP onto it, to replace it; hover to reset it. SVG files must not exceed 1 MB and retain their original vector data. Raster images are automatically center-cropped to a square, reduced to at most 512 × 512 pixels, and saved as PNG, preserving transparency without enlarging small images. GIF and animated WebP are not supported. Templates include brand icons. Images are stored as Base64 in provider configuration and included in backups. An empty image displays the generic icon directly. Only clicking Reset looks up the current API URL in the templates and saves the matching brand icon, or clears the image if no match is found.

The API key field accepts a literal key or a `${VARIABLE_NAME}` reference. Its dropdown groups suggestions from the application `.env` file and system environment, matching names containing `KEY`, `TOKEN`, or `SECRET` without case sensitivity. It shows names and empty-value status, with no search box. Manually entered references need not match those keywords. Names can contain spaces, Unicode characters, and hyphens, or begin with digits. Names inside references are preserved exactly: `${ TEST_API_KEY}` differs from `${TEST_API_KEY}`. Dropdown names with leading or trailing whitespace are quoted for display only; the quotes are not part of the name. The reference syntax excludes empty names, equals signs, braces, line breaks, and null characters. The `.env` parser continues to trim whitespace around assignment names. Valid references can be saved before the variable is configured. Missing or empty values produce an explicit error when requesting a model, fetching the model list, or querying usage. References remain visible; literal keys are masked when the field loses focus.

A non-empty value in the application data directory's `.env` takes priority over the same system variable. Saving `.env` in Settings reloads it immediately. External edits are not watched; reopening the dropdown or restarting the app rereads the file. System variables come from the current Anas process environment, so operating-system changes require restarting Anas; in development mode, also reopen the terminal used to launch it. Changes do not affect requests already sent. Configuration stores the reference, and an empty field never selects a variable automatically. The project's `.env` capability switch does not affect model connections.

The settings list and model picker use the same two-line layout: the model name above, followed by the context limit, maximum output, compression threshold, and capability and reasoning icons below. An unset maximum output or disabled compression is shown as “—”.

Changes to the model name, capabilities, context limits, extra parameters, and reasoning options remain drafts until you choose **Save**. Choosing **Cancel** or closing the editor discards those changes.

Set Vision and Tool use to match the model's actual capabilities. Turning Tool use off prevents calls to built-in tools, MCP tools, and subagents. Profile, runtime information, project information, skill listings, and automatic memory recall still follow capability settings; saved choices are unchanged.

## Tools And Approval

Project Customize capabilities selects available tools; the model's Tool use setting determines whether it can call them. See [Projects And Capabilities](#projects-and-capabilities) for functions and dependencies.

Below the folders in project settings, choose the default tool access mode on the left and the model and reasoning option on the right. New conversations inherit this mode and can override it beside the input. Changing the project default does not affect existing conversations. An omitted setting defaults to Allow read-only; Customize capabilities does not need to be enabled.

Conversations offer three access modes:

- **Allow read-only**: the default. Files outside projects can be read directly; external writes and commands that cannot be verified as supported read-only operations require confirmation.
- **Strict approval**: external reads also require confirmation. Only supported read-only commands targeting project files run without a prompt.
- **Full access**: skips pre-execution approval. Switch to Allow read-only or Strict approval from the tool access menu beside the input; operations already started are not interrupted.

An external operation with an uncertain outcome still requires confirmation before retrying. A conversation awaiting confirmation cannot accept messages, history edits, regeneration, or compression. Other conversations remain available.

Subagents can work in the background. Select a subagent status entry to view its task, tool calls, and result. Unfinished subagents, including those awaiting approval, are cancelled when the main task ends.

## Runtime Environment And Variables

Bundled commands in Runtime Environment is enabled by default and gives the Agent instructions for bundled rg. Detect System Environment updates information about system commands; bundled rg needs no detection. The result is inserted at the last cursor position in Custom Environment Information, replacing any selected text.

Custom Environment Information is enabled by default. If selected and empty at startup, it is filled by background detection without blocking startup. Existing content is preserved; deselecting it during detection discards the result.

Edit the application `.env` in Settings > Environment to prepare variables for commands, custom tools, and skill scripts. The relevant Agent's .env capability determines whether they receive these variables.

## Manage Custom Tools

The bundled `tool-manager` Skill guides the model through creating, modifying, and troubleshooting custom tools, with a format reference and a Python example template. Enable the Skill and the required file capabilities, then ask the model to create a custom tool for the current project. Script testing also requires command execution and the appropriate runtime. All mode loads the generated tool on subsequent runs; Custom mode requires selecting it first.

In **Settings > Tools**, Built-in tools and MCP appear above a divider. Below it, the custom-tool tree lists all packages, user tools, and added directories. Select a group name to list its tools on the right; use the boxed arrow to expand or collapse it. Select a tool from the list to view its details. Click a detail title to locate its directory, or expand packages to browse and preview files. User and added-directory tools support creation, editing by double-click, deletion, and ordering; deletion moves the entire tool package to the trash.

**Add directory** references an external source in place. Rename its display label, reorder it, or remove the reference without deleting files. Name changes save on Enter or focus loss. **Create** and **Import** appear in the selected user or added-directory group header and write packages into that source.

Each directory contains a `TOOL.json` manifest with explicit `"version": 0`, plus scripts or resources. User tools live in the application data directory's `tools/`; project tools live in `.agents/tools/` under source folders and are available only to that project. The editor configures names, descriptions, JSON parameter rules, and commands; it does not generate scripts or install dependencies.

The **+** create and **Import tools** buttons appear in the right pane header while the User group or an added directory is selected. Import accepts multiple directories and opens the bundled examples by default. The examples provide text reading, Baidu AI Search, file SHA-256, and JSON formatting, all using the Python 3 standard library. Baidu AI Search also requires internet access and `BAIDU_SEARCH_API_KEY`; see its bundled README for setup. Imports copy into the selected source without overwriting existing tools.

**Edit information** and **Edit parameters** open the same editor on the corresponding section. Switching sections preserves the draft. The parameter section supports **Parameters / Source**, with controls for names, types, required status, descriptions, enums, limits, and nested object or array parameters. Edit each parameter within the same window and apply it to return to the list. Save the tool to apply all changes together; discarding unsaved changes requires confirmation. Update scripts separately. Use Source for advanced references and composed schemas; other untouched attributes are preserved. Defaults are annotations and are not automatically supplied during calls.

Click a package-local script path in the command to locate it in the file list. If missing, confirm to create an empty file and its parent directories. Existing files are never overwritten.

Enable or disable a tool in its details. Under **Custom tools** in project and subagent capabilities, **All** includes new tools automatically, **Custom** requires explicit selection, with entries grouped by source and multiple tools per row when space allows, wrapping to fit the available width. **Off** disables the group while retaining choices. Subagents use independent selections, may enable **Use current project tools**, and follow project limits. For duplicate names, the first valid, enabled entry wins: project source folders in order, then user tools and external directories in order.

Commands run in the tool directory, where relative paths resolve, for example `scripts/run.py {{args}}`. A `.py` entry automatically selects an available Python 3; an explicit interpreter is also supported. A standalone `{{args}}` receives complete JSON; `{{tool_dir}}` supplies the absolute tool directory. A command starts one program with fixed arguments, without pipelines or redirection. Standard output is returned to the model; pass large inputs through files.

**Interactive terminal (PTY)** supports programs needing follow-up input and requires **Background tools**, without requiring **Command execution**. Leave it off for ordinary text results. A blank timeout means no limit; positive seconds set an execution limit, including time spent waiting for input. Cancellation or timeout terminates the process tree but does not undo changes already made.

## MCP Setup

Add and edit servers in Settings > MCP using stdio, HTTP, or SSE. The server must be enabled and connected, the model must have Tool use enabled, and the project must allow the relevant tools.

For stdio servers, leaving Working directory blank uses the current user's home directory. Enter an absolute path to run the server in another directory.

Disabled servers remain editable; editing a running server stops it first. The tool catalog in Settings > Tools groups tools by server. Projects can further select available tools.

## Attachments And Voice Input

Sending an attachment saves a local copy, so moving or deleting the original does not prevent viewing it. Attachments apply to the current turn by default; pin one to keep using it in later turns of the same conversation.

Text extraction supports text files, PDFs, and docx files. Images require a model with Vision enabled; text-only models cannot receive or view image content. Unsupported files are marked as not sent to the model.

The microphone button invokes Windows voice typing or macOS Dictation. The system controls starting, stopping, and recognition language. On macOS, enable Dictation in System Settings > Keyboard > Dictation first. Confirm that system dictation has started, then review the recognized text before sending. Anas does not record or save audio.

Spoken replies connect directly to Microsoft Edge online speech services and require internet access. Text to be read is sent to Microsoft. Choose the voice and speed in settings. Audio is buffered only in memory; stopping playback or switching conversations cancels unfinished synthesis and releases queued audio.

Automatic speech reads the main model's reply in chunks. If a subsequent tool call, approval wait, or subagent task appears before playback begins, pending narration is cancelled. Once playback has begun, the reply continues, including during synthesis gaps between chunks. A new main-model reply's body text stops the old audio and switches to the new reply; reasoning and tool-only calls do not interrupt speech that has already begun. Final messages do not replay text already read or cancelled.

## Conversations And Context

The Agent page has projects and conversations on the left, chat in the center, and a right workspace for Help, subagents, and File changes. Drag the divider to resize or maximize the right pane; narrow windows use a resizable drawer. Collapsing the pane or switching conversations preserves tabs and view positions. Closing a subagent tab does not stop its task.

Right-click a Help, File changes, subagent, or plugin tab and choose **Move to window** to detach it. Use the window titlebar icon to move it back to the sidebar. Moving preserves page state and connections. File changes uses one panel that follows the current project and conversation, with the project name in its title. Switching projects keeps the sidebar open; reopening a detached panel focuses its existing window. Select the run and file again after switching context. Detached subagent panels stay bound to their original project and conversation; moving back returns to that conversation.

Drag right-side tabs to reorder them; the strip scrolls automatically near its edges. Drag clearly outside the titlebar and release to open a separate window, or press Esc to cancel. Order is retained across conversation changes, collapsing and expanding panels, and moving out and back. Sidebar-only plugins cannot be dragged out.

Fullscreen panels keep their actions in a draggable floating toolbar. Plugins can also provide grouped toolbar menus. Moving between displays and programmatic window fitting are distinguished from user resizing to avoid unintended changes to plugin content dimensions.

In **File changes**, choose a comparison scope and file to view a read-only diff. The top toolbar switches inline/side-by-side views and folds unchanged regions. Git comparisons support the working tree, staging area, branches, tags, and commits. Missing history, binary files, and files over 1 MB show why their diff is unavailable.

**Run changes** shows recorded file edits in the current conversation, including subagent edits, and also works outside Git repositories. By default, each file compares its contents before the turn's first edit with its last recorded result. **Compare with current file** uses current disk content instead, which may include later edits. The message's **Run changes** shortcut opens that turn directly.

Choose **Review selected scope** to have the Agent review the diff. The submitted message shows the actual review instructions and diff content.

Conversations are saved automatically. The sidebar counts user turns, and earlier messages can be loaded as needed. Task progress shows tool calls, approval requests, failure reasons, and elapsed time. New output scrolls into view automatically. Scroll up or expand details to pause; scroll back down or click Scroll to bottom to resume.

Long conversations are compressed automatically. You can also compress manually using the context indicator beside the input. It shows estimated usage by category; reserved output space is displayed separately and is not counted as used context.

When context exceeds its limit, oversized tool results can be shortened to a preview with a path to the complete result; the original chat history is preserved. Files are stored in `db/conversations/<main-conversation-ID>/tool_results/` under the data directory and included in application backups. They are deleted with the entire conversation; clearing caches does not remove them.

Preview request in the project editor shows the context and tools that would be supplied for the current project.

## Plugins

Install plugin opens `examples/plugins/` by default, offering four independent ZIP examples: Notepad, Backend demo, Text tools, and Writing helper. Select a ZIP directly without extracting it. You can extract it to read or modify the source; refreshing examples does not overwrite installed plugins.

The overview in **Settings → Plugins** groups instructions, skills, and tools. Hover over a name for its description, or click to inspect and copy read-only details. Skills show the name from `SKILL.md`; tools show their actual model-facing names and full parameters. Instructions and skills support rendered and source views. Previews work while a plugin is disabled or stopped and never start its backend.

Settings → Tools → Plugins lists tools grouped by plugin, with model definitions available to view and copy. Disabled plugins remain inspectable; browsing the catalog does not start plugin backends.

Select plugin tools, skills and prompts together under each plugin in project and subagent capabilities with **All / Custom / Off**. All includes new contributions; Custom uses only explicit choices; Off retains those choices. Uncustomized projects use available contributions from enabled plugins, while new plugins start off in customized projects. Skills settings controls the global shortcut/model availability ceiling. The ordinary Skills group does not control plugin skills. Missing tool dependencies are shown without automatically selecting them. Plugin management controls installation, overall availability, plugin preferences, and content previews, without duplicating capability switches.

Plugin tools selected for a project or subagent run without opening plugin pages, with text, JSON, or image results handled like other tool results. Disabled plugins cannot run tools. After an update, current tool definitions are used without requiring a new conversation solely because the version changed. Cancellation or timeout asks the backend to stop that call without terminating the entire backend. Sending cancellation does not confirm that the operation has stopped; the backend's response determines the outcome.

Anas 3.3.8 requires plugin API 2. Update older plugins before use. RDP plugin 0.1.9 requires Anas 3.3.13 or later: update the host before installing the plugin.

In **Settings > Plugins**, click **Install plugin**. The file picker defaults to ZIP files; switch to the plugin manifest filter to select `PLUGIN.json` in a prebuilt plugin folder. ZIPs are extracted automatically; the manifest must be at the archive root or inside its sole top-level folder. Selecting `PLUGIN.json` installs its entire folder. You can also drop one ZIP, `PLUGIN.json`, or plugin folder onto the plugin page; folders must contain `PLUGIN.json` at their root. Drag installation uses the same validation and replacement confirmation; further drops are blocked while installation or confirmation is pending. The Workspace menu at the top of the conversation groups File changes under the current project and launchable plugins under Plugins. The gear beside the Plugins heading opens plugin settings, even when no plugin has a home page. Each home opens in the right workspace or a separate window according to its configured location. In a UI plugin's overview, enable Show launch icon in the title bar (off by default) to add a shortcut beside the menu. Disabling hides the icon while retaining the choice, and package replacement preserves it. Shortcuts that do not fit remain accessible in the full menu. Manage plugins without a home page in settings; their tools, skills, and instructions follow capability selections and need no manual launch. UI-only plugins create no backend process. An optional backend starts automatically on its first call and can also be started or stopped in settings.

If the same plugin ID is already installed, Anas shows the installed and incoming versions and asks before replacing it. Confirmation closes its pages and backend, preserves its enabled state and titlebar icon setting, and replaces the package. **Delete plugin data** is unchecked by default, retaining configuration, credentials, and other saved data; selecting it clears that plugin's data while preserving these two installation settings. Canceling leaves the current plugin untouched. If installation fails, Anas attempts to restore the old package, installation settings, and data; if restoration fails, it preserves the files and reports their location.

User plugin code is installed directly in `plugins/<id>/`; settings and data share `db/plugins/<id>/`, with installation settings in `anas-installation.json`. The old nested `package/` layout is not migrated automatically. Existing user plugins show a loading error until you reinstall them with replacement confirmed. Leave **Delete plugin data** unchecked to retain home location, configuration, credentials, and other saved data. Built-in plugins are unaffected. The old `plugins/<id>/installation.json` is no longer read; a missing new installation settings file defaults to enabled with the titlebar icon hidden. Restoring backups containing the old paths follows the same rule. Uninstalling removes the installation settings file, so reinstalling resets the enabled state and icon setting even when business data is retained.

Hiding a panel, switching conversations, or opening settings preserves its page state. Closing a tab destroys that page. On Windows/Linux, closing the main window quits the application and closes independent panels and plugin backends. On macOS, closing the main window only hides it; use Quit to exit the application. Use **Move to window** in the tab context menu and **Move to side panel** in the window title bar to change location. The plugin saves its UI state and restores it in the destination page while backend connections continue running. If the handoff fails, the original page remains available. Each plugin has at most one home page. Opening it again shows and focuses its current sidebar or window. Other business pages share saved data and the backend while retaining their own page state. Reloading a window releases its pages; backend resources remain managed by the plugin, which determines what can be restored when reopened. Select a plugin in Settings → Plugins to change its home page location, even while disabled. The choice applies when a new home page is created after the previous one closes; plugins with a fixed location cannot switch. Disabling or uninstalling closes its pages and backend. Uninstalling retains saved data by default for a later installation with the same ID. Select Delete plugin data to also remove its configuration, credentials and other data; existing backups are unaffected.

The built-in Usage Meter is enabled by default. Above Settings, it shows account quota, balance, or key spend for the provider selected in the composer, with a Refresh now button. Compact mode is the default: one line shows remaining quota or balances with currency, with grouped details and the last update on hover. When space is tight, quota period labels hide to keep percentages visible and return when space allows. Supported providers are MiniMax Token Plan (5h limit and Weekly limit with separate reset times), GLM / Z.ai (Coding Plan five-hour, weekly, and separate monthly MCP quotas when returned; the China ordinary API shows CNY available balance, with total top-ups, all-time spend, and frozen balance in details, omitting missing fields), DeepSeek (available/granted/topped-up balances), Moonshot/Kimi (available/voucher/cash balances, CNY in China and USD globally), and OpenRouter (current key credits and all-time/daily/weekly/monthly spend). OpenRouter “No cap” means no key spending cap, not a funded account; account-wide balance requires a management key and is not queried. The plugin overview in Settings lists providers and descriptions in the interface language. Click the arrow on the meter to expand progress bars and timing information, or click again to collapse. The choice is saved automatically across restarts; no settings page is needed. The current MiniMax endpoint does not provide the plan expiration date; quota resets do not indicate subscription expiry. The provider is recognized by its API URL. GLM / Z.ai paths /api/coding/paas/v4 and /api/anthropic query plan availability; the China ordinary /api/paas/v4 path queries account balance. The global ordinary API and other paths are hidden. Balance and plan queries use separate caches and the configured key, without a console login; plan type is not inferred from key format. GLM account balance excludes resource packages and Coding Plan quotas, so zero balance does not establish that model calls are unavailable. Balance queries use a console endpoint with no public API documentation. A matching widget immediately shows a loading state while the query runs. Changing models or credentials clears previous readings; refreshing the same context retains them. MiniMax’s “5h limit” and “Weekly limit” are independent. Both modes show remaining quota, including weekly plan boosts, for example “5h 90% · 1w 148.5%”. Progress bars represent remaining quota divided by the actual total. Total quota, used quota and boost explanations appear in details, while reset countdowns stay visible. Percentage precision in the public API may cause small differences from the website. It reuses your configured provider key and caches automatic queries for five minutes. Failed queries retain the last reading with an error and update time. These are provider account or key figures, not conversation token usage. The plugin defines its display in HTML, while Anas provides shared styles, theme colors, and font sizing. The plugin updates with Anas and can be disabled in Settings → Plugins, but cannot be uninstalled. After manually stopping it or creating a backup, restart its backend in plugin settings.

Bailian / Qwen China supports `dashscope.aliyuncs.com` and `token-plan.cn-beijing.maas.aliyuncs.com`. Install `bl` first (`npm install -g bailian-cli`); the plugin uses its active profile. Use **Sign in to Bailian** for a missing/expired session or **Switch account** for a key mismatch, select the correct account in your browser, then refresh. Login updates bl configuration and may create an ordinary API key through the CLI; it does not change Anas model configuration. Pending login can be cancelled. Personal Token Plan keys are checked against the visible first and last 15 characters of the console’s masked key. Actual 5-hour, weekly or monthly remaining quotas, reset times, plan, status, expiry and auto-renew are displayed when provided. If no quota windows are returned, the meter states that quota data is unavailable and keeps the subscription details; it does not infer unlimited quota. Ordinary keys are matched exactly; the meter shows current-model free quota (not account balance) and the key’s online calls and usage over 7 days in its workspace. Statistics may be delayed. Missing CLI, access denial, query failures and key mismatches show errors; failed Bailian reads clear previous figures to avoid displaying another account’s cached data. International and dedicated team-plan endpoints are not yet supported.

The expanded view keeps primary quotas, balances and reset timing visible. A details icon to the right of the update time contains account and subscription information, balance breakdowns and spending details. Bailian's ordinary API keeps current-model free quota and 7-day call counts visible, with workspace, quota expiry and usage breakdowns in details. GLM Coding Plan keeps reset countdowns visible and places exact dates in details. MiniMax keeps remaining quota and reset countdowns visible, with exact reset times on hover; total quota, usage and boost explanations appear in details. Hover over the icon to preview, or click to keep the popover open and select text for copying; click again, click outside or press Esc to close it. Viewing details does not query the service again, and the icon is omitted when no extra information is available. Query failures, confirmed insufficient balances and expired or inactive plans remain visible. The compact view's tooltip retains full information.

If Anas exits during plugin replacement or removal, the next startup rolls back unfinished operations and cleans up completed operations. Clearing caches or temporary files does not delete recovery material. If a journal is damaged, paths conflict, or recovery fails, the startup recovery screen reports where the files are preserved so you can resolve the problem and retry.

Application backups include plugins and their data. Backups stop plugin backends first; restoring does not restart them automatically. A plugin backend has your operating system user's permissions, so install plugins you choose to trust. Plugin errors appear individually in settings and do not require resetting application configuration.

## Local Data And Backups

**When upgrading from a pre-4.0 version to 4.x, previous conversations and all long-term memory, including project memory, become unavailable. Projects, input history, plugin data, and avatars can be recovered manually.** Back up the entire data directory first. See the [4.x upgrade data guide](UPGRADE_TO_4.en.md) for affected data, old and new paths, manual recovery, and cleanup.

The default data directory is `~/.gale<program-name>/`; standard Anas uses `~/.galeAnas/`. Copying and renaming the application gives it a separate data directory.

You can also specify a directory at launch, for example `Anas.exe "D:\Anas Data\Research"` or `--data-dir <path>`. Relative paths use the launch directory; filesystem roots are not allowed.

ZIP backups default to the current system user's Documents folder; a previously selected backup folder is preserved. Backups include user tools and skills. Back up project source folders and externally referenced skills separately. Backups exclude runtime logs, temporary files, developer request traces, application caches, interface caches and sign-in state, and obsolete layout residues.

Data cleanup in Settings > General hides categories confirmed to have no removable data. Conversation cleanup keeps pinned, running, and approval-pending conversations. Unknown files is unchecked by default and shows a preview of paths outside the allowlist; directory paths end in `/`. This includes obsolete layout residues and backup files inside the data root. Before cleaning up old projects, input history, plugin data or avatars that you want to restore manually, move them to their new locations or back them up separately. Cache cleanup owns `cache/`; conversation deletion owns `db/conversations/`.

Deleting an entire conversation from its menu does not require repairing a missing, damaged or unsupported-version conversation database first. Deletion also removes its attachments, file-edit recovery material, long tool results and temporary drafts. If the operating system refuses to delete files, deletion progress is retained so you can retry after resolving file locks or permissions.

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
| `skills/_system/`, `plugins/_system/` | Built-in packages refreshed by the app |
| `examples/skills/`, `examples/tools/`, `examples/plugins/` | Examples refreshed by the app, with plugins supplied as individual ZIPs; import or install before use |
| `help/`, `lang/` | Help and language packs |
| `config/assets/` | Avatar source, crop settings, and generated icons |
| `log/`, `cache/`, `tmp/`, `electron/` | Logs, cache, temporary files, and Electron profile |

## Troubleshooting

Settings > Dev provides developer tools, logs, and Start in console. Console startup preserves the data directory and restarts the app in a system terminal to show startup and runtime output.

- **Model request fails**: check the service address, model name, key, and network connection.
- **Skill fails**: check its instructions, environment variables, and required programs.
- **MCP tools are missing**: confirm that the server is enabled and connected, the model has Tool use enabled, and the project allows the tools.
- **Operation awaits confirmation**: allow or reject it as prompted. If the outcome is uncertain, retry only when repeating the operation is acceptable.

### Startup Recovery

If startup data cannot load, the recovery page lists affected files. View error details, open logs, and choose:

- **Repair**: restores invalid settings to their defaults while keeping valid settings. Capability selections are checked field by field against the current configuration format. Unrecognized values use the corresponding defaults without translating old formats or resetting the whole file, projects, or conversations. Invalid selection lists without item defaults use the list default. Unparseable files or projects whose identity cannot be determined still require manual repair. Changed fields are listed in the error details.
- **Reset**: restores the selected configuration to defaults. **Resetting `db/projects.json` also deletes every project's conversations, messages, execution records, task recovery information, and memory**. Conversation attachments, long tool results and file-edit recovery material are also cleared. Input history, other settings, skills and project source files are kept.

Before changes, original data is saved beside the data directory under `Anas-Recovery/timestamp-random-suffix/`. If that fails, no changes are made. Restart after recovery.

Application-owned persisted data uses explicit format version `0` as its current baseline. Automatic upgrades and manual recovery are separate: missing or mismatched versions and failed upgrades do not prevent trying **Repair**. Input history and avatar asset errors also open recovery before the main interface loads. Originals are preserved before configuration, input history, avatars, project metadata, and associated databases are salvaged, retaining valid settings, project identities, conversations, and memories where possible. Unrecoverable databases remain unchanged while independent repairs continue, and unresolved issues are listed. Repair does not automatically clear projects or conversations.

Input history can recover readable entries individually while retaining their order and pinned state. Invalid entries remain in the preserved original, and the result reports partial recovery. A nonempty history with no readable entries is not replaced with an empty list. A staged project-deletion file without its corresponding journal is also preserved and does not block project repair.

Avatar repair rebuilds required assets from a readable source, crop, or display image after preserving the originals. If no image can be recovered, it reports the problem without automatically replacing the avatar with the default. Backup imports also validate avatar parameters before replacing data, rejecting unsupported versions or invalid parameters. Missing optional avatar parameters can still be initialized normally.

### Opening the macOS download

Download the DMG matching your Mac from [GitHub Releases](https://github.com/higale/anas-agent/releases), open it, and drag Anas into Applications. Launch the installed copy. If macOS blocks it because the developer cannot be verified, use **System Settings > Privacy & Security > Open Anyway**, then confirm **Open**, as described by [Apple](https://support.apple.com/102445).

If that route does not resolve a download-quarantine block, and you trust this release, compare the DMG's `shasum -a 256` output with its entry in the release's `SHA256SUMS.txt`. Then remove only the installed Anas app's quarantine attribute:

```bash
xattr -r -d com.apple.quarantine "/Applications/Anas.app"
```

Adjust the path if installed elsewhere. Use `sudo` before this command only if it fails with a permissions error and the path is correct. This removes download quarantine; it does not repair a damaged app or provide Apple notarization. For a signature verification failure, download a fresh copy; do not bypass a malware warning.

The release build already applies and verifies an ad-hoc signature. Users should not normally run `codesign --force --deep --sign -`: it replaces nested signatures, and [Apple reserves deep signing for emergency repairs](https://developer.apple.com/library/archive/technotes/tn2206/). Developers can rebuild with `npm run pack:mac:release` instead. A future release using [Developer ID signing and Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) would avoid the unidentified-developer/notarization block; current releases use ad-hoc signing.
