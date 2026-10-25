export interface GroupingNode {
  readonly id: string;
  readonly name: string;
  readonly parentIds: readonly string[];
  readonly total: number;
  readonly children: readonly string[];
}

export interface GroupingResponse {
  readonly nodes: readonly GroupingNode[];
}

export interface GroupOrder {
  readonly id: string;
  readonly name: string;
  readonly number: number;
  readonly status: string;
  readonly country: string;
  readonly priority: number;
  readonly amount: string;
  readonly category: string;
}

export interface GroupOrdersResponse {
  readonly orders: readonly GroupOrder[];
}

export interface PaginationOverride {
  readonly path: readonly unknown[];
  readonly limit: number;
  readonly offset: number;
}

export interface OrderGroupQueryRow {
  readonly rowKind: 'group' | 'order';
  readonly level: number;
  readonly groupPath: readonly unknown[];
  readonly parentPath: readonly unknown[] | null;
  readonly groupName: string | null;
  readonly total: string | number | null;
  readonly orderId: string | null;
  readonly orderName: string | null;
}
