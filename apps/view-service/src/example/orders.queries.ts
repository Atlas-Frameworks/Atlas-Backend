import { defineQuery, type Dependency } from '../views/define-query.js';
import { empty, sql, whereAll, type Sql } from '../views/sql.js';

/** Both queries read the order's item and customer, and the item's type and price. */
const ordersDependsOn: Record<string, Dependency> = {
  orders: { fields: ['item_id', 'customer_id'] },
  items: {
    fields: ['type', 'price'],
    link: (ids) => sql`SELECT o.id FROM orders o WHERE o.item_id = ANY(${ids})`,
  },
};

export interface OrdersSearchParams {
  types?: string[];
  minPrice?: number;
  maxPrice?: number;
  customerId?: string;
}

/** Orders, filtered by any mix of item type, item price and customer. */
export const ordersSearch = defineQuery({
  name: 'orders-search',
  entityType: 'orders',
  dependsOn: ordersDependsOn,
  build: (p: OrdersSearchParams) => {
    const where: Sql[] = [];
    if (p.types !== undefined) {
      where.push(sql`i.type = ANY(${p.types})`);
    }
    if (p.minPrice !== undefined) {
      where.push(sql`i.price >= ${p.minPrice}`);
    }
    if (p.maxPrice !== undefined) {
      where.push(sql`i.price <= ${p.maxPrice}`);
    }
    if (p.customerId !== undefined) {
      where.push(sql`o.customer_id = ${p.customerId}`);
    }
    return sql`
      SELECT o.id, o.version
      FROM orders o
      JOIN items i ON i.id = o.item_id
      ${whereAll(where)}`;
  },
});

export interface CustomerOrdersParams {
  customerId: string;
  types?: string[];
}

/** One customer's orders, optionally only some item types. */
export const customerOrders = defineQuery({
  name: 'customer-orders',
  entityType: 'orders',
  dependsOn: ordersDependsOn,
  build: (p: CustomerOrdersParams) => sql`
    SELECT o.id, o.version
    FROM orders o
    JOIN items i ON i.id = o.item_id
    WHERE o.customer_id = ${p.customerId}
    ${p.types !== undefined ? sql`AND i.type = ANY(${p.types})` : empty}`,
});
