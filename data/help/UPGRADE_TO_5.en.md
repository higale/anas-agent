# Upgrading to Anas 5.0: Data Impact and Copying Settings

[简体中文](UPGRADE_TO_5.zh-CN.md) · [User guide](USER_GUIDE.en.md)

**Version 5.0 uses a fresh native execution database (catalog v2, conversations v1). Previous conversations, memory and execution records are not migrated, and legacy full backups cannot be restored.** Only compatible settings and extensions can be copied manually. Backup, repair and crash recovery remain available for current 5.0 data.

**Upgrading from 5.0.0 to 5.0.1:** The catalog changes from v1 to v2; conversation databases remain v1. Backups containing the old catalog cannot be restored directly; repair the original data directory and create a new backup. If startup reports a catalog version or access-mode constraint error, select project data repair on the recovery page. Original files are preserved before the catalog is repaired; invalid permission values use the default Smart approval mode. This does not convert legacy framework databases or replay tools. Do not change only the version number.

## Subagent Configuration Compatibility

**Subagent configuration notice (since 4.0.5):** `config/subagents.json` uses v1; the previous v0 array format is neither supported nor migrated. Old files are preserved and reported as a startup error, and backups containing that format cannot be restored directly. Fully quit the app, move the old file outside the data directory for safekeeping, then restart and recreate or import subagent packages. Do not just change the version number. Existing v1 configurations are unaffected. [Subagent setup and recovery instructions](USER_GUIDE.en.md#subagents)

## Manual Copying Steps

**Copying compatible settings and extensions:** Version 5.0 uses `.anas/` under your user home directory. On Windows this is usually `C:\Users\<username>\.anas`; enter `%USERPROFILE%\.anas` in File Explorer. On macOS/Linux it is `~/.anas/`. The old directory is `.galeAnas/` under the same home directory. Nothing is imported automatically. An explicit `--data-dir` selects a different destination.

1. Fully quit both versions. Back up the entire old directory and keep the original. Prepare a new data directory for 5.0; back up existing destination data separately instead of merging or overwriting it.
2. Preserve relative paths when copying supported `config/` files (including avatars in `config/assets/`), `.env`, and user-managed `skills/`, `tools/`, `subagents/` and `plugins/`. Subagent configuration must use v1; recreate old v0 array settings as described above. Referenced external directories, programs and project source folders must remain accessible.
3. **Do not copy the old `db/` or restore a legacy full backup.** Previous conversations, memory and execution records are not converted. Recreate projects and other database contents in the new directory. Copying plugin code does not include business data under the old `db/plugins/`.
4. Start 5.0, check settings, models and extensions, then recreate projects. Keep the old directory and backups if an error occurs. Do not change database version markers to force compatibility.

For historical changes when upgrading to 4.x, see the [4.x upgrade data guide](UPGRADE_TO_4.en.md). Its database-content recovery steps do not apply to 5.0.
