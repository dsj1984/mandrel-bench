import { createServer } from 'node:http';

import { createRouter } from './router.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerCustomerRoutes } from './routes/customers.routes.js';
import { registerHealthRoutes } from './routes/health.routes.js';
import { registerOrderItemRoutes } from './routes/order-items.routes.js';
import { registerOrderRoutes } from './routes/orders.routes.js';
import { registerPaymentRoutes } from './routes/payments.routes.js';
import { registerReportRoutes } from './routes/reports.routes.js';

export function createApp() {
  const router = createRouter();
  registerHealthRoutes(router);
  registerAuthRoutes(router);
  registerCustomerRoutes(router);
  registerOrderRoutes(router);
  registerOrderItemRoutes(router);
  registerPaymentRoutes(router);
  registerReportRoutes(router);
  return createServer((req, res) => {
    router.dispatch(req, res);
  });
}
