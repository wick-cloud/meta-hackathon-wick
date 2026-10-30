import Fastify from 'fastify';
import { describe, it, expect } from 'vitest';
import { BROKER_PUBLIC_ROUTES } from '../src/shared/developer.js';
import { brokerOpenApi, registerOpenApi } from '../src/server/openapi.js';
import { BROKER_API_SCHEMAS, BROKER_OPERATION_SCHEMAS } from '../packages/sdk/src/contracts.js';

describe('Broker public OpenAPI contract', () => {
  it('documents exactly the explicit machine route allowlist with current scopes and operation requirements', () => {
    const document = brokerOpenApi();
    expect(document.info.version).toBe('1.0.0');
    expect(document.openapi).toBe('3.1.0');
    const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => ({
        path,
        method,
        operation: operation as Record<string, any>,
      })),
    );
    expect(operations).toHaveLength(BROKER_PUBLIC_ROUTES.length);
    for (const route of BROKER_PUBLIC_ROUTES) {
      const path = route.path.replace(/:([A-Za-z]+)/g, '{$1}');
      const operation = document.paths[path][route.method.toLowerCase()] as Record<string, any>;
      expect(operation['x-broker-scope']).toBe(route.scope);
      expect(operation['x-broker-mutation']).toBe(Boolean(route.mutation));
      expect(operation.security).toEqual([{ BrokerBearer: [] }]);
      const header = (operation.parameters ?? []).find((p: any) => p.name === 'Idempotency-Key');
      expect(Boolean(header?.required)).toBe(Boolean(route.mutation));
      expect(BROKER_OPERATION_SCHEMAS[`${route.method} ${route.path}`]).toBeDefined();
    }
    expect(new Set(operations.map((op) => op.operation.operationId)).size).toBe(operations.length);
    expect(
      Object.keys(document.paths).some(
        (path) => path.includes('/admin') || path.startsWith('/api/keys') || path.includes('/auth'),
      ),
    ).toBe(false);
  });
  it('resolves every schema reference and excludes private Wick credential metadata from public types', () => {
    const text = JSON.stringify(brokerOpenApi());
    const refs = [...text.matchAll(/#\/components\/schemas\/([A-Za-z]+)/g)].map(
      (match) => match[1],
    );
    for (const name of refs) expect(BROKER_API_SCHEMAS[name], name).toBeDefined();
    for (const name of ['CatalogItem', 'VM', 'Session']) {
      const schema = JSON.stringify(BROKER_API_SCHEMAS[name]);
      for (const privateField of [
        'providerKeyId',
        'organizationId',
        'groupId',
        'apiKeyHash',
        'token',
        'raw',
      ])
        expect(schema).not.toContain(`"${privateField}"`);
    }
    expect(BROKER_API_SCHEMAS.CreateOrder).toMatchObject({
      required: expect.arrayContaining(['operationKey', 'maxPriceCents', 'requirements']),
    });
  });
  it('serves a static public contract without authentication, database access or model calls', async () => {
    const app = Fastify();
    registerOpenApi(app);
    try {
      const response = await app.inject('/api/openapi.json');
      expect(response.statusCode).toBe(200);
      expect(response.json().info.title).toBe('Wick Broker API');
    } finally {
      await app.close();
    }
  });
});
