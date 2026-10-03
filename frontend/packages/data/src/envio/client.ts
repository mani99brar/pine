import { PineDataError } from '../types'

export interface GraphQLResponse<T> {
  data?: T | null
  errors?: { message: string; extensions?: Record<string, unknown> }[]
}

/** POST a GraphQL query to an Envio HyperIndex (Hasura) endpoint. */
export async function envioQuery<T>(
  url: string,
  query: string,
  variables: Record<string, unknown> = {},
  fetcher: typeof fetch = (...args) => fetch(...args),
): Promise<T> {
  let res: Response
  try {
    res = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
  } catch (err) {
    throw new PineDataError('Could not reach the Envio indexer', 'network', err)
  }
  if (res.status === 429) throw new PineDataError('Envio indexer rate limit reached; retry shortly', 'rate_limited', { status: 429 })
  if (res.status === 401 || res.status === 403) throw new PineDataError('Envio indexer refused the request', 'unauthorized', { status: res.status })
  if (!res.ok) throw new PineDataError(`Envio indexer error ${res.status}`, res.status >= 500 ? 'network' : 'bad_response', { status: res.status })
  let body: GraphQLResponse<T>
  try {
    body = (await res.json()) as GraphQLResponse<T>
  } catch (err) {
    throw new PineDataError('Envio indexer returned invalid JSON', 'bad_response', err)
  }
  if (body.errors && body.errors.length > 0) {
    throw new PineDataError(`Envio GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`, 'bad_response', body.errors)
  }
  if (!body.data) throw new PineDataError('Envio indexer returned no data', 'bad_response')
  return body.data
}
