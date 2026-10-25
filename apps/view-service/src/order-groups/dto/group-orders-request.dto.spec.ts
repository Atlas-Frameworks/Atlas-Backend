import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderGroupingDimension } from '../order-grouping-dimension.js';
import { GroupOrdersRequestDto } from './group-orders-request.dto.js';

describe('GroupOrdersRequestDto', () => {
  it('accepts a valid request', async () => {
    const request = plainToInstance(GroupOrdersRequestDto, {
      aPlanIds: [validRootId],
      groupBy: [OrderGroupingDimension.A_MISSION_NAME],
      groupIds: ['["A Plan Alpha"]'], findNodes: [], excludeNodes: [], excludeGroups: [],
    });
    await expect(validate(request)).resolves.toEqual([]);
  });

  it('rejects an empty group ID array', async () => {
    const request = plainToInstance(GroupOrdersRequestDto, {
      aPlanIds: [validRootId], groupBy: [], groupIds: [],
    });
    expect(await validate(request)).not.toHaveLength(0);
  });
});

const validRootId = '20000000-0000-4000-8000-000000000001';
