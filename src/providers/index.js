import { DatadogAdapter } from './datadog.js';
import { Last9SessionAdapter } from './last9-session.js';
import { SampleAdapter } from './sample.js';

export function createProvider(provider, env = process.env, options = {}) {
  if (provider === 'sample') return new SampleAdapter();
  if (provider === 'datadog') return new DatadogAdapter(env, options);
  if (provider === 'last9') return new Last9SessionAdapter(env, options);
  throw new Error(`Unsupported provider: ${provider}`);
}
