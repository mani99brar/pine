import { createAgentHandler } from '@pine/server/agent'

export const { GET, OPTIONS } = createAgentHandler({ appName: 'Pine Console' })
