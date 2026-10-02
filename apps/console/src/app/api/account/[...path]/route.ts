import { auth } from '@/auth'
import { createAccountHandler } from '@pine/server/siwe'

export const { GET, POST, PATCH, DELETE } = createAccountHandler(auth)
