// Focus follows an identity change on the account page: the control that started it (sign in, sign out, unlink)
// unmounts with the old view, so the new view's heading takes focus once.

let pending: 'signed-in' | 'signed-out' | null = null

export function focusAfter(view: 'signed-in' | 'signed-out'): void {
  pending = view
}

/** True once for the view that should take focus. */
export function takeFocus(view: 'signed-in' | 'signed-out'): boolean {
  if (pending !== view) return false
  pending = null
  return true
}
