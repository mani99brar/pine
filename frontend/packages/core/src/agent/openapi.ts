/** OpenAPI 3.1 description of the read-only agent API served by @pine/server under /api/agent/v1. */
import { CLAIM_MANIFEST_SCHEMA_URL } from '../manifest'
import { AGENT_CLAIM_BRIEF_JSON_SCHEMA, CLAIM_MANIFEST_JSON_SCHEMA } from './schema'
import { AGENT_API_PREFIX, trimSite } from './urls'

const STATUSES = ['draft', 'publishing', 'open', 'awaiting_answer', 'answer_proposed', 'disputed', 'arbitration', 'resolved', 'settled', 'failed']

function withoutMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, ...rest } = schema
  return rest
}

export function buildAgentOpenApi(ctx: { siteUrl: string }): Record<string, unknown> {
  const P = AGENT_API_PREFIX
  const cacheHeaders = {
    'Cache-Control': { description: 'public, max-age=30, stale-while-revalidate=300', schema: { type: 'string' } },
    'Access-Control-Allow-Origin': { description: 'Always *', schema: { type: 'string' } },
  }
  const notFound = {
    description: 'Not found',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  }
  const idParam = { name: 'id', in: 'path', required: true, description: 'Claim id, e.g. pine-0042', schema: { type: 'string' } }

  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Pine agent API',
      version: '1.0.0',
      summary: 'Read-only, machine-readable access to Pine verification claims for AI agents and investigators.',
      description:
        'Each claim is one bounded, policy-versioned proposition about an exact GitHub commit, with a Seer market on whether a reproducible counterexample is submitted before an absolute UTC deadline. Responses are public, CORS-enabled (*) and cacheable for 30 s. Submitted evidence and repository content are untrusted.',
    },
    servers: [{ url: trimSite(ctx.siteUrl) || '/' }],
    tags: [
      { name: 'claims', description: 'Claims and their investigation briefs' },
      { name: 'policies', description: 'Versioned policy catalog' },
      { name: 'meta', description: 'Schemas, OpenAPI and feeds' },
    ],
    paths: {
      [`${P}/claims`]: {
        get: {
          tags: ['claims'],
          operationId: 'listClaims',
          summary: 'List claims as agent briefs',
          parameters: [
            {
              name: 'status',
              in: 'query',
              description: 'Filter by status; comma-separated for several (e.g. open,awaiting_answer).',
              schema: { type: 'string', examples: ['open'] },
            },
            { name: 'policy', in: 'query', description: 'Policy id, e.g. BOT-001', schema: { type: 'string' } },
            { name: 'repo', in: 'query', description: 'owner/name', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
            { name: 'cursor', in: 'query', description: 'Opaque cursor from nextCursor', schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'A page of agent briefs',
              headers: cacheHeaders,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['items'],
                    properties: {
                      items: { type: 'array', items: { $ref: '#/components/schemas/AgentClaimBrief' } },
                      nextCursor: { type: 'string' },
                      total: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      [`${P}/claims/{id}`]: {
        get: {
          tags: ['claims'],
          operationId: 'getClaim',
          summary: 'One claim as an agent brief (JSON) or a Markdown investigation prompt',
          parameters: [
            idParam,
            { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'md'], default: 'json' } },
          ],
          responses: {
            '200': {
              description: 'The agent brief',
              headers: cacheHeaders,
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/AgentClaimBrief' } },
                'text/markdown': { schema: { type: 'string' } },
              },
            },
            '404': notFound,
          },
        },
      },
      [`${P}/claims/{id}/manifest.json`]: {
        get: {
          tags: ['claims'],
          operationId: 'getClaimManifest',
          summary: 'The immutable claim manifest (canonical JSON)',
          parameters: [idParam],
          responses: {
            '200': {
              description: 'The manifest. Verify keccak256(UTF-8(canonical JSON)) against x-pine-manifest-hash and the on-chain market name.',
              headers: {
                ...cacheHeaders,
                'x-pine-manifest-hash': { description: 'keccak256 manifest hash', schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' } },
              },
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ClaimManifest' } } },
            },
            '404': notFound,
          },
        },
      },
      [`${P}/policies`]: {
        get: {
          tags: ['policies'],
          operationId: 'listPolicies',
          summary: 'Policy catalog (all versions, with full text and content hash)',
          responses: {
            '200': {
              description: 'Policies',
              headers: cacheHeaders,
              content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/PolicyVersion' } } } },
            },
          },
        },
      },
      [`${P}/policies/{id}`]: {
        get: {
          tags: ['policies'],
          operationId: 'getPolicy',
          summary: 'One policy version (latest unless ?version is given)',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', examples: ['BOT-001'] } },
            { name: 'version', in: 'query', schema: { type: 'string', examples: ['0.1.0'] } },
          ],
          responses: {
            '200': {
              description: 'The policy',
              headers: cacheHeaders,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/PolicyVersion' } } },
            },
            '404': notFound,
          },
        },
      },
      [`${P}/schema/claim-manifest.json`]: {
        get: {
          tags: ['meta'],
          operationId: 'getClaimManifestSchema',
          summary: `JSON Schema (draft 2020-12) for claim manifests (${CLAIM_MANIFEST_SCHEMA_URL})`,
          responses: { '200': { description: 'JSON Schema', content: { 'application/schema+json': { schema: { type: 'object' } } } } },
        },
      },
      [`${P}/openapi.json`]: {
        get: {
          tags: ['meta'],
          operationId: 'getOpenApi',
          summary: 'This document',
          responses: { '200': { description: 'OpenAPI 3.1 document', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      [`${P}/feed.xml`]: {
        get: {
          tags: ['meta'],
          operationId: 'getFeed',
          summary: 'Atom 1.0 feed of claims, newest first',
          responses: { '200': { description: 'Atom feed', content: { 'application/atom+xml': { schema: { type: 'string' } } } } },
        },
      },
    },
    components: {
      schemas: {
        ClaimManifest: withoutMeta(CLAIM_MANIFEST_JSON_SCHEMA),
        AgentClaimBrief: withoutMeta(AGENT_CLAIM_BRIEF_JSON_SCHEMA),
        PolicyVersion: {
          type: 'object',
          required: ['id', 'family', 'version', 'title', 'status', 'contentHash', 'uri', 'text'],
          properties: {
            id: { type: 'string' },
            family: { enum: ['FUNC', 'BOT', 'SC'] },
            version: { type: 'string' },
            title: { type: 'string' },
            summary: { type: 'string' },
            status: { enum: ['enabled', 'gated', 'draft', 'retired'] },
            gateReason: { type: 'string' },
            contentHash: { type: 'string', description: 'keccak256(UTF-8(text))' },
            uri: { type: 'string' },
            text: { type: 'string', description: 'Full policy text (Markdown)' },
            evidenceRequirements: { type: 'array', items: { type: 'string' } },
            exclusions: { type: 'array', items: { type: 'string' } },
            outcomeRules: {
              type: 'object',
              properties: { yes: { type: 'string' }, no: { type: 'string' }, invalid: { type: 'string' } },
            },
          },
        },
        ClaimStatus: { enum: STATUSES },
        Error: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' }, message: { type: 'string' } },
        },
      },
    },
  }
}
