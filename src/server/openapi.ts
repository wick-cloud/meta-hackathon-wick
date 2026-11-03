import type { FastifyInstance } from 'fastify';
import { BROKER_ADVERTISED_ROUTES } from '../shared/developer.js';
import { BROKER_API_SCHEMAS, BROKER_OPERATION_SCHEMAS } from '../../packages/sdk/src/contracts.js';

export function brokerOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  for (const route of BROKER_ADVERTISED_ROUTES) {
    const contract = BROKER_OPERATION_SCHEMAS[`${route.method} ${route.path}`];
    if (!contract)
      throw new Error(`Missing public Broker operation contract: ${route.method} ${route.path}`);
    const path = route.path.replace(/:([A-Za-z]+)/g, '{$1}');
    const parameters: Record<string, unknown>[] = [...route.path.matchAll(/:([A-Za-z]+)/g)].map(
      (match) => ({ name: match[1], in: 'path', required: true, schema: { type: 'string' } }),
    );
    if (contract.paginated)
      parameters.push(
        {
          name: 'limit',
          in: 'query',
          schema: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: route.path === '/api/orders' ? 25 : 30,
          },
        },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
      );
    if (route.path === '/api/disks/:id/files')
      parameters.push(
        {
          name: 'prefix',
          in: 'query',
          description: 'Relative folder ending in /; omit to browse the /workspace root.',
          schema: { type: 'string', maxLength: 1024, default: '' },
        },
        {
          name: 'continuationToken',
          in: 'query',
          description: 'Opaque token from the preceding page for the same folder.',
          schema: { type: 'string', maxLength: 4096 },
        },
      );
    if (route.path === '/api/disks/:id/file')
      parameters.push({
        name: 'key',
        in: 'query',
        required: true,
        description: 'Exact relative file key from the disk listing, beneath /workspace.',
        schema: { type: 'string', minLength: 1, maxLength: 1024 },
      });
    if (route.path === '/api/orders')
      for (const [name, values] of Object.entries({
        kind: ['all', 'auction', 'token'],
        status: ['all', 'active', 'history', 'attention'],
        created: ['all', '24h', '7d', '30d'],
      }))
        parameters.push({
          name,
          in: 'query',
          schema: { type: 'string', enum: values, default: 'all' },
        });
    if (['/api/inference/packs', '/api/provider/inference/packs'].includes(route.path))
      parameters.push({
        name: 'view',
        in: 'query',
        schema: { type: 'string', enum: ['all', 'active', 'archive'], default: 'all' },
        description:
          'Archive contains settled batches with no held quota. Unresolved usage stays active.',
      });
    if (route.mutation)
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string', minLength: 8, maxLength: 160 },
        description:
          'Stable operation key. Must match operationKey in the JSON body. Reuse only with the identical operation and payload.',
      });
    const terminal = route.path.endsWith('/terminal');
    const errors = Object.fromEntries(
      [400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503, 504].map((status) => [
        status,
        {
          description:
            status === 429 ? 'Rate limited; inspect Retry-After.' : 'Structured Broker error.',
          content: { 'application/json': { schema: ref('Error') } },
        },
      ]),
    );
    (paths[path] ??= {})[route.method.toLowerCase()] = {
      operationId: contract.operationId,
      summary: contract.summary,
      tags: [route.path.startsWith('/api/provider/') ? 'Provider' : 'Buyer'],
      security: [{ BrokerBearer: [] }],
      'x-broker-scope': route.scope,
      'x-broker-mutation': Boolean(route.mutation),
      ...(terminal ? { 'x-broker-websocket': true } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(contract.input
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref(contract.input) } },
            },
          }
        : {}),
      responses: {
        [terminal ? '101' : '200']: {
          description: terminal
            ? 'WebSocket terminal protocol; final output is base64 and requires acknowledgement.'
            : 'Successful operation.',
          ...(!terminal
            ? { content: { 'application/json': { schema: ref(contract.output) } } }
            : {}),
        },
        ...errors,
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Wick Broker API',
      version: '1.0.0',
      description:
        'Buyer and provider access to the same Broker marketplace. Broker API keys (wbk_) are separate from Wick service credentials. Money fields use USD cents with up to two fractional cent digits ($0.0001); integer micros fields retain their explicit unit. VM key limits are per operation; inference agent keys are bound to an aggregate funded grant. Inference supports buffered text only. Unknown usage retains token reservations and is never automatically resent.',
    },
    paths,
    components: {
      securitySchemes: {
        BrokerBearer: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'wbk_<public-id>.<secret>',
          description: 'A scoped Broker key created in the UI. Wick keys are not accepted.',
        },
      },
      schemas: referencedSchemas(paths),
    },
  };
}
/** Keep compatibility types in the SDK without advertising retired inputs in OpenAPI. */
function referencedSchemas(paths: Record<string, unknown>) {
  const schemas: Record<string, unknown> = {};
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    const ref = record.$ref;
    if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
      const name = ref.slice('#/components/schemas/'.length);
      if (!(name in schemas)) {
        const schema = BROKER_API_SCHEMAS[name];
        if (!schema) throw new Error(`Missing Broker schema: ${name}`);
        schemas[name] = schema;
        visit(schema);
      }
    }
    for (const item of Object.values(record)) visit(item);
  }
  visit(paths);
  return schemas;
}
export function registerOpenApi(app: FastifyInstance) {
  const document = brokerOpenApi();
  app.get('/api/openapi.json', async () => document);
}
