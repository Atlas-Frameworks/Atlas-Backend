import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { ValidateNested } from 'class-validator';
import { OrderFilterDto } from './order-filter.dto.js';
import { OrderOriginSelectionDto } from './order-origin-selection.dto.js';
import { OrderGroupingDimension } from '../order-grouping-dimension.js';

export class OrderGroupsRequestDto extends OrderOriginSelectionDto {
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsEnum(OrderGroupingDimension, { each: true })
  groupBy!: OrderGroupingDimension[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OrderFilterDto)
  filters: OrderFilterDto[] = [];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  defaultLimit = 10;

  @IsOptional()
  @IsObject()
  pagination?: Record<string, unknown>;
}
