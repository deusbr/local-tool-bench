'use strict';

/**
 * Extracts a JSON object from raw model output (handles markdown fences and leading/trailing chatter).
 * @param {unknown} raw
 * @returns {{ value: any, extracted: boolean, error?: string }}
 */
function extractJsonCandidate(raw) {
  if (raw && typeof raw === 'object') {
    return { value: raw, extracted: false };
  }
  const text = String(raw ?? '').trim();
  if (!text) return { value: null, extracted: false, error: 'Empty tool arguments' };

  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    try {
      return { value: JSON.parse(candidate), extracted: i > 0 };
    } catch {
      // Strip trailing commas before } or ] as a safe structural repair
      const withoutTrailingCommas = candidate.replace(/,\s*([}\]])/g, '$1');
      if (withoutTrailingCommas !== candidate) {
        try {
          return { value: JSON.parse(withoutTrailingCommas), extracted: true };
        } catch {}
      }
    }
  }
  return { value: null, extracted: false, error: 'Unable to parse JSON object from tool arguments' };
}

function coercePrimitive(val, expectedType) {
  if (expectedType === 'number' && typeof val === 'string' && val.trim() !== '' && !Number.isNaN(Number(val))) {
    return { value: Number(val), coerced: true };
  }
  if (expectedType === 'integer' && typeof val === 'string' && /^-?\d+$/.test(val.trim())) {
    return { value: Number.parseInt(val.trim(), 10), coerced: true };
  }
  if (expectedType === 'boolean' && typeof val === 'string') {
    if (val.toLowerCase() === 'true') return { value: true, coerced: true };
    if (val.toLowerCase() === 'false') return { value: false, coerced: true };
  }
  return { value: val, coerced: false };
}

function matchesType(val, expectedType) {
  if (!expectedType) return true;
  if (expectedType === 'array') return Array.isArray(val);
  if (expectedType === 'integer') return Number.isInteger(val);
  if (expectedType === 'number') return typeof val === 'number' && Number.isFinite(val);
  if (expectedType === 'object') return val !== null && typeof val === 'object' && !Array.isArray(val);
  return typeof val === expectedType;
}

/**
 * Validates and safely repairs tool arguments against a JSON Schema object.
 * @param {unknown} rawArgs
 * @param {Record<string, any>} schema
 */
function validateAndRepairArgs(rawArgs, schema = { type: 'object', properties: {} }) {
  const parsed = extractJsonCandidate(rawArgs);
  if (parsed.error || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return {
      ok: false,
      repaired: false,
      repairs: [],
      errors: [parsed.error || 'Tool arguments must resolve to a JSON object'],
      value: null
    };
  }

  const repairs = [];
  if (parsed.extracted) repairs.push('extracted_or_unwrapped_json');

  const out = { ...parsed.value };
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const errors = [];

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(out)) {
      if (!(key in props)) {
        delete out[key];
        repairs.push(`stripped_unknown:${key}`);
      }
    }
  }

  for (const key of required) {
    if (out[key] === undefined || out[key] === null || out[key] === '') {
      errors.push(`Missing required property: ${key}`);
    }
  }

  for (const [key, propSchema] of Object.entries(props)) {
    if (out[key] === undefined) continue;
    if (propSchema.type) {
      const coerced = coercePrimitive(out[key], propSchema.type);
      if (coerced.coerced) {
        out[key] = coerced.value;
        repairs.push(`coerced:${key}->${propSchema.type}`);
      }
      if (!matchesType(out[key], propSchema.type)) {
        errors.push(`Property "${key}" expected ${propSchema.type}, got ${Array.isArray(out[key]) ? 'array' : typeof out[key]}`);
      }
    }
    if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(out[key])) {
      errors.push(`Property "${key}" value "${out[key]}" is not in enum [${propSchema.enum.join(', ')}]`);
    }
  }

  return {
    ok: errors.length === 0,
    repaired: repairs.length > 0,
    repairs,
    errors,
    value: out
  };
}

module.exports = {
  extractJsonCandidate,
  validateAndRepairArgs
};