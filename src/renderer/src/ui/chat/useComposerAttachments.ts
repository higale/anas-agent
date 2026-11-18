import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, DragEvent, RefObject, SetStateAction } from 'react'
import type { TFunction } from 'i18next'
import type { SelectedAttachment } from '@shared/types'
import { dataTransferHasFiles } from '../dragDrop'
import { notice } from '../notice'

interface UseComposerAttachmentsOptions {
  attachments: SelectedAttachment[]
  draftKey: string
  projectId: string
  inputRef: RefObject<HTMLTextAreaElement | null>
  setInput: Dispatch<SetStateAction<string>>
  setAttachments: Dispatch<SetStateAction<SelectedAttachment[]>>
  t: TFunction
  visionEnabled: boolean
}

function appendUniqueAttachments(current: SelectedAttachment[], files: SelectedAttachment[]): SelectedAttachment[] {
  const seenPaths = new Set(current.map((file) => file.path))
  const additions = files.filter((file) => {
    if (seenPaths.has(file.path)) return false
    seenPaths.add(file.path)
    return true
  })
  return additions.length > 0 ? [...current, ...additions] : current
}

export function releaseTemporaryAttachments(files: SelectedAttachment[]): void {
  const paths = files
    .filter((file) => file.temporary)
    .map((file) => file.path)
  if (paths.length > 0) {
    void window.gale.files.releaseTemporaryAttachments(paths)
  }
}

export function useComposerAttachments({
  attachments,
  draftKey,
  projectId,
  inputRef,
  setInput,
  setAttachments,
  t,
  visionEnabled
}: UseComposerAttachmentsOptions) {
  const [composerDragActive, setComposerDragActive] = useState(false)
  const composerDragDepthRef = useRef(0)
  const activeDraftRef = useRef<string | undefined>(draftKey)
  const conversionsRef = useRef(new Set<string>())
  const [convertingKeys, setConvertingKeys] = useState(new Set<string>())

  useEffect(() => {
    activeDraftRef.current = draftKey
    composerDragDepthRef.current = 0
    setComposerDragActive(false)
    return () => { activeDraftRef.current = undefined }
  }, [draftKey])

  const appendPaths = useCallback((paths: string[]): void => {
    if (paths.length === 0) return
    setInput(current => `${current}${current && !current.endsWith('\n') ? '\n' : ''}${paths.join('\n')}`)
    window.requestAnimationFrame(() => {
      if (activeDraftRef.current !== draftKey) return
      const input = inputRef.current
      input?.focus()
      input?.setSelectionRange(input.value.length, input.value.length)
    })
  }, [draftKey, inputRef, setInput])

  const acceptFiles = useCallback((files: SelectedAttachment[]): void => {
    const pathOnly = files.filter(file => file.kind === 'binary' && !file.skippedReason)
    const rejected = files.filter(file => file.kind === 'image' && !visionEnabled)
    const accepted = files.filter(file => !pathOnly.includes(file) && !rejected.includes(file))
    releaseTemporaryAttachments(rejected)
    if (rejected.length > 0) notice.warning(t('chat.vision_unsupported_attach'))
    setAttachments(current => appendUniqueAttachments(current, accepted))
    appendPaths(pathOnly.map(file => file.path))
  }, [appendPaths, setAttachments, t, visionEnabled])

  const clearAttachments = useCallback((): void => {
    releaseTemporaryAttachments(attachments)
    setAttachments([])
    composerDragDepthRef.current = 0
    setComposerDragActive(false)
  }, [attachments, setAttachments])

  const restoreAttachments = useCallback((files: SelectedAttachment[]): void => {
    releaseTemporaryAttachments(attachments)
    setAttachments(files)
    composerDragDepthRef.current = 0
    setComposerDragActive(false)
  }, [attachments, setAttachments])

  const attachTextFiles = useCallback(async (): Promise<void> => {
    try {
      const files = await window.gale.files.openText()
      if (files.length === 0) return
      acceptFiles(files)
    } catch {
      notice.error(t('chat.failed_attach_file'))
    }
  }, [acceptFiles, t])

  const handleComposerDragEnter = useCallback((event: DragEvent<HTMLFormElement>): void => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    composerDragDepthRef.current += 1
    setComposerDragActive(true)
  }, [])

  const handleComposerDragOver = useCallback((event: DragEvent<HTMLFormElement>): void => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setComposerDragActive(true)
  }, [])

  const handleComposerDragLeave = useCallback((event: DragEvent<HTMLFormElement>): void => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1)
    if (composerDragDepthRef.current === 0) setComposerDragActive(false)
  }, [])

  const handleComposerDrop = useCallback(async (event: DragEvent<HTMLFormElement>): Promise<void> => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    composerDragDepthRef.current = 0
    setComposerDragActive(false)
    const droppedFiles = Array.from(event.dataTransfer.files)
    if (droppedFiles.length === 0) return
    try {
      const files = await window.gale.files.fromDroppedFiles(droppedFiles)
      if (files.length === 0) {
        notice.warning(t('chat.unsupported_dropped_file'))
        return
      }
      acceptFiles(files)
    } catch {
      notice.error(t('chat.failed_attach_file'))
    }
  }, [acceptFiles, t])

  const convertAttachmentToPath = useCallback(async (path: string): Promise<void> => {
    const file = attachments.find(file => file.path === path)
    const key = `${draftKey}\n${path}`
    if (!file || conversionsRef.current.has(key)) return
    conversionsRef.current.add(key)
    setConvertingKeys(new Set(conversionsRef.current))
    try {
      const retainedPath = file.temporary
        ? await window.gale.files.retainTemporaryAttachment(file.path, projectId)
        : file.path
      appendPaths([retainedPath])
      setAttachments(current => current.filter(item => item.path !== path))
      releaseTemporaryAttachments([file])
    } catch {
      notice.error(t('chat.failed_convert_attachment_to_path'))
    } finally {
      conversionsRef.current.delete(key)
      setConvertingKeys(new Set(conversionsRef.current))
    }
  }, [appendPaths, attachments, draftKey, projectId, setAttachments, t])

  const removeAttachment = useCallback((path: string): void => {
    const removed = attachments.find((file) => file.path === path)
    if (removed) releaseTemporaryAttachments([removed])
    setAttachments((current) => current.filter((file) => file.path !== path))
  }, [attachments, setAttachments])

  const toggleAttachmentContextPolicy = useCallback((path: string): void => {
    setAttachments((current) => current.map((file) =>
      file.path === path
        ? {
            ...file,
            contextPolicy: file.contextPolicy === 'conversation'
              ? 'one_turn'
              : 'conversation'
          }
        : file
    ))
  }, [setAttachments])

  return {
    attachTextFiles,
    attachments,
    clearAttachments,
    composerDragActive,
    convertAttachmentToPath,
    attachmentConversionBusy: [...convertingKeys].some(key => key.startsWith(`${draftKey}\n`)),
    handleComposerDragEnter,
    handleComposerDragLeave,
    handleComposerDragOver,
    handleComposerDrop,
    removeAttachment,
    restoreAttachments,
    toggleAttachmentContextPolicy
  }
}
