/** Release a provider's HTTP response on completion, cancellation or early return. */
export async function *consumeProviderStream<T>(
  stream: AsyncIterable<T> & { controller: AbortController },
  signal?: AbortSignal | null
): AsyncGenerator<T> {
  try {
    signal?.throwIfAborted()
    for await (const event of stream) {
      signal?.throwIfAborted()
      yield event
    }
    signal?.throwIfAborted()
  } finally {
    stream.controller.abort()
  }
}
