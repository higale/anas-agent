# Anas Tool Package Contract

## Discovery and Identity

Each package is a directory with `TOOL.json` at its root and any scripts/resources beside it. User packages live under the application data directory's `tools/`; project packages live under a configured project source folder's `.agents/tools/`. System packages are mirrored to `tools_system/`; added external directories are referenced in place. Project packages do not appear in the global tool-management list.

`config/tools.json` stores versioned source references and ordering, not tool definitions. Creating a package does not require adding its manifest there. Inspect names and IDs before choosing a destination; do not overwrite a conflicting package. Preserve the ID when updating or renaming. Use Anas's management UI to rename or delete installed user packages so selection, ordering, and active-directory checks remain consistent.

Among valid enabled tools with the same callable name, precedence is project source-folder order, user tools, added external-directory order, then system tools. A file existing on disk does not establish which definition is selected.

## TOOL.json

Use these persisted field names:

| Field | Contract |
| --- | --- |
| `version` | Required integer `0`, the current application tool format. |
| `id` | Stable package identity: 1–100 letters, digits, underscores, or hyphens; unique within its source. Do not include catalog prefixes such as `user:`. |
| `name` | Callable name: at most 64 characters; begins with a letter or underscore, then letters, digits, underscores, or hyphens. Avoid built-in/Shell tool names and reserved `mcp_`, `__`, `anas_`, and `code_review` prefixes. |
| `description` | Nonempty operation and usage guidance, at most 8192 characters. |
| `input_schema` | JSON Schema draft 2019-09, root `type: "object"`, serialized JSON at most 65536 characters. Omit `$schema` or declare `https://json-schema.org/draft/2019-09/schema`. Other drafts are rejected. |
| `command` | Executable plus fixed arguments, with exactly one standalone `{{args}}` argument. |
| `timeout_seconds` | Integer from 0 to 2147483; 0 means no deadline. |
| `interactive` | Boolean, default false. True allocates a PTY and requires the Agent's background-tools capability. |

The manifest must be no larger than 128 KiB. Do not write internal fields such as `directory`, `inputSchema`, or `timeoutSeconds` into it. Use `required`, bounds, and `additionalProperties` according to the operation; declare useful argument descriptions. Schema `format` annotations are not runtime format validation, so validate business-specific formats in the script.

## Commands, Paths, and Environment

The process working directory is always the package directory, not the project directory. Resolve packaged resources relative to it; require explicit paths for project files when needed.

Examples:

```text
scripts/run.py {{args}}
"{{tool_dir}}/scripts/run.py" --data {{args}}
node scripts/run.cjs {{args}}
```

Anas tokenizes the command first, substitutes `{{tool_dir}}` in fixed arguments, then replaces `{{args}}` with the entire JSON argument string. Model-provided strings are not expanded or parsed as Shell source. There must be exactly one independent `{{args}}`, not `--data={{args}}` or a fragment inside script source.

Quotes group arguments containing spaces; backslashes remain literal. Pipelines, redirection, variable expansion, and multiple Shell statements are unsupported. Put such orchestration in a script. Limits are 16384 command characters and 128 arguments after the executable. JSON input is limited to 1 MiB and also to the operating system's command-line limit; use files for large payloads.

A `.py` executable entry uses Anas's Python 3 discovery. Python must already be installed; Anas does not install it. For a particular virtual environment or interpreter option, specify the interpreter explicitly. Node and other programs must be available through the actual execution environment or an explicit executable path.

Tools inherit the process environment. Application `.env` variables are additionally supplied only when that Agent's `.env` capability is enabled. Use environment variables for credentials; do not put their values in manifests, scripts, example arguments, or output.

## Results and Long-Running Operations

Successful stdout is returned as text, including JSON if the script chooses that format. Anas does not interpret business fields such as `ok` to determine success. Exit nonzero for failure and put diagnostics on stderr. Validate inputs before performing mutations; report any partial effects accurately.

Inline stdout is limited to 524288 characters and stderr to 120000. Large outputs should be written to an explicit output file and summarized with its path. Truncation does not mean execution failed or that no effects occurred.

Ordinary custom tools do not require the Agent's general command-execution capability. Interactive tools additionally require background tools. PTY output merges stdout/stderr and may contain terminal control sequences; use noninteractive execution for exact machine-readable output.

When background execution returns a call ID, use the available managed-call tools to inspect or wait for that call. For PTY input, `read_call` supplies `terminal_id`, `read_call_output` reads prompts, and `write_call` sends input. Do not launch another process to continue the same operation. Cancellation and timeouts do not roll back completed side effects.

## Activation and Updates

Refresh the tool catalog after creating or changing packages. Select the tool in the applicable default, project, or subagent custom-tool capabilities; project overrides and subagent limits still apply. Subagents use their own selection and may allow the current project's tools. An interactive tool is unavailable while background tools are disabled even if selected.

Definitions are fixed for each run. A subsequent run reads new manifests; changing files does not inject a tool into an already-running Agent. Scripts and dependencies are read at execution time, so inspect whether an existing tool is in use before editing its behavior.

If working on Anas source, the authoritative implementations are `src/shared/customTools.ts` (command and Schema validation), `src/main/toolsStore.ts` (manifest loading and discovery), and `src/main/agent/customToolRuntime.ts` (execution). These repository paths may not exist in an installed application; do not assume they are available.
