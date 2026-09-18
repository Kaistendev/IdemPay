import { createHash } from 'node:crypto';

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

const NUMERIC_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const WHITESPACE = /\s+/g;

function canonicalString(value: string): string | number {
  const normalized = value.normalize('NFC').replace(WHITESPACE, ' ').trim();

  if (NUMERIC_LITERAL.test(normalized)) {
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return Object.is(parsed, -0) ? 0 : parsed;
    }
  }

  return normalized;
}

function canonicalNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Unsupported payload value: ${String(value)}`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function canonicalObject(value: object): CanonicalValue {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    const items = value as unknown[];
    return items.map((item) =>
      item === undefined ? null : toCanonicalValue(item),
    );
  }

  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Unsupported payload value: non-plain object');
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .flatMap((key) => {
      const item = record[key];
      return item === undefined ? [] : [[key, toCanonicalValue(item)] as const];
    });

  return Object.fromEntries(entries);
}

function toCanonicalValue(value: unknown): CanonicalValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case 'boolean':
      return value;
    case 'number':
      return canonicalNumber(value);
    case 'string':
      return canonicalString(value);
    case 'object':
      return canonicalObject(value);
    default:
      throw new Error(`Unsupported payload value: ${typeof value}`);
  }
}

export function canonicalizePayload(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

export function hashCanonicalPayload(value: unknown): string {
  return createHash('sha256')
    .update(canonicalizePayload(value), 'utf8')
    .digest('hex');
}
