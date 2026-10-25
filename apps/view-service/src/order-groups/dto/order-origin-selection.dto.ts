import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsUUID,
} from 'class-validator';

const maximumOriginIds = 10_000;

export class OrderOriginSelectionDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(maximumOriginIds)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  wCampaignIds: string[] = [];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(maximumOriginIds)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  wMissionIds: string[] = [];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(maximumOriginIds)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  wPlanIds: string[] = [];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(maximumOriginIds)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  aPlanIds: string[] = [];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(maximumOriginIds)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  aMissionIds: string[] = [];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(maximumOriginIds)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  aObjectiveIds: string[] = [];
}
