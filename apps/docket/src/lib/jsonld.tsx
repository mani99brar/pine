/** Serialize JSON-LD we build ourselves; `<` is escaped so no string can close the script tag. */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  // eslint-disable-next-line react/no-danger -- our own data, `<` escaped (see design spec §8)
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />
}
