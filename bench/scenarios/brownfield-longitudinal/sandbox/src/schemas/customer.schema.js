const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const createCustomerSchema = {
  name: { type: 'string', required: true, minLength: 1, maxLength: 200 },
  email: {
    type: 'string',
    required: true,
    minLength: 3,
    maxLength: 320,
    pattern: EMAIL_PATTERN,
  },
};

export const updateCustomerSchema = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  email: {
    type: 'string',
    minLength: 3,
    maxLength: 320,
    pattern: EMAIL_PATTERN,
  },
};
