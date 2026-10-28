# Upgrading to Anas 4.x: data changes and manual recovery

[简体中文](UPGRADE_TO_4.zh-CN.md) · [User guide](USER_GUIDE.en.md)

**When upgrading from a version before 4.0 to any 4.x release, previous conversations and all long-term memory, including project memory, become unavailable. There is no migration or import of pre-4.0 backups.** This storage-layout change was introduced in 4.0.0 and also applies when skipping directly to a later 4.x release. Data already using the new 4.x layout is not discarded again because of this change.

This guide covers only the 4.0.0 data-directory changes. Other compatibility changes in later releases, such as plugin installation paths, are described in their own release notes.

## Affected data

| Data | After upgrading | Recovery |
| --- | --- | --- |
| Previous conversations and their attachments, file-edit recovery material, and related files | The old conversation storage is no longer read | No migration; moving or renaming an old database does not restore conversations |
| All long-term memory, including project memory | New memory storage is used | No migration |
| Project definitions and settings | Previous projects disappear; the app reads `db/projects.json` | Move the original file manually |
| Input history, including pinned inputs | Previous history disappears; the app reads `db/input_history.json` | Move the original file manually |
| Independent plugin data | The old `plugins_data/` directory is not read | Move the entire directory to `db/plugins/` |
| Custom avatars | The old root-level `assets/` directory is not read; default avatars are used until recovery | Move the entire directory to `config/assets/` |
| Global configuration, project source files, and user-managed packages such as skills and tools | Not discarded by this directory change; supported v0 global configuration remains readable | No moves described in this guide are needed |

Old files may remain on disk. Upgrading does not delete them automatically, but the app neither reads the old layout nor includes its residues in new backups. Missing data in the interface therefore does not necessarily mean its old files have been deleted; keeping those files does not make old conversations or memory compatible with the new version.

## Back up before upgrading

Fully quit Anas and copy the entire old data directory to a safe location outside that directory. Do not rely only on an application backup made after upgrading: it excludes old-layout residues.

The original standard Anas uses `~/.galeAnas/` by default, usually `%USERPROFILE%\.galeAnas\` on Windows. Anas 5.0 always defaults to `~/.anas/` and does not automatically read or migrate the old directory or the previous `~/.anas-next/` directory. An explicit `--data-dir` selects a different root. The following retains the original 4.x upgrade guidance; all paths are relative to the actual data root.

Application backup ZIPs made before 4.0 cannot be imported through Restore backup in 4.x. Keep them as original records; do not change version markers to force an import.

## Manually recover supported data

Preferably do this before creating projects or other new data in the upgraded app:

1. Fully quit Anas. Back up the original data and any files or directories already created at the destinations.
2. Move the files or directories you need according to the table below, creating parent directories if necessary. Do not change file contents or the internal directory structure.
3. If a destination already exists, move it elsewhere for safekeeping before replacing it with the old data. **Replacement does not merge data; it replaces the corresponding new data.**
4. Restart Anas and check the recovered project settings, input history, plugin data, and avatars.

| Old path | New path | Restored content |
| --- | --- | --- |
| `projects.json` | `db/projects.json` | Project definitions and settings, without their old conversations or memory |
| `input_history.json` | `db/input_history.json` | Input history and pinned inputs |
| `plugins_data/` | `db/plugins/` | Independent plugin data; replace the directory as a whole, without merging |
| `assets/` | `config/assets/` | Custom avatar resources; replace the directory as a whole, without merging |

Project and input-history files retain their supported v0 format; no JSON edits are needed. Do not move the old `sqlite/` directory, conversation directories, or databases directly into `db/`. These manual moves cannot restore old conversations or memory.

## When to remove old files

Finish backing up and recovering the data you need, then inspect **Settings → General → Data cleanup → Unknown files**. This option is unchecked by default. Removing an old directory deletes everything inside it. Backup ZIPs stored in the data root may also appear in the cleanup preview; move them elsewhere first.

Original release record: [Anas 4.0.0](https://github.com/higale/anas-agent/releases/tag/v4.0.0).
