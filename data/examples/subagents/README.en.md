# Subagent examples

[简体中文](README.md)

Only `general-purpose` is built in. These examples are not loaded automatically:

- `web-researcher`: researches external information, verifies sources, and returns findings with links.
- `project-analyst`: analyzes project files, code, configuration, and documents without modifying them.

In **Settings > Subagents**, click **Import subagent** at the top right and select one or more example packages. Import copies them into the user's `subagents/` directory. Conflicting IDs or names and invalid packages stop the entire batch. Imported Agents can be edited, disabled, or deleted.

Each package contains `AGENT.json` (definition and capabilities) and `PROMPT.md` (prompt). You can add private `skills/` and `tools/`. Edit the prompt through the file tree in settings. Available capabilities remain subject to host and project settings.

The app refreshes this examples directory. Import before editing; do not edit it directly or add it as an external Agent source. Refreshing examples does not overwrite imported copies.
