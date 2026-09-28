import { runJsonMigrations, type JsonMigration } from './framework'

// Build-time discovery keeps individual upgrade modules removable. Business modules never import them.
const upgrades = import.meta.glob<(root: string) => JsonMigration>('./upgrades/*.ts', { eager: true, import: 'default' })

/** Run before business reads at startup, or on the staged directory before restore validation. */
export async function migrateDataDirectory(root: string): Promise<void> {
  await runJsonMigrations(Object.keys(upgrades).sort().map(key => upgrades[key](root)))
}
