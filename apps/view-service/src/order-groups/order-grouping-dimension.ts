export enum OrderSource {
  W = 'W',
  A = 'A',
}

export enum OrderGroupingDimension {
  W_CAMPAIGN_NAME = 'W_CAMPAIGN_NAME', W_CAMPAIGN_NUMBER = 'W_CAMPAIGN_NUMBER',
  W_CAMPAIGN_STATUS = 'W_CAMPAIGN_STATUS', W_CAMPAIGN_COUNTRY = 'W_CAMPAIGN_COUNTRY',
  W_MISSION_NAME = 'W_MISSION_NAME', W_MISSION_NUMBER = 'W_MISSION_NUMBER',
  W_MISSION_STATUS = 'W_MISSION_STATUS', W_MISSION_COUNTRY = 'W_MISSION_COUNTRY',
  W_PLAN_NAME = 'W_PLAN_NAME', W_PLAN_NUMBER = 'W_PLAN_NUMBER',
  W_PLAN_STATUS = 'W_PLAN_STATUS', W_PLAN_COUNTRY = 'W_PLAN_COUNTRY',
  W_PLAN_CATEGORY = 'W_PLAN_CATEGORY', A_MISSION_NAME = 'A_MISSION_NAME',
  A_PLAN_NAME = 'A_PLAN_NAME', A_PLAN_NUMBER = 'A_PLAN_NUMBER',
  A_PLAN_STATUS = 'A_PLAN_STATUS', A_PLAN_COUNTRY = 'A_PLAN_COUNTRY',
  A_MISSION_NUMBER = 'A_MISSION_NUMBER', A_MISSION_STATUS = 'A_MISSION_STATUS',
  A_MISSION_COUNTRY = 'A_MISSION_COUNTRY', A_OBJECTIVE_NAME = 'A_OBJECTIVE_NAME',
  A_OBJECTIVE_NUMBER = 'A_OBJECTIVE_NUMBER', A_OBJECTIVE_STATUS = 'A_OBJECTIVE_STATUS',
  A_OBJECTIVE_COUNTRY = 'A_OBJECTIVE_COUNTRY', A_OBJECTIVE_CATEGORY = 'A_OBJECTIVE_CATEGORY',
  ORDER_NAME = 'ORDER_NAME', ORDER_NUMBER = 'ORDER_NUMBER', ORDER_STATUS = 'ORDER_STATUS',
  ORDER_COUNTRY = 'ORDER_COUNTRY', ORDER_PRIORITY = 'ORDER_PRIORITY',
  ORDER_AMOUNT = 'ORDER_AMOUNT', ORDER_CATEGORY = 'ORDER_CATEGORY',
}

export interface GroupingDimensionDefinition {
  readonly column: string;
  readonly sources: readonly OrderSource[];
}

const bothSources = [OrderSource.W, OrderSource.A] as const;
const groupingDimensions: Record<OrderGroupingDimension, GroupingDimensionDefinition> = {
  [OrderGroupingDimension.W_CAMPAIGN_NAME]: w('root.name'),
  [OrderGroupingDimension.W_CAMPAIGN_NUMBER]: w('root.number'),
  [OrderGroupingDimension.W_CAMPAIGN_STATUS]: w('root.status'),
  [OrderGroupingDimension.W_CAMPAIGN_COUNTRY]: w('root.country'),
  [OrderGroupingDimension.W_MISSION_NAME]: w('w_mission.name'),
  [OrderGroupingDimension.W_MISSION_NUMBER]: w('w_mission.number'),
  [OrderGroupingDimension.W_MISSION_STATUS]: w('w_mission.status'),
  [OrderGroupingDimension.W_MISSION_COUNTRY]: w('w_mission.country'),
  [OrderGroupingDimension.W_PLAN_NAME]: w('w_plan.name'),
  [OrderGroupingDimension.W_PLAN_NUMBER]: w('w_plan.number'),
  [OrderGroupingDimension.W_PLAN_STATUS]: w('w_plan.status'),
  [OrderGroupingDimension.W_PLAN_COUNTRY]: w('w_plan.country'),
  [OrderGroupingDimension.W_PLAN_CATEGORY]: w('w_plan.category'),
  [OrderGroupingDimension.A_PLAN_NAME]: a('root.name'),
  [OrderGroupingDimension.A_PLAN_NUMBER]: a('root.number'),
  [OrderGroupingDimension.A_PLAN_STATUS]: a('root.status'),
  [OrderGroupingDimension.A_PLAN_COUNTRY]: a('root.country'),
  [OrderGroupingDimension.A_MISSION_NAME]: a('a_mission.name'),
  [OrderGroupingDimension.A_MISSION_NUMBER]: a('a_mission.number'),
  [OrderGroupingDimension.A_MISSION_STATUS]: a('a_mission.status'),
  [OrderGroupingDimension.A_MISSION_COUNTRY]: a('a_mission.country'),
  [OrderGroupingDimension.A_OBJECTIVE_NAME]: a('a_objective.name'),
  [OrderGroupingDimension.A_OBJECTIVE_NUMBER]: a('a_objective.number'),
  [OrderGroupingDimension.A_OBJECTIVE_STATUS]: a('a_objective.status'),
  [OrderGroupingDimension.A_OBJECTIVE_COUNTRY]: a('a_objective.country'),
  [OrderGroupingDimension.A_OBJECTIVE_CATEGORY]: a('a_objective.category'),
  [OrderGroupingDimension.ORDER_NAME]: shared('customer_order.name'),
  [OrderGroupingDimension.ORDER_NUMBER]: shared('customer_order.number'),
  [OrderGroupingDimension.ORDER_STATUS]: shared('customer_order.status'),
  [OrderGroupingDimension.ORDER_COUNTRY]: shared('customer_order.country'),
  [OrderGroupingDimension.ORDER_PRIORITY]: shared('customer_order.priority'),
  [OrderGroupingDimension.ORDER_AMOUNT]: shared('customer_order.amount'),
  [OrderGroupingDimension.ORDER_CATEGORY]: shared('customer_order.category'),
};

export function resolveGroupingDimensions(dimensions: readonly OrderGroupingDimension[]): readonly GroupingDimensionDefinition[] {
  return dimensions.map((dimension) => groupingDimensions[dimension]);
}

export function supportsSource(definition: GroupingDimensionDefinition, source: OrderSource): boolean {
  return definition.sources.includes(source);
}

function w(column: string): GroupingDimensionDefinition {
  return { column, sources: [OrderSource.W] };
}

function a(column: string): GroupingDimensionDefinition {
  return { column, sources: [OrderSource.A] };
}

function shared(column: string): GroupingDimensionDefinition {
  return { column, sources: bothSources };
}
