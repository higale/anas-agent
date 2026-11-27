import english from 'emojibase-data/en/compact.json'
import chinese from 'emojibase-data/zh/compact.json'
import englishMessages from 'emojibase-data/en/messages.json'
import chineseMessages from 'emojibase-data/zh/messages.json'
import { Car, Flag, Hand, Heart, Lightbulb, PawPrint, Smile, Utensils, Volleyball } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ProjectIconGrid } from './ProjectIconGrid'
import { ProjectIcon } from './ProjectIcon'

const localized = new Map(chinese.flatMap(emoji => [emoji, ...emoji.skins ?? []]).map(emoji => [emoji.hexcode, emoji]))
const entries = english.filter(emoji => emoji.group !== undefined && emoji.group !== 2).flatMap(emoji =>
  [emoji, ...emoji.skins ?? []].map((item, index) => {
    const translation = localized.get(item.hexcode)
    return {
      value: item.unicode, group: emoji.group, variant: index > 0,
      en: item.label, zh: translation?.label ?? item.label,
      search: [item.unicode, item.label, translation?.label, ...emoji.tags ?? [], ...translation?.tags ?? []].join(' ').toLowerCase()
    }
  }))
const recommended = ['😄', '👍', '❤️', '🎉', '🚀', '👀', '🙏', '🔥']
const categoryIcons = [Smile, Hand, undefined, PawPrint, Utensils, Car, Volleyball, Lightbulb, Heart, Flag]

export default function ProjectEmojiPicker({ query, value, disabled, onChange }: {
  query: string
  value?: string
  disabled: boolean
  onChange(value: string): void
}) {
  const { t, i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const groups = (zh ? chineseMessages : englishMessages).groups.filter(group => group.order !== 2)
  const [category, setCategory] = useState(() => entries.find(item => item.value === value)?.group ?? 0)
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const options = (items: typeof entries) => items.map(item => ({ value: item.value,
    label: `${item.value} ${zh ? item.zh : item.en}`, content: <ProjectIcon emoji={item.value} size={23} /> }))
  const results = entries.filter(item => terms.length ? terms.every(term => item.search.includes(term))
    : (!item.variant || item.value === value) && item.group === category)
  return <>
    {!terms.length && <div className="project-emoji-categories" role="group" aria-label={t('project.emoji_categories')}>
      {groups.map(group => {
        const Icon = categoryIcons[group.order]!
        return <button key={group.key} type="button" className="ui-tool-button" aria-label={group.message}
          title={group.message} aria-pressed={category === group.order} disabled={disabled}
          onClick={() => setCategory(group.order)}><Icon size={16} /></button>
      })}
    </div>}
    <div className="project-appearance-results" key={`${category}:${query}`}>
      {!terms.length && category === 0 && <section className="project-emoji-section">
        <h3>{t('project.emoji_recommended')}</h3>
        <ProjectIconGrid label={t('project.emoji_recommended')} value={value} disabled={disabled} onChange={onChange}
          options={options(recommended.flatMap(value => entries.find(item => item.value === value) ?? []))} />
      </section>}
      <section className="project-emoji-section">
        <h3>{terms.length ? t('project.emoji_search_results') : groups.find(group => group.order === category)?.message}</h3>
        <ProjectIconGrid label={t('project.emoji')} value={value} disabled={disabled} onChange={onChange} options={options(results)} />
        {!results.length && <p className="project-appearance-empty" role="status">{t('project.emoji_no_results')}</p>}
      </section>
    </div>
  </>
}
