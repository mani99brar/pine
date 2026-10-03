/**
 * `@pine/react` for the static build: the real package, with one override.
 *
 * `useAccountData().exportData` navigates the window to `/api/account/export` so the browser downloads
 * the file. A static artifact has no such URL and cannot download, so the override builds the same JSON
 * in the page and copies it to the clipboard (falling back to a selectable text box).
 */
export * from '@pine-real/react'
export { useAccountData } from './account-data'
