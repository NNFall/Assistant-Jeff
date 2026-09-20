/*
 * Local tool registry used by the desktop agent.
 *
 * The model is only ever allowed to address descriptors registered here.  A
 * descriptor is deliberately small: the schema is sent to the provider and
 * execute is called by the desktop run loop after the schema has accepted the
 * arguments.  There is no shell, eval, or dynamic module loading in this
 * boundary.
 */

const NAME = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_TEXT = 2_000;
const MAX_MESSAGE = 2_000;
const MAX_DATA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 24;
const MAX_SCHEMA_NODES = 10_000;
const SAFE_ERROR_WORDS = new Set(['ABORTED', 'TIMEOUT', 'PROVIDER_ERROR', 'NETWORK_ERROR', 'INVALID_RESPONSE', 'UNKNOWN']);

function safeErrorCode(value) {
  if (typeof value !== 'string') return 'EXECUTION_ERROR';
  const code = value.trim().toUpperCase();
  if (SAFE_ERROR_WORDS.has(code) || /^HTTP_[45]\d{2}$/u.test(code) || /^E[A-Z0-9_]{1,63}$/u.test(code) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(code)) return code;
  return 'EXECUTION_ERROR';
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, label = 'value') {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_DATA_BYTES) return undefined;
    return JSON.parse(encoded);
  } catch {
    return undefined;
  }
}

function boundedText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const clean = value.trim();
  return clean.length <= MAX_TEXT ? clean : `${clean.slice(0, MAX_TEXT - 1).trimEnd()}…`;
}

function schemaTypeMatches(value, type) {
  switch (type) {
    case 'object': return plainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isSafeInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function schemaTypes(schema) {
  if (typeof schema?.type === 'string') return [schema.type];
  if (Array.isArray(schema?.type) && schema.type.every(type => typeof type === 'string')) return schema.type;
  return [];
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (plainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
}

function equalJson(a, b) {
  try { return JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b)); } catch { return false; }
}

function schemaError(path, code, message, extra = {}) {
  return { path, code, message, ...extra };
}

function pushError(errors, path, code, message, extra) {
  // One useful correction for a field is enough.  This keeps a malformed
  // model response from consuming the whole request budget with diagnostics.
  if (errors.length < 32) errors.push(schemaError(path, code, message, extra));
}

function numericBound(schema, key, alias) {
  if (Number.isFinite(schema?.[key])) return schema[key];
  if (Number.isFinite(schema?.[alias])) return schema[alias];
  return undefined;
}

function visitSchema(value, schema, path, errors, depth, state) {
  if (++state.nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) {
    pushError(errors, path, 'schema_limit', 'Схема аргументов слишком сложная.');
    return;
  }
  if (!plainObject(schema)) {
    pushError(errors, path, 'schema', 'Схема аргументов недействительна.');
    return;
  }

  const types = schemaTypes(schema);
  if (types.length && !types.some(type => schemaTypeMatches(value, type))) {
    pushError(errors, path, 'type', `Ожидается значение типа ${types.join(' или ')}.`, { expected: types });
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some(item => equalJson(item, value))) {
    pushError(errors, path, 'enum', 'Значение отсутствует в списке допустимых вариантов.', { allowed: cloneJson(schema.enum) ?? [] });
    // Continue only when the value can still be traversed.  Returning keeps
    // diagnostics deterministic and avoids treating a wrong enum as a valid
    // nested object.
    return;
  }

  if (plainObject(value)) {
    const properties = plainObject(schema.properties) ? schema.properties : {};
    const known = new Set(Object.keys(properties));
    for (const key of Object.keys(value)) {
      if (!known.has(key)) pushError(errors, `${path}.${key}`, 'unknown_key', 'Неизвестный параметр.', { key });
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(value, key)) {
        pushError(errors, `${path}.${key}`, 'required', 'Параметр обязателен.', { key });
      }
    }
    const minProperties = numericBound(schema, 'minProperties', 'min');
    const maxProperties = numericBound(schema, 'maxProperties', 'max');
    if (Number.isFinite(minProperties) && Object.keys(value).length < minProperties) {
      pushError(errors, path, 'min', `Нужно передать не меньше ${minProperties} параметров.`, { min: minProperties });
    }
    if (Number.isFinite(maxProperties) && Object.keys(value).length > maxProperties) {
      pushError(errors, path, 'max', `Нужно передать не больше ${maxProperties} параметров.`, { max: maxProperties });
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) visitSchema(value[key], child, `${path}.${key}`, errors, depth + 1, state);
    }
    return;
  }

  if (Array.isArray(value)) {
    const minItems = numericBound(schema, 'minItems', 'min');
    const maxItems = numericBound(schema, 'maxItems', 'max');
    const exactLength = Number.isFinite(schema.length) ? schema.length : undefined;
    if (Number.isFinite(minItems) && value.length < minItems) pushError(errors, path, 'min', `Нужно не меньше ${minItems} элементов.`, { min: minItems });
    if (Number.isFinite(maxItems) && value.length > maxItems) pushError(errors, path, 'max', `Нужно не больше ${maxItems} элементов.`, { max: maxItems });
    if (Number.isFinite(exactLength) && value.length !== exactLength) pushError(errors, path, 'length', `Нужно ровно ${exactLength} элементов.`, { length: exactLength });
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) visitSchema(value[index], schema.items, `${path}[${index}]`, errors, depth + 1, state);
    }
    return;
  }

  if (typeof value === 'string') {
    const minLength = numericBound(schema, 'minLength', 'min');
    const maxLength = numericBound(schema, 'maxLength', 'max');
    const exactLength = Number.isFinite(schema.length) ? schema.length : undefined;
    if (Number.isFinite(minLength) && value.length < minLength) pushError(errors, path, 'min', `Длина должна быть не меньше ${minLength}.`, { min: minLength });
    if (Number.isFinite(maxLength) && value.length > maxLength) pushError(errors, path, 'max', `Длина должна быть не больше ${maxLength}.`, { max: maxLength });
    if (Number.isFinite(exactLength) && value.length !== exactLength) pushError(errors, path, 'length', `Длина должна быть равна ${exactLength}.`, { length: exactLength });
    if (schema.pattern !== undefined && typeof schema.pattern === 'string') {
      let expression;
      try { expression = new RegExp(schema.pattern, 'u'); } catch { expression = null; }
      if (expression && !expression.test(value)) pushError(errors, path, 'pattern', 'Значение имеет недопустимый формат.');
    }
    return;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const minimum = numericBound(schema, 'minimum', 'min');
    const maximum = numericBound(schema, 'maximum', 'max');
    if (Number.isFinite(minimum) && value < minimum) pushError(errors, path, 'min', `Значение должно быть не меньше ${minimum}.`, { min: minimum });
    if (Number.isFinite(maximum) && value > maximum) pushError(errors, path, 'max', `Значение должно быть не больше ${maximum}.`, { max: maximum });
    if (Number.isFinite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) pushError(errors, path, 'min', `Значение должно быть больше ${schema.exclusiveMinimum}.`, { min: schema.exclusiveMinimum, exclusive: true });
    if (Number.isFinite(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) pushError(errors, path, 'max', `Значение должно быть меньше ${schema.exclusiveMaximum}.`, { max: schema.exclusiveMaximum, exclusive: true });
  }
}

/**
 * Validate a JSON value against the deliberately small strict subset used by
 * local desktop tools.  Unknown object keys are always rejected, including
 * when a provider sends `additionalProperties: true` in a schema.
 */
export function validateToolArguments(parameters, args) {
  const errors = [];
  if (!plainObject(parameters)) {
    return { ok: false, code: 'invalid_schema', errors: [schemaError('$', 'schema', 'Схема параметров недействительна.')] };
  }
  if (!plainObject(args)) {
    return { ok: false, code: 'invalid_arguments', errors: [schemaError('$', 'type', 'Аргументы должны быть JSON-объектом.', { expected: ['object'] })] };
  }
  visitSchema(args, parameters, '$', errors, 0, { nodes: 0 });
  return errors.length ? { ok: false, code: 'invalid_arguments', errors } : { ok: true, code: 'valid', errors: [] };
}

function validateSchemaShape(schema, path = '$', depth = 0, state = { nodes: 0 }) {
  if (++state.nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) throw new TypeError(`${path}: schema is too complex`);
  if (!plainObject(schema)) throw new TypeError(`${path}: schema must be an object`);
  const types = schemaTypes(schema);
  const allowedTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  if (types.some(type => !allowedTypes.has(type))) throw new TypeError(`${path}: unsupported schema type`);
  if ('enum' in schema && (!Array.isArray(schema.enum) || schema.enum.length > 128 || schema.enum.some(value => cloneJson(value) === undefined))) throw new TypeError(`${path}: invalid enum`);
  if ('required' in schema && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'))) throw new TypeError(`${path}: invalid required`);
  if ('properties' in schema) {
    if (!plainObject(schema.properties)) throw new TypeError(`${path}: properties must be an object`);
    for (const [key, child] of Object.entries(schema.properties)) validateSchemaShape(child, `${path}.${key}`, depth + 1, state);
  }
  if ('items' in schema) validateSchemaShape(schema.items, `${path}[]`, depth + 1, state);
  for (const key of ['min', 'max', 'length', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) {
    if (key in schema) {
      const numeric = typeof schema[key] === 'number' && Number.isFinite(schema[key]);
      const lengthBound = ['length', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'].includes(key);
      if (!numeric || (lengthBound && (!Number.isSafeInteger(schema[key]) || schema[key] < 0))) throw new TypeError(`${path}.${key}: bound is invalid`);
    }
  }
  if ('pattern' in schema && typeof schema.pattern !== 'string') throw new TypeError(`${path}.pattern: pattern is invalid`);
  if ('type' in schema && !types.length) throw new TypeError(`${path}.type: type is invalid`);
  return schema;
}

function descriptorPublic(descriptor) {
  return {
    name: descriptor.name,
    title: descriptor.title,
    description: descriptor.description,
    effect: descriptor.effect,
    parameters: cloneJson(descriptor.parameters) ?? { type: 'object', properties: {}, required: [] },
  };
}

function normalizeDescriptor(value, index, { allowReserved = false } = {}) {
  if (!plainObject(value)) throw new TypeError(`tools[${index}] must be an object`);
  if (typeof value.name !== 'string' || !NAME.test(value.name)) throw new TypeError(`tools[${index}].name is invalid`);
  if (value.name === 'assistant_respond' && !allowReserved) throw new TypeError('assistant_respond is reserved');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 220) throw new TypeError(`tools[${index}].title is invalid`);
  if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 16 * 1024) throw new TypeError(`tools[${index}].description is invalid`);
  if (typeof value.effect !== 'boolean') throw new TypeError(`tools[${index}].effect is invalid`);
  if (typeof value.execute !== 'function') throw new TypeError(`tools[${index}].execute is invalid`);
  validateSchemaShape(value.parameters, `tools[${index}].parameters`);
  const parameters = cloneJson(value.parameters);
  if (!parameters) throw new TypeError(`tools[${index}].parameters is not JSON`);
  return Object.freeze({
    name: value.name,
    title: value.title.trim(),
    description: value.description.trim(),
    parameters,
    effect: value.effect,
    repeatable: value.repeatable === true,
    available: value.available !== false,
    observation: value.observation === true || value.domain === 'desktop_observation' || ['windows_observe', 'winapp_observe', 'winapp_search', 'windows_text_fields'].includes(value.name),
    ...(typeof value.reason === 'string' && value.reason.trim() ? { reason: value.reason.trim().slice(0, 500) } : {}),
    execute: value.execute,
  });
}

function resultData(value) {
  if (value === undefined) return undefined;
  const cloned = cloneJson(value);
  return cloned === undefined ? undefined : cloned;
}

/** Normalize a descriptor receipt without allowing provider-shaped objects to leak through. */
export function normalizeToolResult(value, { effect = false } = {}) {
  const source = plainObject(value) ? value : {};
  const receipt = {
    ok: source.ok === true,
    verified: source.verified === true,
    // An effect is considered attempted unless the executor explicitly says
    // otherwise.  A missing receipt field must never make an unknown mutation
    // look like a harmless read.
    effectAttempted: typeof source.effectAttempted === 'boolean' ? source.effectAttempted : (effect ? true : false),
    evidence: Array.isArray(source.evidence)
      ? source.evidence.filter(item => typeof item === 'string').slice(0, 32).map(item => item.slice(0, 500))
      : (typeof source.evidence === 'string' && source.evidence ? source.evidence.slice(0, 500) : []),
    message: boundedText(source.message, source.ok === true ? 'Готово.' : 'Инструмент не выполнил действие.'),
  };
  if (source.effectConfirmed === true) receipt.effectConfirmed = true;
  if (source.needsObservation === true) receipt.needsObservation = true;
  if (typeof source.evidenceId === 'string' && source.evidenceId.trim()) receipt.evidenceId = source.evidenceId.trim().slice(0, 200);
  if (typeof source.status === 'string' && source.status.trim()) receipt.status = source.status.trim().slice(0, 120);
  if (typeof source.error === 'string' && source.error.trim()) receipt.error = source.error.trim().slice(0, 160);
  const data = resultData(source.data);
  if (data !== undefined) receipt.data = data;
  return receipt;
}

/**
 * A small, synchronous registry.  Validation is performed before execute is
 * entered, making accidental dispatch of malformed model arguments impossible.
 */
export class LocalToolRegistry {
  constructor(descriptors = [], { allowReserved = false } = {}) {
    if (!Array.isArray(descriptors)) throw new TypeError('tools must be an array');
    const normalized = descriptors.map((descriptor, index) => normalizeDescriptor(descriptor, index, { allowReserved }));
    const names = new Set();
    for (const descriptor of normalized) {
      if (names.has(descriptor.name)) throw new TypeError(`duplicate tool: ${descriptor.name}`);
      names.add(descriptor.name);
    }
    this.descriptors = Object.freeze(normalized);
    this.byName = new Map(normalized.map(descriptor => [descriptor.name, descriptor]));
  }

  list() { return this.descriptors.slice(); }

  publicTools() { return this.descriptors.filter(descriptor => descriptor.available).map(descriptorPublic); }

  capabilities() {
    return this.descriptors.map(descriptor => ({
      name: descriptor.name,
      title: descriptor.title,
      description: descriptor.description,
      effect: descriptor.effect,
      available: descriptor.available,
      ...(descriptor.reason ? { reason: descriptor.reason } : {}),
    }));
  }

  get(name) { return this.byName.get(name); }

  validate(name, args) {
    const descriptor = this.byName.get(name);
    if (!descriptor) {
      return {
        ok: false,
        code: 'unknown_tool',
        errors: [schemaError('$', 'unknown_tool', `Неизвестный инструмент «${boundedText(name, 'неизвестный')}».`, { name })],
      };
    }
    if (descriptor.available === false) {
      return {
        ok: false,
        code: 'unavailable_tool',
        errors: [schemaError('$', 'unavailable_tool', `Инструмент «${descriptor.name}» сейчас недоступен.`, { name: descriptor.name, reason: descriptor.reason ?? '' })],
      };
    }
    return { ...validateToolArguments(descriptor.parameters, args), descriptor };
  }

  async dispatch(name, args, context = {}) {
    const validation = this.validate(name, args);
    if (!validation.ok) {
      return {
        ok: false,
        verified: false,
        effectAttempted: false,
        evidence: [],
        message: validation.code === 'unknown_tool' || validation.code === 'unavailable_tool' ? 'Инструмент недоступен.' : 'Исправьте аргументы инструмента.',
        data: { code: validation.code, errors: validation.errors },
      };
    }
    try {
      const value = await validation.descriptor.execute(args, context);
      return normalizeToolResult(value, { effect: validation.descriptor.effect });
    } catch (error) {
      const explicitNoEffect = error && typeof error === 'object' && error.effectAttempted === false;
      const errorCode = safeErrorCode(error?.code);
      return {
        ok: false,
        verified: false,
        effectAttempted: validation.descriptor.effect && !explicitNoEffect,
        evidence: [],
        status: 'failed',
        error: errorCode,
        message: 'Инструмент завершился с ошибкой.',
        data: { code: errorCode },
      };
    }
  }

  invoke(name, args, context = {}) { return this.dispatch(name, args, context); }
  execute(name, args, context = {}) { return this.dispatch(name, args, context); }
}

export const ToolRegistry = LocalToolRegistry;
export const validateArguments = validateToolArguments;
export const stableArguments = value => {
  try { return JSON.stringify(stableValue(value)); } catch { return ''; }
};

export const registryInternals = Object.freeze({ normalizeDescriptor, descriptorPublic, schemaTypeMatches });
