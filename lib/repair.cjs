'use strict';

/**
 * Strips trailing commas before `}` or `]` outside JSON string literals.
 * @param {string} input
 * @returns {string}
 */
function stripTrailingCommasOutsideStrings(input) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ',') {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j += 1;
      if (input[j] === '}' || input[j] === ']') {
        continue;
      }
    }

    out += ch;
  }

  return out;
}

/**
 * Scans balanced top-level `{...}` JSON object slices outside string literals.
 * @param {string} text
 * @returns {string[]}
 */
function extractBalancedObjects(text) {
  const results = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        results.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return results;
}

/**
 * Extracts a JSON object from raw model output (handles `<think>` blocks, `<tool_call>` tags,
 * markdown fences, trailing commas outside strings, and leading/trailing chatter).
 * @param {unknown} raw
 * @returns {{ value: any, extracted: boolean, error?: string }}
 */
function extractJsonCandidate(raw) {
  if (raw && typeof raw === 'object') {
    return { value: raw, extracted: false };
  }
  const text = String(raw ?? '').trim();
  if (!text) return { value: null, extracted: false, error: 'Empty tool arguments' };

  const withoutThink = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const candidates = [text];
  if (withoutThink && withoutThink !== text) {
    candidates.push(withoutThink);
  }

  const tagRegex = /<(?:tool_call|function_call)>\s*([\s\S]*?)\s*<\/(?:tool_call|function_call)>/gi;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(withoutThink || text)) !== null) {
    if (tagMatch[1]?.trim()) candidates.push(tagMatch[1].trim());
  }

  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fenceMatch;
  while ((fenceMatch = fenceRegex.exec(withoutThink || text)) !== null) {
    if (fenceMatch[1]?.trim()) candidates.push(fenceMatch[1].trim());
  }

  for (const objSlice of extractBalancedObjects(withoutThink || text)) {
    candidates.push(objSlice);
  }

  const seen = new Set();
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    try {
      return { value: JSON.parse(candidate), extracted: i > 0 };
    } catch {
      const withoutTrailingCommas = stripTrailingCommasOutsideStrings(candidate);
      if (withoutTrailingCommas !== candidate) {
        try {
          return { value: JSON.parse(withoutTrailingCommas), extracted: true };
        } catch {}
      }
    }
  }

  return { value: null, extracted: false, error: 'Unable to parse JSON object from tool arguments' };
}

/**
 * Recovers a tool call object (`{ name, arguments }`) from assistant text output when a local model
 * emits `<tool_call>...</tool_call>` or raw JSON instead of structured `tool_calls`.
 * @param {unknown} content
 * @param {Set<string>|string[]|null} allowedTools
 * @returns {{ name: string, arguments: any, source: string } | null}
 */
function extractToolCallFromText(content, allowedTools = null) {
  if (typeof content !== 'string' || !content.trim()) return null;
  const parsed = extractJsonCandidate(content);
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return null;
  }

  const obj = parsed.value;
  const fnName = obj.name || obj.function?.name || obj.tool || null;
  if (typeof fnName !== 'string' || !fnName.trim()) return null;

  if (allowedTools) {
    const allowedSet = allowedTools instanceof Set ? allowedTools : new Set(allowedTools);
    if (!allowedSet.has(fnName)) return null;
  }

  const args =
    obj.arguments !== undefined
      ? obj.arguments
      : obj.function?.arguments !== undefined
        ? obj.function.arguments
        : obj.parameters !== undefined
          ? obj.parameters
          : null;

  if (args === null) return null;

  return {
    name: fnName,
    arguments: args,
    source: /<(?:tool_call|function_call)>/i.test(content) ? 'xml_tool_call' : 'text_json'
  };
}

function normalizeSchemaTypes(typeSpec) {
  if (!typeSpec) return [];
  return Array.isArray(typeSpec) ? typeSpec : [typeSpec];
}

function matchesSingleType(val, expectedType) {
  if (!expectedType) return true;
  if (expectedType === 'null') return val === null;
  if (expectedType === 'array') return Array.isArray(val);
  if (expectedType === 'integer') return Number.isInteger(val);
  if (expectedType === 'number') return typeof val === 'number' && Number.isFinite(val);
  if (expectedType === 'object') return val !== null && typeof val === 'object' && !Array.isArray(val);
  return typeof val === expectedType;
}

function matchesType(val, typeSpec) {
  const types = normalizeSchemaTypes(typeSpec);
  if (types.length === 0) return true;
  return types.some((t) => matchesSingleType(val, t));
}

function coerceValue(val, typeSpec) {
  const types = normalizeSchemaTypes(typeSpec);
  if (types.length === 0 || matchesType(val, types)) {
    return { value: val, coerced: false, targetType: null };
  }

  if (typeof val === 'string') {
    const trimmed = val.trim();

    if (types.includes('integer') && /^-?\d+(?:\.0+)?$/.test(trimmed)) {
      const parsedInt = Number.parseInt(trimmed, 10);
      if (Number.isSafeInteger(parsedInt)) {
        return { value: parsedInt, coerced: true, targetType: 'integer' };
      }
    }

    if (types.includes('number') && trimmed !== '' && !Number.isNaN(Number(trimmed))) {
      const parsedNum = Number(trimmed);
      if (Number.isFinite(parsedNum)) {
        return { value: parsedNum, coerced: true, targetType: 'number' };
      }
    }

    if (types.includes('boolean')) {
      const lower = trimmed.toLowerCase();
      if (lower === 'true') return { value: true, coerced: true, targetType: 'boolean' };
      if (lower === 'false') return { value: false, coerced: true, targetType: 'boolean' };
    }

    if (types.includes('array') && trimmed.startsWith('[')) {
      try {
        const parsedArr = JSON.parse(stripTrailingCommasOutsideStrings(trimmed));
        if (Array.isArray(parsedArr)) {
          return { value: parsedArr, coerced: true, targetType: 'array' };
        }
      } catch {}
    }

    if (types.includes('object') && trimmed.startsWith('{')) {
      try {
        const parsedObj = JSON.parse(stripTrailingCommasOutsideStrings(trimmed));
        if (parsedObj && typeof parsedObj === 'object' && !Array.isArray(parsedObj)) {
          return { value: parsedObj, coerced: true, targetType: 'object' };
        }
      } catch {}
    }
  }

  return { value: val, coerced: false, targetType: null };
}

function repairFieldValue(val, propSchema, fieldPath, repairs, errors) {
  let current = val;

  if (propSchema.type) {
    const coerced = coerceValue(current, propSchema.type);
    if (coerced.coerced) {
      current = coerced.value;
      repairs.push(`coerced:${fieldPath}->${coerced.targetType}`);
    }
    if (!matchesType(current, propSchema.type)) {
      const expectedLabel = Array.isArray(propSchema.type) ? propSchema.type.join('|') : propSchema.type;
      const gotLabel = current === null ? 'null' : Array.isArray(current) ? 'array' : typeof current;
      errors.push(`Property "${fieldPath}" expected ${expectedLabel}, got ${gotLabel}`);
      return current;
    }
  }

  if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(current)) {
    if (typeof current === 'string') {
      const ciMatch = propSchema.enum.find((item) => typeof item === 'string' && item.toLowerCase() === current.toLowerCase());
      if (ciMatch !== undefined) {
        current = ciMatch;
        repairs.push(`normalized_enum:${fieldPath}`);
      }
    }
    if (!propSchema.enum.includes(current)) {
      errors.push(`Property "${fieldPath}" value "${current}" is not in enum [${propSchema.enum.join(', ')}]`);
    }
  }

  if (current && typeof current === 'object' && !Array.isArray(current) && (propSchema.properties || propSchema.additionalProperties === false || propSchema.required)) {
    const nested = validateObjectAgainstSchema(current, propSchema, fieldPath, repairs, errors);
    current = nested;
  }

  if (Array.isArray(current) && propSchema.items && typeof propSchema.items === 'object') {
    current = current.map((item, idx) => repairFieldValue(item, propSchema.items, `${fieldPath}[${idx}]`, repairs, errors));
  }

  return current;
}

function validateObjectAgainstSchema(obj, schema, prefix, repairs, errors) {
  const out = { ...obj };
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(out)) {
      if (!(key in props)) {
        delete out[key];
        const pathLabel = prefix ? `${prefix}.${key}` : key;
        repairs.push(`stripped_unknown:${pathLabel}`);
      }
    }
  }

  for (const key of required) {
    if (out[key] === undefined || out[key] === null || out[key] === '') {
      const pathLabel = prefix ? `${prefix}.${key}` : key;
      errors.push(`Missing required property: ${pathLabel}`);
    }
  }

  for (const [key, propSchema] of Object.entries(props)) {
    if (out[key] === undefined) continue;
    const pathLabel = prefix ? `${prefix}.${key}` : key;
    out[key] = repairFieldValue(out[key], propSchema, pathLabel, repairs, errors);
  }

  return out;
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

  const errors = [];
  const out = validateObjectAgainstSchema(parsed.value, schema, '', repairs, errors);

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
  extractToolCallFromText,
  validateAndRepairArgs
};
