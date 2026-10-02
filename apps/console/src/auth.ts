import { createAuth } from '@pine/server/auth'

export const { handlers, auth, signIn, signOut } = createAuth({ appName: 'Pine Console' })
