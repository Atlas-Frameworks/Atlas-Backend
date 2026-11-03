import { Type } from 'class-transformer';
import { IsInt, IsObject, Max, Min } from 'class-validator';

export class GroupPaginationDto {
  @IsObject()
  path!: Record<string, unknown>;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  offset!: number;
}
