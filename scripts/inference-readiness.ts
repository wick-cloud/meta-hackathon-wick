/** Read-only discovery. Never creates endpoints, buys packs, or generates tokens. */
import { loadConfig } from '../src/server/config.js';
import {
  boundedJson,
  createInferenceRuntime,
  MODAL_BASE,
  routeView,
} from '../src/server/inference/runtime.js';

const config = loadConfig(),
  runtime = await createInferenceRuntime(config);
const output: Record<string, unknown> = {
  marketEnabled: runtime.enabled,
  mode: runtime.mode,
  routes: [...runtime.routes.values()].map((r) => ({
    ...routeView(r),
    credentialsConfigured: Boolean(r.apiKey),
    nativeModelConfigured: Boolean(r.nativeModel),
  })),
  salesAlsoRequire:
    'A mapped provider account, a published offer, DB quarantine clearance, sufficient quota capacity and qualification valid through grant expiry.',
};
if (process.argv.includes('--discover-modal')) {
  if (!config.inferenceModalProxyToken) {
    output.modalDiscovery = { status: 'missing_proxy_token', modelIds: [] };
  } else {
    try {
      const response = await fetch(`${MODAL_BASE}/models`, {
        headers: { Authorization: `Bearer ${config.inferenceModalProxyToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        output.modalDiscovery = { status: `http_${response.status}`, modelIds: [] };
      } else {
        const data = (await boundedJson(response, 262144)) as { data?: { id?: unknown }[] };
        const modelIds = Array.isArray(data.data)
          ? data.data
              .slice(0, 100)
              .flatMap((m) => (typeof m.id === 'string' && m.id.length <= 300 ? [m.id] : []))
          : [];
        output.modalDiscovery = {
          status: 'listed',
          modelIds,
          truncated: (data.data?.length ?? 0) > 100,
          configuredModelListed: Boolean(
            config.inferenceModalModel && modelIds.includes(config.inferenceModalModel),
          ),
          note: 'Verify the selected endpoint actually serves Muse Spark Open. Discovery alone does not qualify accounting.',
        };
      }
    } catch {
      output.modalDiscovery = { status: 'discovery_unavailable', modelIds: [] };
    }
  }
}
console.log(JSON.stringify(output, null, 2));
