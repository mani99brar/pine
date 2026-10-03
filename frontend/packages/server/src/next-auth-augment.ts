/**
 * Module augmentation so apps get typed `session.user.login`, `scopes`, `demo`…
 * Imported by `@pine/server/auth`; any app importing createAuth picks it up.
 */
import type { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    user: {
      login: string
      githubId: number
      avatarUrl: string
      htmlUrl: string
      scopes: string[]
      demo: boolean
      provider: 'github' | 'demo'
    } & DefaultSession['user']
  }
}

export {}
