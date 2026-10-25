import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderFilterDto } from './order-filter.dto.js';
import { OrderOriginSelectionDto } from './order-origin-selection.dto.js';
import { OrderGroupingDimension } from '../order-grouping-dimension.js';

export class GroupOrdersRequestDto extends OrderOriginSelectionDto {
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

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  groupIds!: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  findNodes: string[] = [];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  excludeNodes: string[] = [];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  excludeGroups: string[] = [];
}
