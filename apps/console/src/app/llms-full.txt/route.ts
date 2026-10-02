import { llmsFullTxtHandler } from '@pine/server/agent'

export const dynamic = 'force-dynamic'
export const { GET } = llmsFullTxtHandler({ appName: 'Pine Console' })
