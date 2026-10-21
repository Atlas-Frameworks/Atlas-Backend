import { defineQuery, type Dependency } from '../views/define-query.js';
import { empty, sql, whereAll, type Sql } from '../views/sql.js';

/**
 * Both queries filter on, or send, the order's name, item and customer and
 * the item's type and price. Every column sent must be listed here, or a
 * change to it isn't re-checked and clients don't get it.
 */
const ordersDependsOn: Record<string, Dependency> = {
  orders: { fields: ['name', 'item_id', 'customer_id'] },
  items: {
    fields: ['type', 'price'],
    link: (ids) => sql`SELECT o.id FROM orders o WHERE o.item_id = ANY(${ids})`,
  },
};

/** The row clients get for an order. */
const orderColumns = sql`
  o.id, o.version, o.name, o.customer_id, o.item_id,
  i.type AS item_type, i.price AS item_price`;

/** Both queries sort by name unless the client asks for another column. */
const orderSorting = {
  sortable: { name: 'text', item_type: 'text', item_price: 'number' },
  defaultSort: 'name',
} as const;

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
  ...orderSorting,
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
      SELECT ${orderColumns}
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
  ...orderSorting,
  build: (p: CustomerOrdersParams) => sql`
    SELECT ${orderColumns}
    FROM orders o
    JOIN items i ON i.id = o.item_id
    WHERE o.customer_id = ${p.customerId}
    ${p.types !== undefined ? sql`AND i.type = ANY(${p.types})` : empty}`,
});
