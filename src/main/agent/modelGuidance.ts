import guidance from './modelGuidance.json'

/** Preserve the existing model-specific instructions without a framework profile registry.
 * Text from Deep Agents 1.13.0; copyright LangChain, Inc., MIT.
 * See data/licenses/deepagents/LICENSE and THIRD_PARTY_NOTICES.md. */
export function modelSystemGuidance(provider: 'anthropic' | 'openai', model: string): string | undefined {
  return guidance.find(group => group.models.includes(provider + ':' + model))?.text
}
