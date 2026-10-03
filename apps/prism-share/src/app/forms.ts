/**
 * Form submission inside a sandboxed frame.
 *
 * Artifact frames may be sandboxed without `allow-forms`. The browser then blocks the form submission
 * algorithm before the `submit` event fires, so React `onSubmit` handlers (evidence form, composer source
 * input, light-table search, spending limit) would never run. Every Prism form handles submission in JS
 * and calls preventDefault, so the native submission is never wanted: this handler cancels it and
 * dispatches the `submit` event itself, after the same constraint validation the browser would run.
 */

const IMPLICIT_SUBMIT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week'])

function submitButtons(form: HTMLFormElement): (HTMLButtonElement | HTMLInputElement)[] {
  return Array.from(form.elements).filter(
    (el): el is HTMLButtonElement | HTMLInputElement =>
      (el instanceof HTMLButtonElement && el.type === 'submit') || (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'image')),
  )
}

function dispatchSubmit(form: HTMLFormElement, submitter: HTMLElement | null): void {
  const skipValidation = form.noValidate || (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter.formNoValidate : false)
  if (!skipValidation && !form.checkValidity()) {
    form.reportValidity()
    return
  }
  let event: Event
  try {
    event = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter })
  } catch {
    event = new Event('submit', { bubbles: true, cancelable: true })
  }
  form.dispatchEvent(event)
}

export function installFormSubmit(): void {
  // Submit buttons (also reached by implicit submission, which "clicks" the default button).
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented) return
    const target = e.target as Element | null
    const btn = target?.closest?.('button, input[type="submit"], input[type="image"]') as HTMLButtonElement | HTMLInputElement | null
    if (!btn || btn.disabled) return
    if (btn instanceof HTMLButtonElement && btn.type !== 'submit') return
    const form = btn.form
    if (!form) return
    e.preventDefault()
    dispatchSubmit(form, btn)
  })

  // Enter in a single-line field of a form without a submit button (implicit submission without a button).
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.key !== 'Enter' || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const el = e.target
    if (!(el instanceof HTMLInputElement) || !IMPLICIT_SUBMIT_TYPES.has(el.type)) return
    const form = el.form
    if (!form || submitButtons(form).length > 0) return
    e.preventDefault()
    dispatchSubmit(form, null)
  })
}
