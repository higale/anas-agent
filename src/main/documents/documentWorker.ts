import { stageDocument } from './convert'

const [source, stage, imageDirectory] = process.argv.slice(2)
stageDocument(source, stage, imageDirectory).then(
  result => process.send?.({ result }),
  error => process.send?.({ error: error instanceof Error ? error.message : String(error) })
)
