import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from './plugins'
import { parsePluginTools, pluginToolId, pluginToolName } from './pluginTools'
import { defaultCapabilities, parseCapabilities, serializeCapabilities, parseRunConfiguration, serializeRunConfiguration, intersectCapabilities, resolveSkillSelection } from './agentCapabilities'

const declaration = { id: 'echo', handler: 'echo', description: 'Echo text.', effect: 'read', input_schema: { type: 'object' } }

describe('static plugin tool contracts', () => {
  it('uses readable namespaces and rejects overlong declarations before installation', () => {
    expect(pluginToolName('rdp', 'connect')).toBe('plugin__rdp__connect')
    expect(pluginToolName('other', 'connect')).toBe('plugin__other__connect')
    const manifest = { version: 0, api_version: 2, id: 'rdp', name: 'Desktop', plugin_version: '1.0.0', backend: 'backend.cjs' }
    const id = 'a'.repeat(51)
    expect(pluginToolName('rdp', id)).toHaveLength(64)
    expect(parsePluginManifest({ ...manifest, tools: [{ ...declaration, id }] }).tools[0].id).toBe(id)
    expect(() => parsePluginManifest({ ...manifest, tools: [{ ...declaration, id: id + 'b' }] })).toThrow('64 characters')
  })
  it('parses a backend-only tool package without any executable host hooks', () => {
    const manifest = parsePluginManifest({ version: 0, api_version: 2, id: 'example', name: 'Example', plugin_version: '1.0.0', backend: 'backend.cjs', tools: [declaration] })
    expect(manifest.ui).toBeUndefined()
    expect(manifest.tools).toEqual([{ id: 'echo', handler: 'echo', description: 'Echo text.', effect: 'read', inputSchema: { type: 'object' }, timeoutSeconds: 30 }])
  })
  it.each([
    [declaration, declaration], [{ ...declaration, effect: undefined }], [{ ...declaration, timeout_seconds: 0 }],
    [{ ...declaration, id: '../outside' }], [{ ...declaration, input_schema: { type: 'object', required: 'bad' } }]
  ])('rejects invalid declarations before executing any code: %j', (...tools) => {
    expect(() => parsePluginTools(tools)).toThrow()
  })
  it('requires a backend for tools and permits packages without contributions', () => {
    expect(() => parsePluginTools([declaration], false)).toThrow('backend')
    expect(parsePluginTools(undefined, false)).toEqual([])
  })
  it('defaults old capability and run records to no plugin tools and preserves explicit empty lists', () => {
    const raw = serializeCapabilities(defaultCapabilities)
    delete (raw as { plugin_tools?: string[] }).plugin_tools
    expect(parseCapabilities(raw).pluginTools).toEqual([])
    expect(parseCapabilities({ ...raw, plugin_tools: [] }).pluginTools).toEqual([])
    const old = { capabilities: defaultCapabilities, codingMode: false, customTools: [] }
    expect(parseRunConfiguration(serializeRunConfiguration(old))).toEqual(old)
    const selected = { ...old, capabilities: { ...defaultCapabilities, pluginTools: ['example:tool:echo'] } }
    expect(parseRunConfiguration(serializeRunConfiguration(selected))).toEqual(selected)
    expect(serializeRunConfiguration(selected)).not.toHaveProperty('plugin_tools')
  })
  it('intersects explicit plugin IDs only when the caller applies the project ceiling', () => {
    const value = { ...defaultCapabilities, customTools: { project: false as const, entries: [] }, skills: resolveSkillSelection(defaultCapabilities.skills, []), pluginTools: [pluginToolId('example', 'echo')] }
    expect(intersectCapabilities(value, { ...value, pluginTools: [] }).pluginTools).toEqual([])
    expect(value.pluginTools).toEqual(['example:tool:echo'])
  })
})
