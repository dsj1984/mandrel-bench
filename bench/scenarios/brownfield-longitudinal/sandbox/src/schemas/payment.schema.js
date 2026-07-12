export const createPaymentSchema = {
  amountCents: { type: 'integer', required: true, min: 1, max: 100000000 },
  method: {
    type: 'string',
    required: true,
    enum: ['bank_transfer', 'card', 'cash'],
  },
};
