import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { ValidateNested } from 'class-validator';
import { OrderFilterDto } from './order-filter.dto.js';
import { GroupPaginationDto } from './group-pagination.dto.js';
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
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => GroupPaginationDto)
  pagination: GroupPaginationDto[] = [];
}
