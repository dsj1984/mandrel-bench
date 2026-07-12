const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const registerSchema = {
  name: { type: 'string', required: true, minLength: 1, maxLength: 200 },
  email: {
    type: 'string',
    required: true,
    minLength: 3,
    maxLength: 320,
    pattern: EMAIL_PATTERN,
  },
  password: { type: 'string', required: true, minLength: 8, maxLength: 200 },
};

export const loginSchema = {
  email: {
    type: 'string',
    required: true,
    minLength: 3,
    maxLength: 320,
    pattern: EMAIL_PATTERN,
  },
  password: { type: 'string', required: true, minLength: 1, maxLength: 200 },
};
