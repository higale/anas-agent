const { setTimeout: delay } = require('node:timers/promises')
module.exports = {
  tools: {
    async echo(params, { host }) {
      const settings = await host.getSettings()
      const text = settings.prefix + (settings.uppercase ? params.text.toUpperCase() : params.text)
      return { text: Array.from({ length: Math.floor(settings.repeat) }, () => text).join(settings.separator === 'newline' ? '\n' : ' ') }
    },
    image() {
      return [{ type: 'text', text: 'A one-pixel PNG.' }, { type: 'image', mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }]
    },
    async wait(params, { signal }) {
      await delay(params.seconds * 1000, undefined, { signal })
      return `Waited ${params.seconds} seconds.`
    }
  }
}
