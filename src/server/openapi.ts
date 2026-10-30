import type { FastifyInstance } from 'fastify';
import { BROKER_PUBLIC_ROUTES } from '../shared/developer.js';
import { BROKER_API_SCHEMAS, BROKER_OPERATION_SCHEMAS } from '../../packages/sdk/src/contracts.js';

export function brokerOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  for (const route of BROKER_PUBLIC_ROUTES) {
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
    if (route.path === '/api/orders')
      for (const [name, values] of Object.entries({
        kind: ['all', 'auction', 'agreement', 'token'],
        status: ['all', 'active', 'history', 'attention'],
        created: ['all', '24h', '7d', '30d'],
      }))
        parameters.push({
          name,
          in: 'query',
          schema: { type: 'string', enum: values, default: 'all' },
        });
    if (route.path === '/api/provider/commitments')
      for (const name of ['from', 'to'])
        parameters.push({
          name,
          in: 'query',
          schema: { type: 'string', format: 'date-time' },
          description: 'Calendar range must be no longer than 62 days.',
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
      [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504].map((status) => [
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
        'Buyer and provider access to the same Broker marketplace. Broker API keys (wbk_) are separate from Wick service credentials. All money is whole USD cents unless a field explicitly says micros. VM key limits are per operation; inference agent keys are bound to an aggregate funded grant. Inference supports buffered text only. Unknown usage retains token reservations and is never automatically resent.',
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
      schemas: BROKER_API_SCHEMAS,
    },
  };
}
export function registerOpenApi(app: FastifyInstance) {
  const document = brokerOpenApi();
  app.get('/api/openapi.json', async () => document);
}
