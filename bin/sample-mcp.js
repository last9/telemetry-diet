#!/usr/bin/env node
import { McpServer } from '../src/mcp/server.js';
import { getEnvironments, getRedactedSamples, getScenarioSummary, listServices } from '../src/sample/scenarios.js';

const server = new McpServer({
  name: 'telemetry-diet-sample',
  version: '0.1.0',
  tools: [
    {
      name: 'search_services',
      description: 'List services with bundled sample log telemetry. Read-only.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ services: listServices() }),
    },
    {
      name: 'get_service_environments',
      description: 'List environments for a sample service. Read-only.',
      inputSchema: { type: 'object', required: ['service'], properties: { service: { type: 'string' } } },
      handler: async ({ service }) => ({ service, environments: getEnvironments(service) }),
    },
    {
      name: 'analyze_logs',
      description: 'Return a deterministic normalized aggregate of sample logs. Raw records are not returned.',
      inputSchema: {
        type: 'object', required: ['service', 'timeWindow'],
        properties: { service: { type: 'string' }, environment: { type: 'string' }, timeWindow: { type: 'object' } },
      },
      handler: async ({ service, environment, timeWindow }) => getScenarioSummary(service, environment, timeWindow),
    },
    {
      name: 'search_logs',
      description: 'Return a small set of already-redacted sample records when examples are required. Read-only.',
      inputSchema: { type: 'object', required: ['service'], properties: { service: { type: 'string' }, limit: { type: 'number', maximum: 10 } } },
      handler: async ({ service, limit }) => ({ logs: getRedactedSamples(service, limit) }),
    },
  ],
});

server.start();
