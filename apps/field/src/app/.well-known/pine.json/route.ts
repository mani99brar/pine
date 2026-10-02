import { wellKnownHandler } from '@pine/server/agent'

export const dynamic = 'force-dynamic'
export const { GET } = wellKnownHandler({ appName: 'Pine Field' })
