/**
 * The evidence form's attachment rules (Prism has no unit test runner of its own, so they are checked here, against
 * the same @pine/data limits the form uses).
 */
import { describe, expect, it } from 'vitest'
import { addAttachments, fileProblem, MAX_FILES } from '../../../apps/prism/src/app/claims/[id]/evidence/attachments'

const txt = (name: string, body = 'x') => new File([body], name, { type: 'text/plain' })

describe('evidence form attachments', () => {
  it('SEC-EVID-01 refuses an empty (0-byte) file as it refuses oversized or unaccepted ones', () => {
    expect(fileProblem(txt('empty.txt', ''))).toMatch(/empty/)
    expect(fileProblem(new File([new Uint8Array(262_145)], 'big.zip', { type: 'application/zip' }))).toMatch(/larger than 256 KiB/)
    expect(fileProblem(new File(['<p>'], 'x.html', { type: 'text/html' }))).toMatch(/not accepted/)
    expect(fileProblem(txt('ok.txt'))).toBeNull()
  })

  it('keeps at most 16 files and names the ones it did not add', () => {
    const current = [txt('a.txt'), txt('b.txt')]
    const picked = Array.from({ length: 20 }, (_, i) => txt(`f${i}.txt`))
    const { files, notAdded } = addAttachments(current, picked)
    expect(files).toHaveLength(MAX_FILES)
    expect(files.map((f) => f.name)).toEqual(['a.txt', 'b.txt', ...picked.slice(0, 14).map((f) => f.name)])
    expect(notAdded.map((f) => f.name)).toEqual(['f14.txt', 'f15.txt', 'f16.txt', 'f17.txt', 'f18.txt', 'f19.txt'])
    expect(addAttachments([], [txt('one.txt')]).notAdded).toEqual([])
  })
})
