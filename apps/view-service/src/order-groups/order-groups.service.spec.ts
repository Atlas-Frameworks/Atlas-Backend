import type { Knex } from 'knex';
import { GroupOrdersRequestDto } from './dto/group-orders-request.dto.js';
import { OrderGroupsService } from './order-groups.service.js';

const { buildGroupOrdersQueryMock, buildOrderGroupsQueryMock } = vi.hoisted(() => ({
  buildGroupOrdersQueryMock: vi.fn(),
  buildOrderGroupsQueryMock: vi.fn(),
}));

vi.mock('./group-orders-query.js', () => ({
  buildGroupOrdersQuery: buildGroupOrdersQueryMock,
}));

vi.mock('./order-groups-query.js', () => ({
  buildOrderGroupsQuery: buildOrderGroupsQueryMock,
}));

describe('OrderGroupsService', () => {
  it('builds the response from flat database rows', async () => {
    buildOrderGroupsQueryMock.mockResolvedValue([
      {
        rowKind: 'group', level: 1, groupPath: ['W Campaign Alpha'],
        parentPath: null, groupName: 'W Campaign Alpha', total: '1',
        orderId: null, orderName: null,
      },
    ]);
    const service = new OrderGroupsService({} as Knex);
    await expect(service.findGroups({} as never)).resolves.toEqual({
      nodes: [{
        id: '["W Campaign Alpha"]', name: 'W Campaign Alpha',
        parentIds: [], total: 1, children: [],
      }],
    });
  });

  it('returns an empty orders array when the selected group has no matches', async () => {
    buildGroupOrdersQueryMock.mockResolvedValue([]);
    const database = {} as Knex;
    const service = new OrderGroupsService(database);
    const request = new GroupOrdersRequestDto();

    await expect(service.findGroupOrders(request)).resolves.toEqual({
      orders: [],
    });
  });
});
