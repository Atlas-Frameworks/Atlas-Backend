import { IsDefined, IsEnum } from 'class-validator';
import { OrderGroupingDimension } from '../order-grouping-dimension.js';
import { OrderFilterOperator } from '../order-filter.js';

export class OrderFilterDto {
  @IsEnum(OrderGroupingDimension)
  field!: OrderGroupingDimension;

  @IsEnum(OrderFilterOperator)
  operator!: OrderFilterOperator;

  @IsDefined()
  value!: unknown;
}
