const STATUS_RANK = {
  unreferenced: 0,
  underreferenced: 1,
  referenced: 2,
};

export function filterMetricUsage(metrics, {
  statuses = null,
  includeProtected = true,
  prefix = null,
  inCatalog = null,
} = {}) {
  const allowedStatuses = statuses ? new Set(statuses) : null;

  return metrics.filter((metric) => {
    if (allowedStatuses && !allowedStatuses.has(metric.status)) return false;
    if (!includeProtected && metric.protected) return false;
    if (prefix && !metric.name.startsWith(prefix)) return false;
    if (inCatalog !== null && metric.inCatalog !== inCatalog) return false;
    return true;
  });
}

export function sortMetricUsage(metrics, { by = 'referenceCount', direction = 'asc' } = {}) {
  const multiplier = direction === 'desc' ? -1 : 1;

  function compare(left, right) {
    if (by === 'name') return left.name.localeCompare(right.name);
    if (by === 'prefix') {
      const leftPrefix = left.name.split('_', 1)[0];
      const rightPrefix = right.name.split('_', 1)[0];
      return leftPrefix.localeCompare(rightPrefix) || left.referenceCount - right.referenceCount
        || left.name.localeCompare(right.name);
    }
    if (by === 'status') {
      return STATUS_RANK[left.status] - STATUS_RANK[right.status] || left.name.localeCompare(right.name);
    }
    return left.referenceCount - right.referenceCount || left.name.localeCompare(right.name);
  }

  return [...metrics].sort((left, right) => multiplier * compare(left, right));
}
