/**
 * OpenTelemetry tracing — best-effort. Exports OTLP spans to a collector
 * (Jaeger/Tempo) at OTEL_EXPORTER_OTLP_ENDPOINT. If the OTel packages or the
 * collector aren't present, the app still runs; tracing simply no-ops.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

process.env.OTEL_SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'ticket-blitz';

// Auto-instrumentation (Fastify/HTTP/Redis/Kafka) is optional — load it only
// if the package is installed so a slim install doesn't crash on boot.
function loadInstrumentations(): unknown[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    return [getNodeAutoInstrumentations()];
  } catch {
    return [];
  }
}

try {
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instrumentations: loadInstrumentations() as any,
  });
  sdk.start();

  process.on('SIGTERM', () => {
    sdk
      .shutdown()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
} catch (err) {
  console.warn('[tracing] disabled:', (err as Error).message);
}
