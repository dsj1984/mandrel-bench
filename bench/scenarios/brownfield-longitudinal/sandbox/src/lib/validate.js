function checkString(field, value, rule, problems) {
  if (typeof value !== 'string') {
    problems.push(`${field} must be a string`);
    return;
  }
  if (rule.minLength !== undefined && value.trim().length < rule.minLength) {
    problems.push(`${field} must be at least ${rule.minLength} character(s)`);
  }
  if (rule.maxLength !== undefined && value.length > rule.maxLength) {
    problems.push(`${field} must be at most ${rule.maxLength} character(s)`);
  }
  if (rule.pattern !== undefined && !rule.pattern.test(value)) {
    problems.push(`${field} is not in a valid format`);
  }
}

function checkInteger(field, value, rule, problems) {
  if (!Number.isInteger(value)) {
    problems.push(`${field} must be an integer`);
    return;
  }
  if (rule.min !== undefined && value < rule.min) {
    problems.push(`${field} must be at least ${rule.min}`);
  }
  if (rule.max !== undefined && value > rule.max) {
    problems.push(`${field} must be at most ${rule.max}`);
  }
}

export function validate(body, schema) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return ['request body must be a JSON object'];
  }
  const problems = [];
  for (const [field, rule] of Object.entries(schema)) {
    const value = body[field];
    if (value === undefined || value === null) {
      if (rule.required) problems.push(`${field} is required`);
      continue;
    }
    if (rule.type === 'string') checkString(field, value, rule, problems);
    else if (rule.type === 'integer') checkInteger(field, value, rule, problems);
    else if (rule.type === 'boolean' && typeof value !== 'boolean') {
      problems.push(`${field} must be a boolean`);
    }
    if (rule.enum !== undefined && !rule.enum.includes(value)) {
      problems.push(`${field} must be one of: ${rule.enum.join(', ')}`);
    }
  }
  for (const key of Object.keys(body)) {
    if (!(key in schema)) problems.push(`${key} is not a recognized field`);
  }
  return problems;
}
