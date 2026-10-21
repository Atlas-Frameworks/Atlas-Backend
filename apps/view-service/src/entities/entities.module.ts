import { Module } from '@nestjs/common';
import { customersEntity } from './customers.entity.js';
import { EntityRegistry } from './entity-registry.js';
import { itemsEntity } from './items.entity.js';
import { ordersEntity } from './orders.entity.js';

@Module({
  providers: [
    {
      provide: EntityRegistry,
      useFactory: () =>
        new EntityRegistry([ordersEntity(), itemsEntity(), customersEntity()]),
    },
  ],
  exports: [EntityRegistry],
})
export class EntitiesModule {}
