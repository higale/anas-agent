import { parse as parseYaml } from 'yaml'
import type { SkillLoadIssue } from '@shared/types'

interface ParsedSkill { name: string; description: string; compatibility?: string; body: string }
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function inspectSkillText(content: string, expectedName: string): ParsedSkill | SkillLoadIssue {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return { code: 'missing_frontmatter' }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return { code: 'missing_frontmatter', detail: 'The closing front matter delimiter is missing.' }
  let frontmatter: unknown
  try {
    frontmatter = parseYaml(lines.slice(1, end).join('\n'))
  } catch (reason) {
    return { code: 'yaml_parse_failed', detail: reason instanceof Error ? reason.message : String(reason) }
  }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) return { code: 'missing_frontmatter' }
  const raw = frontmatter as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  if (!name) return { code: 'missing_name' }
  if (!skillNamePattern.test(name) || name.length > 64) return { code: 'invalid_name', name }
  if (name !== expectedName) return { code: 'name_mismatch', name, expected: expectedName }
  if (!description) return { code: 'missing_description' }
  if (description.length > 1024) return { code: 'description_too_long' }
  const compatibility = raw.compatibility
  if (compatibility !== undefined && (typeof compatibility !== 'string' || !compatibility.trim() || compatibility.length > 500)) {
    return { code: 'invalid_frontmatter_field', name: 'compatibility' }
  }
  return {
    name,
    description,
    ...(typeof compatibility === 'string' ? { compatibility: compatibility.trim() } : {}),
    body: lines.slice(end + 1).join('\n').replace(/^\n+|\n+$/g, '')
  }
}
