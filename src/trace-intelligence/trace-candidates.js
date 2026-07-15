const HEALTH_ROUTES = new Set([
  '/actuator/health',
  '/api/health',
  '/health',
  '/healthz',
  '/live',
  '/livez',
  '/ready',
  '/readyz',
]);

export function exactHealthRoute(value) {
  const route = typeof value === 'string' ? value.trim() : '';
  return HEALTH_ROUTES.has(route.toLowerCase()) ? route : null;
}
