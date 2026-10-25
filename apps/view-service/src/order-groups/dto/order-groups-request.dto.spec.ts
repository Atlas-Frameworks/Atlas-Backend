import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderGroupingDimension } from '../order-grouping-dimension.js';
import { OrderFilterOperator } from '../order-filter.js';
import { OrderGroupsRequestDto } from './order-groups-request.dto.js';

describe('OrderGroupsRequestDto', () => {
  it('accepts a valid filtered request', async () => {
    const request = plainToInstance(OrderGroupsRequestDto, {
      wCampaignIds: [validRootId],
      groupBy: [OrderGroupingDimension.W_MISSION_NAME, OrderGroupingDimension.ORDER_STATUS],
      filters: [{ field: OrderGroupingDimension.ORDER_COUNTRY, operator: OrderFilterOperator.EQ, value: 'IL' }],
      defaultLimit: 25, pagination: {},
    });
    await expect(validate(request)).resolves.toEqual([]);
  });

  it.each([
    { wCampaignIds: ['invalid'], groupBy: [] },
    { wCampaignIds: [validRootId], groupBy: ['UNKNOWN'] },
    { wCampaignIds: [validRootId], groupBy: [], defaultLimit: 0 },
  ])('rejects invalid input', async (input) => {
    expect(await validate(plainToInstance(OrderGroupsRequestDto, input))).not.toHaveLength(0);
  });
});

const validRootId = '10000000-0000-4000-8000-000000000001';
