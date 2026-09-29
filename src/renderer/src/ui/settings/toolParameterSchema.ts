export type SchemaObject = Record<string, unknown>
export type SchemaPath = string[]
export const parameterTypes = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'] as const
export const isSchemaObject = (value: unknown): value is SchemaObject => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const complexKeywords = ['$ref', '$dynamicRef', '$recursiveRef', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else']

export function parameterType(value: unknown): string {
  if (!isSchemaObject(value)) return 'advanced'
  return typeof value.type === 'string' && parameterTypes.some(type => type === value.type) ? value.type : 'advanced'
}

export function canEditParameter(value: unknown): value is SchemaObject {
  return isSchemaObject(value) && !complexKeywords.some(key => key in value)
    && (parameterType(value) !== 'advanced' || Object.keys(value).length === 0)
    && !Array.isArray(value.items)
}

export function schemaAt(root: SchemaObject, path: SchemaPath): unknown {
  let value: unknown = root
  for (const key of path) {
    if (!isSchemaObject(value) || !Object.hasOwn(value, key)) throw new Error('custom_tools.parameter_missing')
    value = value[key]
  }
  return value
}

export function replaceSchema(root: SchemaObject, path: SchemaPath, value: unknown): SchemaObject {
  if (!path.length) {
    if (!isSchemaObject(value)) throw new Error('custom_tools.parameter_invalid_root')
    return value
  }
  const [key, ...rest] = path
  const child = root[key]
  if (!Object.hasOwn(root, key) || !isSchemaObject(child)) {
    if (rest.length) throw new Error('custom_tools.parameter_missing')
    return { ...root, [key]: value }
  }
  return { ...root, [key]: replaceSchema(child, rest, value) }
}

function assertRenameOrDelete(root: SchemaObject, parentPath: SchemaPath, name: string): void {
  for (let length = 0; length <= parentPath.length; length += parentPath[length] === 'properties' ? 2 : 1) {
    const ancestor = schemaAt(root, parentPath.slice(0, length))
    if (isSchemaObject(ancestor) && [...complexKeywords, 'dependentSchemas', 'dependencies', 'propertyNames', 'patternProperties'].some(key => key in ancestor)) {
      throw new Error('custom_tools.parameter_references')
    }
  }
  const target = '#/' + [...parentPath, 'properties', name].map(key => key.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!isSchemaObject(value)) return
    for (const [key, child] of Object.entries(value)) {
      if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key) && typeof child === 'string') {
        let ref = child
        try { ref = decodeURIComponent(ref) } catch { /* The schema validator reports malformed references. */ }
        if (ref === target || ref.startsWith(`${target}/`)) throw new Error('custom_tools.parameter_references')
      }
      visit(child)
    }
  }
  visit(root)
}

/** Change only the selected property and its sibling name references; retain every other keyword. */
export function changeParameter(root: SchemaObject, parentPath: SchemaPath, oldName: string | undefined,
  name: string, value: unknown, required: boolean | undefined): SchemaObject {
  if (!name.trim()) throw new Error('custom_tools.parameter_name_empty')
  const parent = schemaAt(root, parentPath)
  if (!isSchemaObject(parent)) throw new Error('custom_tools.parameter_missing')
  const properties = isSchemaObject(parent.properties) ? parent.properties : {}
  if (oldName !== undefined && !Object.hasOwn(properties, oldName)) throw new Error('custom_tools.parameter_missing')
  if (name !== oldName && Object.hasOwn(properties, name)) throw new Error('custom_tools.parameter_name_duplicate')
  if (oldName !== undefined && name !== oldName) assertRenameOrDelete(root, parentPath, oldName)
  const entries = Object.entries(properties).map(([key, child]) => key === oldName ? [name, value] : [key, child])
  if (oldName === undefined) entries.push([name, value])
  const next: SchemaObject = { ...parent, properties: Object.fromEntries(entries) }
  const previousRequired = Array.isArray(parent.required) ? parent.required : []
  // An untouched checkbox preserves requirements for both the old and target names.
  const isRequired = required ?? (previousRequired.includes(oldName) || previousRequired.includes(name))
  const requiredNames = previousRequired.filter(key => key !== oldName && key !== name)
  if (isRequired) requiredNames.push(name)
  if (parent.required !== undefined || requiredNames.length) next.required = requiredNames
  if (oldName !== undefined && oldName !== name && isSchemaObject(parent.dependentRequired)) {
    // A dependency may already use the new name even when no property defines it.
    // Keep that independent constraint rather than overwriting it during a rename.
    if (Object.hasOwn(parent.dependentRequired, oldName) && Object.hasOwn(parent.dependentRequired, name)) {
      throw new Error('custom_tools.parameter_references')
    }
    next.dependentRequired = Object.fromEntries(Object.entries(parent.dependentRequired).map(([key, names]) => [key === oldName ? name : key,
      Array.isArray(names) ? names.map(item => item === oldName ? name : item) : names]))
  }
  return replaceSchema(root, parentPath, next)
}

export function removeParameter(root: SchemaObject, parentPath: SchemaPath, name: string): SchemaObject {
  assertRenameOrDelete(root, parentPath, name)
  const parent = schemaAt(root, parentPath)
  if (!isSchemaObject(parent) || !isSchemaObject(parent.properties) || !Object.hasOwn(parent.properties, name)) throw new Error('custom_tools.parameter_missing')
  const next: SchemaObject = { ...parent, properties: Object.fromEntries(Object.entries(parent.properties).filter(([key]) => key !== name)) }
  if (Array.isArray(parent.required)) next.required = parent.required.filter(key => key !== name)
  if (isSchemaObject(parent.dependentRequired)) {
    next.dependentRequired = Object.fromEntries(Object.entries(parent.dependentRequired).filter(([key]) => key !== name)
      .map(([key, names]) => [key, Array.isArray(names) ? names.filter(item => item !== name) : names]))
  }
  return replaceSchema(root, parentPath, next)
}
