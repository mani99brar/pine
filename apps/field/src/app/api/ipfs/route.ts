import { auth } from '@/auth'
import { createIpfsHandler } from '@pine/server/ipfs'

export const { POST } = createIpfsHandler({ auth })
