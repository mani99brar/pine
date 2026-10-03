/**
 * Next's segment boundaries for the static build: Prism's error.tsx, not-found.tsx and global-error.tsx,
 * plus `redirect()` handling.
 */
import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react'
import RouteError from '@/app/error'
import NotFound from '@/app/not-found'
import GlobalError from '@/app/global-error'
import { isNotFoundSignal, isRedirectSignal } from '../shims/next-navigation'
import { navigate, refresh } from '../router/router'

interface State {
  error: unknown
}

/** error.tsx + not-found.tsx for one route. Keyed by route, so navigating away clears it. */
export class RouteBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error }
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    if (isRedirectSignal(error)) queueMicrotask(() => navigate(error.href, { replace: true }))
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    if (isNotFoundSignal(error)) return <NotFound />
    if (isRedirectSignal(error)) return null
    const err = error instanceof Error ? error : new Error(String(error))
    return <RouteError error={err} reset={() => refresh()} />
  }
}

/** global-error.tsx: the root layout itself failed. Prism's component renders <html>/<body>; its body content is used. */
export class GlobalBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error }
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    const err = error instanceof Error ? error : new Error(String(error))
    const html = GlobalError({ error: err, reset: () => this.setState({ error: null }) }) as ReactElement<{ children: ReactElement<{ style?: React.CSSProperties; children: ReactNode }> }>
    const body = html.props.children
    return <div style={body.props.style}>{body.props.children}</div>
  }
}
