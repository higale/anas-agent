import type { RuntimeToolDefinition } from '@shared/types'

export function toolDefinitionText(tool: RuntimeToolDefinition): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? {
      type: 'object',
      properties: Object.fromEntries(tool.parameters.map((parameter) => [
        parameter.name,
        {
          description: parameter.description,
          ...(parameter.schema && typeof parameter.schema === 'object'
            ? parameter.schema as Record<string, unknown>
            : {})
        }
      ]))
    }
  }, null, 2)
}
