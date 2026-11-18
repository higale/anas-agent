# Upgrading to Anas 5.x: Data Impact and Copying Settings

[简体中文](UPGRADE_TO_5.zh-CN.md) · [User guide](USER_GUIDE.en.md)

**The current formats are catalog v2, conversations v3, and separate memory v1, with projects and conversations stored in project directories.** Backup, repair, and crash recovery remain available for current-format data. The sections below describe historical compatibility boundaries; data already using the current formats does not need another reset because of these changes.

**Upgrading from 4.x or earlier:** Since 5.0, Anas uses fresh native execution databases. Conversations, memory, and execution records from the old framework are not migrated, and its full backups cannot be restored. Only compatible settings and extensions can be copied manually using the steps below; do not copy the old `db/`.

## Upgrading to 5.2.0: Activity display redesign

This redesign requires a new **v3 conversation database**. Pre-upgrade v1/v2 conversations must be cleared by the user; the app does not migrate or automatically delete them. Backups containing v1 or v2 conversations cannot be restored. Configuration, project definitions, Skills, tools, plugins, and the separate memory database keep their formats. Preserve any old data you need; do not change database version numbers manually. Backup, preservation, and explicit repair remain available for v3 data.

## Upgrading to 5.0.2

Projects now use `db/projects/<project ID>/project.json`, with conversations in that project's `conversations/` directory. The old `db/projects.json` / `db/conversations/` layout is neither read nor migrated, and its backups cannot be restored. If you still use that layout, preserve the data first, then reset all projects and conversations. Old files are not cleaned up automatically; do not move old conversation directories directly into the new layout.

## Upgrading to 5.0.1: Catalog access-mode constraints

The catalog changed from v1 to v2. Conversation databases were still v1 at that point; they now use v3 under the 5.2.0 boundary above. Backups containing the old catalog cannot be restored directly. If startup reports a catalog version or access-mode constraint error, select project data repair on the recovery page. Original files are preserved before salvage and catalog reconstruction; invalid permission values use the default Smart approval mode. Repair does not convert old conversation formats or replay tools, and does not replace the required project-layout and conversation-version upgrade steps. Do not change only the version number.

## Subagent Configuration Compatibility

**Subagent configuration notice (since 4.0.5):** `config/subagents.json` uses v1; the previous v0 array format is neither supported nor migrated. Old files are preserved and reported as a startup error, and backups containing that format cannot be restored directly. Fully quit the app, move the old file outside the data directory for safekeeping, then restart and recreate or import subagent packages. Do not just change the version number. Existing v1 configurations are unaffected. [Subagent setup and recovery instructions](USER_GUIDE.en.md#subagents)

## Manual Copying Steps

These steps apply when creating a fresh 5.x data directory from an old framework version. The default directory is `.anas/` under your user home directory. On Windows this is usually `C:\Users\<username>\.anas`; enter `%USERPROFILE%\.anas` in File Explorer. On macOS/Linux it is `~/.anas/`. The old directory is `.galeAnas/` under the same home directory. Nothing is imported automatically. An explicit `--data-dir` selects a different destination.

1. Fully quit both versions. Back up the entire old directory and keep the original. Prepare a new data directory for 5.x; back up existing destination data separately instead of merging or overwriting it.
2. Preserve relative paths when copying supported `config/` files (including avatars in `config/assets/`), `.env`, and user-managed `skills/`, `tools/`, `subagents/` and `plugins/`. Subagent configuration must use v1; recreate old v0 array settings as described above. Referenced external directories, programs and project source folders must remain accessible.
3. **Do not copy the old `db/` or restore a legacy full backup.** Previous conversations, memory and execution records are not converted. Recreate projects and other database contents in the new directory. Copying plugin code does not include business data under the old `db/plugins/`.
4. Start 5.x, check settings, models and extensions, then recreate projects. Keep the old directory and backups if an error occurs. Do not change database version markers to force compatibility.

For historical changes when upgrading to 4.x, see the [4.x upgrade data guide](UPGRADE_TO_4.en.md). Its database-content recovery steps do not apply to 5.x.
