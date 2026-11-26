import { defineTool, defineContentTool, jsonToolResult, type ToolDefinition } from '../../runtime/toolDefinition'
import { z } from 'zod/v3'
import { configToolDefinitions } from './configTools'
import { httpRequestDefinition } from './httpRequestTool'
import {
  describeCommandShellArgument,
  describeCommandShellTool,
  getCommandShell,
  type CommandShellInfo
} from '../shellRuntime'
import {
  commandShellCapabilityId,
  commandShellMetadata,
  commandShellToolName,
  maxCommandTimeoutSeconds
} from '@shared/commandShell'
import { toolSummarySchema } from './toolSummary'
import type { ManagedCallService } from '../agent/managedCallService'
import { terminalActionSchema, terminalSizeSchema, type TerminalSize } from '@shared/terminal'
import { userInputSchema, type UserInputSource } from '@shared/userInput'
import { userInputService } from '../agent/userInputService'

export type ShellRunner = (input: {
  command: string
  summary?: string
  timeoutSec?: number
  workingDir?: string
  pty?: TerminalSize
}) => Promise<string>

export interface RuntimeToolOptions {
  enabled: boolean
  mcp?: boolean
  mcpTools?: ToolDefinition[]
  primaryFolder: string
  configuration?: boolean
  projectId?: string
  threadId?: string
  runId?: string
  userInputSource?: () => Promise<UserInputSource>
  network: boolean
  backgroundTools?: boolean
  interactiveCustomTools?: boolean
  shell: boolean
  commandShell?: CommandShellInfo
  toolNames?: readonly string[]
  signal?: AbortSignal
  shellRunner?: ShellRunner
  managedCalls?: Pick<ManagedCallService, 'read' | 'readOutput' | 'readResult' | 'wait' | 'cancel' | 'start'>
    & Partial<Pick<ManagedCallService, 'writeTerminal'>>
  managedCallSupervision?: boolean
}

export type ManagedCallToolOptions = Pick<
  RuntimeToolOptions,
  'managedCalls' | 'threadId' | 'signal'
>

export function requireManagedCallContext(options: ManagedCallToolOptions) {
  if (!options.managedCalls || !options.threadId) {
    throw new Error('Background call tools require a conversation runtime.')
  }
  return {
    managedCalls: options.managedCalls,
    threadId: options.threadId
  }
}

export function managedCallToolDefinitions(
  options: ManagedCallToolOptions = {}
): ToolDefinition[] {
  return [
    defineTool({
      name: 'read_call',
      description: 'Read background call status without waiting. Pass call_id for one exact call, or omit it to list every call in this conversation that still requires attention. Output content is available through read_call_output.',
      inputSchema: z.object({
        summary: toolSummarySchema,
        call_id: z.string().uuid().optional().describe('Exact background call ID. Omit to list all calls in this conversation that still require attention.')
      }),
      execute: async (input) => {
        const { managedCalls, threadId } = requireManagedCallContext(options)
        return jsonToolResult(JSON.parse(await managedCalls.read({
          callId: input.call_id,
          threadId
        })))
      }
    }),
    defineTool({
      name: 'read_call_output',
      description: 'Read one exact character range from the complete persisted output of a background call without waiting. Offset 0 also returns any completed image/resource artifacts. Range reads do not affect call health or completion.',
      inputSchema: z.object({
        summary: toolSummarySchema,
        call_id: z.string().uuid().describe('Exact background call ID.'),
        output_offset: z.number().int().describe('Zero-based character offset from the start. Use a negative value to start relative to the current end, such as -100 for the final 100 characters.'),
        output_length: z.number().int().min(1).max(10_000).describe('Maximum number of characters to return, from 1 through 10000.')
      }),
      execute: async (input) => {
        const { managedCalls, threadId } = requireManagedCallContext(options)
        const output = jsonToolResult(JSON.parse(await managedCalls.readOutput({
          callId: input.call_id,
          threadId,
          offset: input.output_offset,
          length: input.output_length
        })))
        const result = input.output_offset === 0 ? await managedCalls.readResult(input.call_id, threadId) : undefined
        const nonText = result && Array.isArray(result.content)
          ? result.content.filter((block) => block !== null && typeof block === 'object' && 'type' in block && block.type !== 'text') : []
        return { ...output, content: nonText.length ? [{ type: 'text' as const, text: String(output.content) }, ...nonText] : output.content, artifact: result?.artifact }
      }
    }),
    defineTool({
      name: 'wait_call',
      description: 'Wait for one background call until it reaches a terminal state or the requested timeout expires. New output never wakes the wait. The response always includes the current total output size and progress counters; use read_call_output only when details are needed.',
      inputSchema: z.object({
        summary: toolSummarySchema,
        call_id: z.string().uuid().describe('Exact background call ID.'),
        timeout: z.number().int().min(10).max(300).optional().describe('Maximum wait in seconds. Default 30; range 10 through 300.')
      }),
      execute: async (input) => {
        const { managedCalls, threadId } = requireManagedCallContext(options)
        return jsonToolResult(JSON.parse(await managedCalls.wait({
          callId: input.call_id,
          threadId,
          timeoutMs: typeof input.timeout === 'number' ? Math.round(input.timeout * 1000) : undefined,
          signal: options.signal
        })))
      }
    }),
    defineTool({
      name: 'cancel_call',
      description: 'Request cancellation of one exact background tool call owned by this conversation. Cancellation is idempotent; remote effects may remain uncertain.',
      inputSchema: z.object({
        summary: toolSummarySchema,
        call_id: z.string().uuid().describe('Exact background call ID to cancel.')
      }),
      execute: async (input) => {
        const { managedCalls, threadId } = requireManagedCallContext(options)
        return jsonToolResult(JSON.parse(await managedCalls.cancel(input.call_id, threadId)))
      }
    })
  ]
}

export async function runtimeToolDefinitions(options: RuntimeToolOptions): Promise<ToolDefinition[]> {
  if (!options.enabled) return []
  const tools: ToolDefinition[] = []
  const selectedToolNames = options.toolNames ? new Set(options.toolNames) : undefined
  const includesTool = (name: string) => !selectedToolNames || selectedToolNames.has(name)
  if (includesTool('request_user_input')) tools.push(defineContentTool({
    name: 'request_user_input',
    description: 'Ask the user to choose options or enter an Other answer in a dialog. Returns answered, cancelled, or timed_out. This tool waits inline and never becomes a background call. Default answer timeout is 60 seconds; timeout_seconds allows 30–600 seconds. User interaction cancels the timeout so they can finish answering. Use require_response=true cautiously, only when an answer is essential to continue. After timeout or cancellation, continue from known information or explain what is missing; do not immediately repeat the same question.',
    inputSchema: userInputSchema,
    execute: async (input, context) => {
      if (!options.threadId || !options.runId || !options.userInputSource) throw new Error('User input requires an active agent run and its source.')
      const signals = [options.signal, context.signal].filter((signal): signal is AbortSignal => Boolean(signal))
      return JSON.stringify(await userInputService.request(input, {
        threadId: options.threadId, runId: options.runId,
        source: await options.userInputSource(),
        signal: signals.length ? AbortSignal.any(signals) : undefined
      }))
    }
  }))
  if (includesTool('sleep')) tools.push(defineContentTool({
    name: 'sleep',
    description: 'Wait for a specified number of seconds before continuing. Use this instead of a Shell sleep command for a pure time delay. Waits inline until the duration elapses or the run is cancelled; never becomes a background call. Waiting does not check external state: use the appropriate tool afterward to observe changes. To wait for an existing background call to finish, use wait_call instead.',
    inputSchema: z.object({
      seconds: z.number().int().min(1).max(300).describe('Required wait duration in whole seconds, from 1 through 300.'),
      summary: toolSummarySchema
    }),
    execute: async (input, context) => {
      const signals = [options.signal, context.signal].filter((signal): signal is AbortSignal => Boolean(signal))
      const signal = signals.length ? AbortSignal.any(signals) : undefined
      signal?.throwIfAborted()
      const startedAt = performance.now()
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          clearTimeout(timer)
          reject(signal?.reason)
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort)
          resolve()
        }, input.seconds * 1000)
        signal?.addEventListener('abort', abort, { once: true })
      })
      return JSON.stringify({ status: 'completed', elapsed_seconds: Math.round(performance.now() - startedAt) / 1000 })
    }
  }))
  const terminalEnabled = options.shell && includesTool(commandShellCapabilityId) && options.backgroundTools

  if (options.shell && includesTool(commandShellCapabilityId)) {
    const commandShell = options.commandShell ?? await getCommandShell()
    const toolName = commandShellToolName(commandShell.executable)
    tools.push(defineContentTool({
      name: toolName,
      description: `${describeCommandShellTool(commandShell)} Use the current shell's syntax for pipes and redirection. ${terminalEnabled
        ? 'For commands that require interactive input, explicitly request pty at launch; use write_call for subsequent input. A non-PTY process cannot be converted into an interactive terminal later.'
        : 'Interactive terminal input is unavailable. Use non-interactive command options or supply required input within the command. You cannot send follow-up input or attach a PTY after launch. Non-interactive mode does not guarantee completion; a command may still wait indefinitely until the user stops it.'} OMIT timeout for normal commands; expected long duration is not a reason to set one. Only provide timeout when the user explicitly requests a finite deadline or a known external deadline must be enforced. The call completes when the Shell itself exits. Only that Shell is automatically stopped by cancellation, timeout, or application exit; its child processes are not automatically terminated. Completed results include known remaining direct child processes, excluding descendants started by those applications; tracking is best-effort. A yielded Shell can continue across turns. Use read_call/wait_call for status and cancel_call to stop a live Shell explicitly when finished. Stopping a completed call does not stop its children; stop those explicitly through a new command when needed. PTY closure can affect programs attached to the terminal.`,
      metadata: commandShellMetadata(),
      inputSchema: z.object({
        ...(terminalEnabled ? { pty: terminalSizeSchema.optional().describe('Explicitly allocate a PTY for a CLI that needs terminal input. stdout/stderr are merged UTF-8 terminal text, including control sequences. Use read_call to obtain terminal_id, then write_call. Omit for ordinary commands.') } : {}),
        command: z.string().refine(value => value.trim().length > 0, 'command must contain non-whitespace text.').describe(describeCommandShellArgument(commandShell)),
        summary: toolSummarySchema,
        timeout: z.number().int().min(0).max(maxCommandTimeoutSeconds).optional().describe('Exceptional hard execution deadline in seconds. OMIT for normal commands; omission means no time limit. NEVER infer or add a timeout merely because a command may take a long time. Supply a positive value only for an explicitly requested or externally required finite deadline. Use 0 only to explicitly request no limit.'),
        working_dir: z.string().optional().describe('Execution directory, absolute or relative to the primary/default folder. Defaults to that folder.'),
      }).strict(),
      execute: async (input) => {
        if (!options.shellRunner) throw new Error(`${toolName} is not connected to an executor.`)
        return options.shellRunner({
          command: input.command,
          summary: typeof input.summary === 'string' ? input.summary : undefined,
          timeoutSec: typeof input.timeout === 'number' ? input.timeout : undefined,
          workingDir: typeof input.working_dir === 'string' ? input.working_dir : undefined,
          ...(input.pty ? { pty: terminalSizeSchema.parse(input.pty) } : {})
        })
      }
    }))
  }

  if (terminalEnabled || (options.backgroundTools && options.interactiveCustomTools)) {
    tools.push(defineContentTool({
      name: 'write_call',
      description: 'Send input or resize an exact live PTY owned by this conversation. Obtain terminal_id from read_call, never guess or reuse a replaced terminal. Text is literal (add enter explicitly); keys/EOF can execute pending commands and require the current Shell approval policy. EOF sends Ctrl+D on POSIX or Ctrl+Z then Enter on Windows, not a guaranteed half-close in raw-mode CLIs. Ctrl+C interrupts the foreground command; use cancel_call to stop the Shell; attached programs may also react to terminal closure. Input acceptance does not mean completion. Output remains in read_call_output. Input is bounded to 16000 characters per call and cumulatively 1 MiB/4096 writes per session; use files for bulk data.',
      inputSchema: z.object({ summary: toolSummarySchema, call_id: z.string().uuid(), terminal_id: z.string().uuid(), action: terminalActionSchema }),
      execute: async (input) => {
        options.signal?.throwIfAborted()
        const { managedCalls, threadId } = requireManagedCallContext(options)
        if (!managedCalls.writeTerminal) throw new Error('Terminal input is not connected to an executor.')
        return managedCalls.writeTerminal(input.call_id, threadId, input.terminal_id, input.action)
      }
    }))
  }

  if (options.network && includesTool('http_request')) {
    tools.push(httpRequestDefinition({
      primaryFolder: options.primaryFolder,
      signal: options.signal
    }))
  }

  if (options.backgroundTools || options.managedCallSupervision) {
    tools.push(...managedCallToolDefinitions(options))
  }

  if (options.configuration) {
    tools.push(...configToolDefinitions(options.primaryFolder))
  }

  if (options.mcp) tools.push(...(options.mcpTools ?? []))
  return tools
}
