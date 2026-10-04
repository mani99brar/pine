import { DEFAULT_ARTIFACT_MEDIA_TYPES, EVIDENCE_UPLOAD_MAX_BYTES } from '@pine/data'
import { mediaTypeOf } from '@pine/react'

// The evidence form's attachment rules: the files Pine accepts, and at most MAX_FILES of them.

export const MAX_FILES = 16

export function kib(n: number): string {
  return n >= 1024 ? `${Math.ceil(n / 1024)} KiB` : `${n} B`
}

export function fileProblem(f: File): string | null {
  // Pine refuses empty uploads, so an empty file committed now could never be revealed.
  if (f.size === 0) return 'the file is empty'
  if (f.size > EVIDENCE_UPLOAD_MAX_BYTES) return `larger than 256 KiB (${kib(f.size)})`
  const type = mediaTypeOf(f)
  if (!DEFAULT_ARTIFACT_MEDIA_TYPES.includes(type)) return type ? `${type} is not accepted` : 'unknown file type'
  return null
}

/** Adds picked files up to MAX_FILES; the rest are returned, so the form can name them rather than drop them silently. */
export function addAttachments(current: File[], picked: File[]): { files: File[]; notAdded: File[] } {
  const all = [...current, ...picked]
  return { files: all.slice(0, MAX_FILES), notAdded: all.slice(MAX_FILES) }
}
