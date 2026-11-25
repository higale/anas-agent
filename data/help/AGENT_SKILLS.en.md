# Anas Skills Guide

Languages: [English](./AGENT_SKILLS.en.md) | [中文](./AGENT_SKILLS.zh-CN.md) · [Back to the user guide](./USER_GUIDE.en.md)

A skill provides instructions an Agent reads when needed, optionally with scripts and reference material. Enabling a skill does not install dependencies or enable tool permissions.

## Add And Manage Skills

Use **Settings > Skills** to manage global sources and browse skill instructions and files. Select a group name to list its Skills on the right; use the boxed arrow to expand or collapse it. Group headings show `@alias`; external-directory names and aliases save on Enter or focus loss. Text and scripts support syntax highlighting and **Edit** with explicit saving; system and plugin Skill files remain read-only. Saving checks for external changes, and closing with unsaved edits asks before discarding. Click a source directory, Skill, or file title to locate it in your file manager. Skill locations are also clickable.

Markdown files open in rendered **Preview**, with a **Source** switch and collapsible metadata. Relative images load from the file's directory; same-page links jump to headings, and other local file links reveal their targets in your file manager.

- **Import skills**: Click **Import skill** at the top of the page. Select one or more skill directories containing `SKILL.md` to copy into `skills/` under application data. Name conflicts prevent import without overwriting existing skills. The picker opens in the examples directory by default. On success, the **User** group expands and the first imported skill is selected and scrolled into view.
  Import copies the contents of linked files and directories into the editable skill. You can move the originals afterwards. A broken link or directory cycle causes that skill to fail. Anas checks the definitions and names for the entire selection before importing each skill. If one fails, previously imported skills stay in place and the remaining imports continue. Settings lists the successes and the reason for each failure. Incomplete temporary copies go to the system trash. If a copy cannot be safely moved, Settings shows the path to check.
- **Add directory** (top right): Select an external directory containing skill subdirectories. Anas references its files without copying them. External sources can be renamed, assigned shortcut aliases, reordered, or removed. Removing a source only removes its reference, not its files.
- **Project skills**: in the project editor, use the add button beside the **Capabilities > Skills** heading to reference custom skills roots. Each directory appears as **Project - directory name**, alongside other sources. Source folders’ `.agents/skills/` are no longer scanned automatically; add those roots manually to keep using them. Sources are grouped by directory, with open-folder and custom-reference removal actions saved with the project. They appear only in that project’s capabilities and conversations, not on the global Skills page.

`~/.agents/skills` is a default external source and can be removed. Refresh after editing files; unreadable skills show an error.

Select an external directory, then use the left toolbar to move it up or down or remove its reference. Skill entries do not yet support deletion or reordering; these buttons are disabled when an entry or file is selected.

## Choose Who Can Use Skills

Project skills appear in **Project - directory name** groups alongside other sources in **Capabilities > Skills**. Each uses a standard checkbox, with multiple entries per row. Selecting a project skill enables both shortcuts and model use. Only the top-level Skills section can collapse; its sources and directories are displayed directly. Add directories beside the outer Skills heading; open or remove references beside each directory heading. Changes are saved with the project; Cancel does not write them.

Ordinary skill details show **Shortcut** and **Available to model**. Plugin skills configure these options in **Settings → Plugins**, with read-only usage choices and a link from the Skills page. These control separate uses:

- **Shortcut** allows explicit invocation with `/skill-name request` in the message input. Type `/` to see suggestions. Anas sends the complete, unchanged `SKILL.md` and its source path, with the text after the command as a separate user request; expand the skill entry in the conversation to inspect the actual submitted text.
- **Available to model** supplies the Agent with the name, description, and absolute `SKILL.md` path so it can read the instructions when relevant.

When both options are off, the list shows **Disabled** on the right; the skill can still be viewed and edited. For ordinary skills, turning off only one option does not mark it disabled. Plugin skills also depend on the plugin’s overall switch and required tools. When either is disabled, the usage checkboxes retain their saved choices and remain editable; the skill stays inactive until its dependencies are enabled again. Loading failures show **Error** separately, without strikethrough.

Project and subagent skill entries have one checkbox, without separate shortcut and model choices. Selected ordinary skills follow their global availability settings. Selected project skills enable both uses; subagents only use skills through the model. A local selection cannot enable a globally unavailable or invalid skill. Plugin skills are selected with their entire plugin.

Subagents configure model use only, may enable **Project skills**, and follow the project's **Limit subagent capabilities** setting. Project grants do not add subagent packaged skills to the main chat; those skills are available only to the owning Agent's model and have no shortcuts. Removing a subagent does not affect ordinary skill shortcuts or block recovery because of unused packaged skills; tasks that require deleted skills still report an error. See [Subagents](./USER_GUIDE.en.md#subagents).

Name conflicts are resolved separately for effective shortcut and model selections: explicit project directory order → User → external directory order → System → Plugins (sorted by plugin ID). `/name` uses the preferred entry; `/name@alias` selects a source, for example `/name@user` or `/proofread@plugin:writing-helper`. Edit external-source aliases on the Skills page. When several sources reference the same directory, each source retains its selections and alias; effective selections still determine precedence.

## Script Execution

Skill scripts use the existing Shell tool and follow the current conversation access mode: normal command approval in Strict approval, existing read-only checks and model decisions in Smart approval, and no pre-execution permission approval in Full access. Enabling a skill does not enable a disabled command tool or expand tool capabilities.

Global, per-skill, and project script auto-approval have been removed. Previous exemption settings no longer apply; skill files, Shortcut choices, and Model choices are unaffected. Pending calls that relied on a historical Skill exemption must be submitted again under the current access mode.

## System Skills And Examples

Anas reads these system skills directly from `data/skills/` in the application package:

| Skill | Purpose |
| --- | --- |
| `config` | Changes application settings and the avatar; requires Update configuration capability. |
| `skill-manager` | Creates or modifies skills, or installs them from local directories and Git repositories. Requires file reading and writing; remote installation also needs Git and network access, and script testing needs the appropriate runtimes. |
| `tool-manager` | Creates, modifies, and troubleshoots Anas custom tools, with a format reference and Python example template. Requires file reading and writing; testing also needs command execution and the appropriate runtime. |

`data/examples/skills/` in the application package contains examples that are not loaded by default. Use **Import skill** to copy them into **User** before use:

| Example | Purpose and main dependencies |
| --- | --- |
| `weather` | Weather queries; Python 3 and network access to wttr.in. |
| `ip-location` | Public IP and approximate network location; Python 3.8+ and network access to ipinfo.io. |

System skills and examples in `data/examples/` are read directly from the application package. They are not copied into user data; old copies are preserved but no longer used as built-in sources. Import a skill into User or copy it into a project skill directory before customizing it.

Project and external sources cannot reference bundled resource directories, their parents, or directory aliases. Existing references remain in configuration and appear unavailable. File editing also checks the actual target, so links to bundled files are read-only. Independent imported user copies remain editable.

## Prepare To Run

- Check the skill's environment requirements and its `SETUP.md`, if supplied. Selecting a skill does not install Python, Git, ExifTool, or other programs.
- Edit application `.env` in **Settings > Environment**. Commands receive these variables only when the relevant Agent's **.env** capability is enabled. Configure model names, accounts, and service access for the service you actually use.
- Explicit invocation loads the complete `SKILL.md` directly. Autonomous skill loading and reading supporting files still need a file-reading tool or command execution; scripts usually need **Command execution**. The model must also support tool use with **Tool use** enabled. Operations follow the current access mode.

## Write A Skill

Anas uses the [Agent Skills format](https://agentskills.io/specification). Each skill directory must contain an exact uppercase `SKILL.md` file and may include `scripts/`, `references/`, `assets/`, and other resources.

For example, `photo-search/SKILL.md`:

```markdown
---
name: photo-search
description: Search local photos by metadata; not for recognizing image contents.
compatibility: Requires Python 3 and ExifTool.
---

Describe the steps, arguments, and results here.
```

- `name` must match the directory name, use lowercase English letters, numbers, and single hyphens, and be at most 64 characters. It must not start or end with a hyphen.
- `description` is required and describes the purpose and applicable tasks. The Agent Skills specification sets a 1024-character limit; Anas shows a warning icon for longer descriptions while preserving the full text and allowing loading, import, saving, model use, and shortcuts. Missing or empty descriptions remain errors.
- `compatibility` is optional; when present, it must be nonempty and at most 500 characters, describing environment dependencies.
- Resolve relative paths from the directory containing `SKILL.md`. User setup instructions may go in `SETUP.md`.
- Explicit invocation preserves the front matter and body without substituting placeholders such as `$ARGUMENTS` or `$0`. Describe how to act on the user’s request in the skill instructions. `SKILL.md` is limited to 1 MiB.

Model and user availability switches are stored in Anas configuration, not in skill files.
