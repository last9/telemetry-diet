import { DatadogAdapter } from './datadog.js';
import { Last9Adapter } from './last9.js';
import { SampleAdapter } from './sample.js';

export function createProvider(provider, env = process.env, options = {}) {
  if (provider === 'sample') return new SampleAdapter();
  if (provider === 'datadog') return new DatadogAdapter(env, options);
  if (provider === 'last9') return new Last9Adapter(env, options);
  throw new Error(`Unsupported provider: ${provider}`);
}
