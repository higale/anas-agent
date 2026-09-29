import { describe, expect, it } from 'vitest'
import { validateCustomToolSchema } from '@shared/customTools'
import { canEditParameter, changeParameter, removeParameter, replaceSchema, schemaAt } from './toolParameterSchema'

describe('custom tool parameter changes', () => {
  it('preserves independent required names when adding or renaming a definition', () => {
    const root = { type: 'object', properties: { old: { type: 'string' } }, required: ['token', 'other'] }
    const added = changeParameter(root, [], undefined, 'token', { type: 'string' }, undefined)
    expect(added.required).toEqual(['other', 'token'])
    const renamed = changeParameter(root, [], 'old', 'token', { type: 'string' }, undefined)
    expect(renamed.required).toEqual(['other', 'token'])
    expect(validateCustomToolSchema(renamed)).toEqual(renamed)
    const explicitlyOptional = changeParameter(root, [], undefined, 'token', { type: 'string' }, false)
    expect(explicitlyOptional.required).toEqual(['other'])
    expect(root.required).toEqual(['token', 'other'])
  })
  it('retains inherited requirements inside array items independently of the root', () => {
    const root = { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', required: ['id'] } } }, required: ['rows'] }
    const path = ['properties', 'rows', 'items']
    const next = changeParameter(root, path, undefined, 'id', { type: 'integer' }, undefined)
    expect(next.required).toEqual(['rows'])
    expect(schemaAt(next, path)).toEqual({ type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] })
  })
  it('renames and removes required/dependent names while preserving unrelated schema content', () => {
    const root = { type: 'object', properties: { title: { type: 'string', examples: ['a'], 'x-display': { color: 'blue' } }, note: { type: 'string' } },
      required: ['title', 'note'], dependentRequired: { title: ['note'], note: ['title'] },
      additionalProperties: { type: 'number' }, $defs: { unused: { type: 'boolean' } }, 'x-root': true }
    const original = structuredClone(root)
    const renamed = changeParameter(root, [], 'title', 'heading', root.properties.title, true)
    expect(renamed).toEqual({ ...root, properties: { heading: root.properties.title, note: root.properties.note }, required: ['note', 'heading'], dependentRequired: { heading: ['note'], note: ['heading'] } })
    expect(removeParameter(renamed, [], 'heading')).toEqual({ ...root, properties: { note: root.properties.note }, required: ['note'], dependentRequired: { note: [] } })
    expect(root).toEqual(original)
    expect(validateCustomToolSchema(renamed)).toEqual(renamed)
  })
  it('edits nested array-object properties and creates previously unconstrained items', () => {
    const root = { type: 'object', properties: { rows: { type: 'array', minItems: 1 } }, additionalProperties: false }
    const path = ['properties', 'rows', 'items']
    const withItems = replaceSchema(root, path, { type: 'object', additionalProperties: false })
    const added = changeParameter(withItems, path, undefined, 'id', { type: 'integer', minimum: 1 }, true)
    expect(schemaAt(added, path)).toEqual({ type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'], additionalProperties: false })
    expect(schemaAt(added, ['properties', 'rows', 'minItems'])).toBe(1)
    expect(validateCustomToolSchema(added)).toEqual(added)
    expect(schemaAt(removeParameter(added, path, 'id'), path)).toMatchObject({ properties: {}, required: [] })
  })
  it('rejects duplicate, blank and missing names without touching the original', () => {
    const root = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } }
    expect(() => changeParameter(root, [], 'a', 'b', {}, false)).toThrow('parameter_name_duplicate')
    expect(() => changeParameter(root, [], undefined, ' ', {}, false)).toThrow('parameter_name_empty')
    expect(() => changeParameter(root, [], 'missing', 'c', {}, false)).toThrow('parameter_missing')
    expect(() => removeParameter(root, [], 'missing')).toThrow('parameter_missing')
    expect(Object.keys(root.properties)).toEqual(['a', 'b'])
  })
  it('treats prototype-like property names as ordinary own keys', () => {
    const root = { type: 'object', properties: {} }
    const added = changeParameter(root, [], undefined, '__proto__', { type: 'string' }, true)
    expect(schemaAt(added, ['properties', '__proto__'])).toEqual({ type: 'string' })
    const renamed = changeParameter(added, [], '__proto__', 'constructor', { type: 'boolean' }, false)
    expect(schemaAt(renamed, ['properties', 'constructor'])).toEqual({ type: 'boolean' })
    expect(Object.getPrototypeOf(renamed.properties)).toBe(Object.prototype)
    expect(validateCustomToolSchema(renamed)).toEqual(renamed)
  })
  it.each(['#/properties/a~1b~0c', '#/properties/a~1b~0c/minLength', '#/properties/a%20b'])('protects local reference targets: %s', ref => {
    const name = ref.includes('%20') ? 'a b' : 'a/b~c'
    const root = { type: 'object', properties: { [name]: { type: 'string', minLength: 1 }, mirror: { $ref: ref } } }
    expect(() => changeParameter(root, [], name, 'renamed', { type: 'string' }, false)).toThrow('parameter_references')
    expect(() => removeParameter(root, [], name)).toThrow('parameter_references')
  })
  it('keeps advanced sibling definitions intact and allows safe ordinary edits', () => {
    const root = { type: 'object', properties: { title: { type: 'string' }, advanced: { anyOf: [{ type: 'string' }, { type: 'number' }] } } }
    const next = changeParameter(root, [], 'title', 'name', { type: 'string', description: 'Name' }, false)
    expect(schemaAt(next, ['properties', 'advanced'])).toEqual(root.properties.advanced)
    expect(canEditParameter(root.properties.advanced)).toBe(false)
    expect(canEditParameter({ type: ['string', 'null'] })).toBe(false)
    expect(canEditParameter({ type: 'array', items: [{ type: 'string' }] })).toBe(false)
  })
  it('requires source edits for renames governed by ancestor conditions', () => {
    const root = { type: 'object', properties: { child: { type: 'object', properties: { a: { type: 'string' } } } },
      if: { properties: { child: { required: ['a'] } } }, then: { required: ['child'] } }
    expect(() => removeParameter(root, ['properties', 'child'], 'a')).toThrow('parameter_references')
    expect(() => changeParameter(root, ['properties', 'child'], 'a', 'a', { type: 'string', description: 'Updated' }, false)).not.toThrow()
  })
  it('does not overwrite independent dependencies when renaming to an undeclared property name', () => {
    const root = { type: 'object', properties: { a: { type: 'string' } }, dependentRequired: { a: ['x'], b: ['y'] } }
    expect(() => changeParameter(root, [], 'a', 'b', { type: 'string' }, false)).toThrow('parameter_references')
    expect(root.dependentRequired).toEqual({ a: ['x'], b: ['y'] })
  })
})
