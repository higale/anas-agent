---
name: tool-manager
description: "Create, modify, or troubleshoot Anas custom tool packages containing TOOL.json and executable scripts. Use when the user wants a reusable model-callable tool in Anas. Do not use merely to run an existing tool, write a one-off script, create an Agent Skill, or configure an MCP server."
---

# Manage Anas Custom Tools

Deliver a working tool package for the requested operation. This Skill targets Anas's TOOL.json format. Authoring requires filesystem access; execution tests require command execution and the tool's runtime. The included Python template requires Python 3 and only its standard library. Skill availability does not grant these capabilities.

## Choose the Package

- Inspect existing tools and the user's requested scope before creating another. For an update, preserve the package ID and unrelated behavior; inspect its manifest, script, resources, and dependencies first.
- For project-specific work, use `.agents/tools/<directory>/` under an actual source folder of the current project. For reusable user tools, use `tools/<directory>/` under the application data directory reported by the host. Honor an explicit destination; ask if the required root is unavailable or ambiguous. Do not guess a home-directory path or derive it from this Skill's installation directory.
- Do not author in managed `tools_examples/`, `tools_system/`, or `skills_system/` copies. Editing bundled source is appropriate only when the user is developing Anas itself.

## Build the Tool

Read [references/tool-format.md](references/tool-format.md) before writing or changing a manifest or command. It describes package fields, argument handling, environment, results, and activation.

For a simple Python tool, adapt [assets/python-tool/TOOL.json](assets/python-tool/TOOL.json) and [assets/python-tool/scripts/run.py](assets/python-tool/scripts/run.py). They form a runnable text-normalization example, not a required business design. Give a new tool its own stable ID, descriptive name, description, schema, and implementation. Use an existing interpreter or program when that better fits the operation.

Keep the schema and script consistent. Describe when the model should call the tool, what each argument means, and which paths must be absolute. Put complex logic in the script: `command` is literal argument syntax, not a Shell command line. Preserve exactly one standalone `{{args}}` argument.

Return useful results on stdout and diagnostics on stderr. Signal failure with a nonzero exit code; printing an error object with exit code zero still counts as success. Identify dependencies and required environment variable names without embedding credentials or personal paths. Inspect available dependencies before installing anything, and keep any installation within the user's authorized scope.

## Verify and Activate

1. Validate the JSON and the current tool contract. In an Anas source checkout, reuse its manifest loader, Schema validator, and runtime tests; do not implement another approximate Anas validator. In an installed app, use available tool discovery/refresh to inspect load errors. If those checks cannot be performed, report that limitation.
2. Test the script from its package directory using representative valid input and a meaningful failure case. Pass serialized JSON as one argument through an argument-array API; avoid interpolating it into Shell source. Include Unicode, quotes, and spaces when text or paths are accepted. Use temporary fixtures and avoid real external mutations merely to smoke-test a tool.
3. When the tool is actually exposed to the model, invoke it through Anas to verify the full path. Direct script execution alone does not prove Anas registration or capability selection. Do not repeat a mutating operation solely because its output was truncated or its completion is uncertain.
4. Explain the remaining activation step: new tools are not selected automatically. The user selects them in default, project, or subagent capabilities. A refreshed catalog and a subsequent run load new definitions; the current run retains its original tool list. Do not invent an activation API, edit unrelated capability selections, or claim the tool is enabled merely because its files exist.

Report the package location, callable name, dependencies, checks actually performed, and any remaining activation or verification step. For modifications, distinguish changes to the manifest (loaded for subsequent runs) from changes to scripts (read at execution time).
