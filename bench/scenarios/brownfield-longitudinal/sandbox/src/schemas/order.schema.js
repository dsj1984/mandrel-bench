export const createOrderSchema = {
  customerId: { type: 'string', required: true, minLength: 1, maxLength: 64 },
  notes: { type: 'string', maxLength: 2000 },
};
