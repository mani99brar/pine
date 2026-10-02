import { llmsTxtHandler } from '@pine/server/agent'

export const dynamic = 'force-dynamic'
export const { GET } = llmsTxtHandler({ appName: 'Pine Docket' })
