import { parser } from '@prometheus-io/lezer-promql';

export class PromQlParseError extends Error {
  constructor(query, position, options = {}) {
    super(options.message ?? `PromQL could not be parsed at offset ${position}.`);
    this.name = 'PromQlParseError';
    this.query = query;
    this.position = position;
    this.limitation = options.limitation ?? null;
  }
}

const DYNAMIC_NAME_LIMITATION = 'Dynamic __name__ matchers are not resolved; affected reference counts may be incomplete.';

function decodeStringLiteral(raw, query, position) {
  try {
    if (raw.startsWith('"')) return JSON.parse(raw);
    if (raw.startsWith('`') && raw.endsWith('`')) return raw.slice(1, -1);
    if (raw.startsWith("'") && raw.endsWith("'") && !raw.slice(1, -1).includes('\\')) {
      return raw.slice(1, -1);
    }
  } catch {
    // Fall through to a fail-closed parse error.
  }

  throw new PromQlParseError(query, position, {
    message: `PromQL __name__ string literal could not be decoded at offset ${position}.`,
  });
}

export function extractMetricNames(query) {
  if (typeof query !== 'string') {
    throw new TypeError('PromQL query must be a string.');
  }
  if (!query.trim()) return [];

  const tree = parser.parse(query);
  const cursor = tree.cursor();
  const metrics = new Set();
  let errorPosition = null;

  function readLabelMatcher() {
    const matcher = {};
    if (cursor.firstChild()) {
      do {
        const childType = cursor.type.name;
        if (childType === 'LabelName') matcher.name = query.slice(cursor.from, cursor.to);
        if (childType === 'MatchOp') matcher.operator = query.slice(cursor.from, cursor.to);
        if (childType === 'StringLiteral') {
          matcher.value = query.slice(cursor.from, cursor.to);
          matcher.valuePosition = cursor.from;
        }
      } while (cursor.nextSibling());
      cursor.parent();
    }
    return matcher;
  }

  function visit(parentType = null) {
    const type = cursor.type.name;
    if (cursor.type.isError && errorPosition === null) {
      errorPosition = cursor.from;
    }
    if (type === 'Identifier' && parentType === 'VectorSelector') {
      metrics.add(query.slice(cursor.from, cursor.to));
    }
    if (type === 'UnquotedLabelMatcher') {
      const matcher = readLabelMatcher();
      if (matcher.name === '__name__') {
        if (matcher.operator !== '=') {
          throw new PromQlParseError(query, cursor.from, {
            message: `PromQL __name__ matcher ${matcher.operator} is dynamic and cannot be resolved without a metric catalog.`,
            limitation: DYNAMIC_NAME_LIMITATION,
          });
        }
        metrics.add(decodeStringLiteral(matcher.value, query, matcher.valuePosition));
      }
    }

    if (cursor.firstChild()) {
      do {
        visit(type);
      } while (cursor.nextSibling());
      cursor.parent();
    }
  }

  visit();
  if (errorPosition !== null) {
    throw new PromQlParseError(query, errorPosition);
  }
  return [...metrics];
}
