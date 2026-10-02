import { auth } from '@/auth'
import { createGitHubHandler } from '@pine/server/github'

export const { GET } = createGitHubHandler(auth)
