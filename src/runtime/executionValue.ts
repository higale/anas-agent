/** The execution store's value encoding. Every composite value has an explicit
 * container tag, so ordinary provider/tool JSON can never become a type marker.
 * This is separate from configuration files and from provider wire formats. */
type EncodedValue = null | boolean | string | number | unknown[]

function invalid(path: string, detail: string): never {
  throw new Error(`Invalid execution value at ${path}: ${detail}.`)
}

export function encodeExecutionValue(value: unknown): Uint8Array {
  const visiting = new WeakSet<object>()
  function encode(input: unknown, path: string): EncodedValue {
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input
    if (typeof input === 'number') {
      if (Object.is(input, -0)) return ['number', '-0']
      return Number.isFinite(input) ? input : ['number', String(input)]
    }
    if (input === undefined) return ['undefined']
    if (typeof input === 'bigint') return ['bigint', input.toString()]
    if (typeof input !== 'object') return invalid(path, `unsupported ${typeof input}`)
    if (visiting.has(input)) return invalid(path, 'circular reference')
    visiting.add(input)
    try {
      if (input instanceof Uint8Array) return ['bytes', Buffer.from(input).toString('base64')]
      if (input instanceof Date) return ['date', Number.isNaN(input.getTime()) ? null : input.toISOString()]
      if (input instanceof RegExp) return ['regexp', input.source, input.flags, encode(input.lastIndex, `${path}.lastIndex`)]
      if (input instanceof Map) return ['map', [...input].map(([key, item], index) => [
        encode(key, `${path}.key[${index}]`), encode(item, `${path}.value[${index}]`)
      ])]
      if (input instanceof Set) return ['set', [...input].map((item, index) => encode(item, `${path}[${index}]`))]
      if (Array.isArray(input)) return ['array', Array.from({ length: input.length }, (_, index) =>
        Object.hasOwn(input, index) ? encode(input[index], `${path}[${index}]`) : ['hole'])]
      if (input instanceof Error) {
        const properties = Object.getOwnPropertyNames(input).sort().map(key => {
          const descriptor = Object.getOwnPropertyDescriptor(input, key)!
          // V8 exposes a newly created Error's stack through a lazy accessor.
          if (!('value' in descriptor) && key !== 'stack') return invalid(`${path}.${key}`, 'accessor property')
          return [key, encode('value' in descriptor ? descriptor.value : input.stack, `${path}.${key}`), descriptor.enumerable === true]
        })
        return ['error', input.name, properties]
      }
      const prototype = Object.getPrototypeOf(input)
      if (prototype !== Object.prototype && prototype !== null) return invalid(path, 'unsupported object prototype')
      if (Object.getOwnPropertySymbols(input).some(symbol => Object.prototype.propertyIsEnumerable.call(input, symbol))) {
        return invalid(path, 'symbol property')
      }
      const properties = Object.keys(input).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!
        if (!('value' in descriptor)) return invalid(`${path}.${key}`, 'accessor property')
        return [key, encode(descriptor.value, `${path}.${key}`)]
      })
      return [prototype === null ? 'dictionary' : 'object', properties]
    } finally { visiting.delete(input) }
  }
  return new TextEncoder().encode(JSON.stringify({ version: 1, value: encode(value, '$') }))
}

export function decodeExecutionValue(bytes: Uint8Array): unknown {
  let envelope: unknown
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { return invalid('$', 'malformed UTF-8 or JSON') }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return invalid('$', 'missing envelope')
  const fields = envelope as Record<string, unknown>
  if (fields.version !== 1) return invalid('$', `unsupported version ${String(fields.version)}`)
  if (Object.keys(fields).length !== 2 || !Object.hasOwn(fields, 'value')) return invalid('$', 'malformed envelope')

  function properties(value: unknown, path: string, target: object, flags = false): object {
    if (!Array.isArray(value)) return invalid(path, 'expected property entries')
    const names = new Set<string>()
    for (const entry of value) {
      if (!Array.isArray(entry) || entry.length !== (flags ? 3 : 2) || flags && typeof entry[2] !== 'boolean'
        || typeof entry[0] !== 'string' || names.has(entry[0])) {
        return invalid(path, 'invalid or duplicate property')
      }
      names.add(entry[0])
      Object.defineProperty(target, entry[0], { value: decode(entry[1], `${path}.${entry[0]}`), enumerable: flags ? entry[2] : true, writable: true, configurable: true })
    }
    return target
  }

  function decode(input: unknown, path: string): unknown {
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (!Array.isArray(input) || typeof input[0] !== 'string') return invalid(path, 'expected a value tag')
    const [tag, value] = input
    if (tag === 'undefined' && input.length === 1) return undefined
    if (tag === 'number' && input.length === 2) {
      if (value === '-0') return -0
      if (value === 'NaN') return NaN
      if (value === 'Infinity') return Infinity
      if (value === '-Infinity') return -Infinity
    }
    if (tag === 'bigint' && input.length === 2 && typeof value === 'string' && /^(?:0|-?[1-9]\d*)$/u.test(value)) return BigInt(value)
    if (tag === 'bytes' && input.length === 2 && typeof value === 'string') {
      const result = Buffer.from(value, 'base64')
      if (result.toString('base64') !== value) return invalid(path, 'noncanonical binary data')
      return Uint8Array.from(result)
    }
    if (tag === 'date' && input.length === 2) {
      if (value === null) return new Date(NaN)
      if (typeof value === 'string') {
        const result = new Date(value)
        if (Number.isFinite(result.getTime()) && result.toISOString() === value) return result
      }
    }
    if (tag === 'regexp' && input.length === 4 && typeof value === 'string' && typeof input[2] === 'string') {
      try {
        const result = new RegExp(value, input[2])
        if (result.flags !== input[2]) return invalid(path, 'noncanonical regular expression flags')
        result.lastIndex = decode(input[3], `${path}.lastIndex`) as number
        return result
      } catch { return invalid(path, 'malformed regular expression') }
    }
    if (tag === 'array' && input.length === 2 && Array.isArray(value)) {
      const result = new Array(value.length)
      for (const [index, item] of value.entries()) {
        if (Array.isArray(item) && item.length === 1 && item[0] === 'hole') continue
        result[index] = decode(item, `${path}[${index}]`)
      }
      return result
    }
    if (tag === 'map' && input.length === 2 && Array.isArray(value)) {
      const result = new Map<unknown, unknown>()
      for (const [index, entry] of value.entries()) {
        if (!Array.isArray(entry) || entry.length !== 2) return invalid(path, 'malformed map entry')
        const key = decode(entry[0], `${path}.key[${index}]`)
        if (result.has(key)) return invalid(path, 'duplicate map key')
        result.set(key, decode(entry[1], `${path}.value[${index}]`))
      }
      return result
    }
    if (tag === 'set' && input.length === 2 && Array.isArray(value)) {
      const result = new Set<unknown>()
      for (const [index, item] of value.entries()) {
        const entry = decode(item, `${path}[${index}]`)
        if (result.has(entry)) return invalid(path, 'duplicate set value')
        result.add(entry)
      }
      return result
    }
    if ((tag === 'object' || tag === 'dictionary') && input.length === 2) {
      return properties(value, path, tag === 'dictionary' ? Object.create(null) : {})
    }
    if (tag === 'error' && input.length === 3 && typeof value === 'string') {
      const result = new Error()
      delete result.stack
      Object.defineProperty(result, 'name', { value, writable: true, configurable: true })
      return properties(input[2], path, result, true)
    }
    return invalid(path, `malformed or unknown ${tag} tag`)
  }
  return decode(fields.value, '$')
}
