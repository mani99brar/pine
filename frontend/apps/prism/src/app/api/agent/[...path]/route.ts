import { createAgentHandler } from '@pine/server/agent'

export const dynamic = 'force-dynamic'
export const { GET, OPTIONS } = createAgentHandler({ appName: 'Pine Prism' })
