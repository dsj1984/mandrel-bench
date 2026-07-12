export const createOrderItemSchema = {
  description: { type: 'string', required: true, minLength: 1, maxLength: 500 },
  quantity: { type: 'integer', required: true, min: 1, max: 1000000 },
  unitPriceCents: { type: 'integer', required: true, min: 0, max: 100000000 },
};
