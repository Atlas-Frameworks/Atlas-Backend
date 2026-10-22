import { defineQuery, type Dependency } from '../views/define-query.js';
import { empty, sql, whereAll, type Sql } from '../views/sql.js';

/** The order ids that use these items. */
const ordersOfItems = (ids: string[]) =>
  sql`SELECT o.id FROM orders o WHERE o.item_id = ANY(${ids})`;

/**
 * Every field a query filters on or sends is listed: `filter` if a change can
 * add or remove rows, `shown` if it only changes rows the view holds. A
 * field missing here is never re-checked, and clients don't get its changes.
 */
const orderFields: Dependency = {
  filter: ['item_id', 'customer_id'],
  shown: ['name'],
};

/** ordersSearch filters on the item's type and price (when those params are set). */
const ordersSearchDependsOn: Record<string, Dependency> = {
  orders: orderFields,
  items: { filter: ['type', 'price'], via: 'item_id', link: ordersOfItems },
};

/**
 * customerOrders filters on the item's type, but only sends its price: a
 * price change re-checks the held orders of that item, found from memory,
 * with no link query.
 */
const customerOrdersDependsOn: Record<string, Dependency> = {
  orders: orderFields,
  items: {
    filter: ['type'],
    shown: ['price'],
    via: 'item_id',
    link: ordersOfItems,
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
  dependsOn: ordersSearchDependsOn,
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
  dependsOn: customerOrdersDependsOn,
  ...orderSorting,
  build: (p: CustomerOrdersParams) => sql`
    SELECT ${orderColumns}
    FROM orders o
    JOIN items i ON i.id = o.item_id
    WHERE o.customer_id = ${p.customerId}
    ${p.types !== undefined ? sql`AND i.type = ANY(${p.types})` : empty}`,
});
