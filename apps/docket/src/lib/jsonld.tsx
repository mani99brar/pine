/** Serialize JSON-LD we build ourselves; `<` is escaped so no string can close the script tag. */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  // Our own data with `<` escaped (design spec §8): the only dangerouslySetInnerHTML in the app.
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />
}
