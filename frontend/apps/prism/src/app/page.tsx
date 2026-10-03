import { Hero } from '@/components/landing/Hero'
import { Story } from '@/components/landing/Story'
import { Endings, ForAgents, NotThis, TablePreview } from '@/components/landing/Sections'
import { siteUrl } from '@/lib/site'

export default function Home() {
  return (
    <>
      <Hero />
      <Story />
      <TablePreview />
      <Endings />
      <ForAgents siteUrl={siteUrl()} />
      <NotThis />
    </>
  )
}
