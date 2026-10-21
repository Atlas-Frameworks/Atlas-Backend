import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
} from '@nestjs/common';
import { EntityRegistry } from '../entities/entity-registry.js';
import { validateFilter } from './validate-filter.js';
import { ViewRegistry } from './view-registry.js';

export interface OpenViewBody {
  entityType: unknown;
  filter: unknown;
}

export interface OpenViewResponse {
  viewKey: string;
  seq: number;
  total: number;
  ids: string[];
}

/** REST + SSE debug gateway for testing views from Postman. */
@Controller('views')
export class ViewsController {
  constructor(
    private readonly registry: ViewRegistry,
    private readonly entities: EntityRegistry,
  ) {}

  /** Opens a query, or joins the existing view for the same query. */
  @Post()
  @HttpCode(200)
  open(@Body() body: OpenViewBody | undefined): OpenViewResponse {
    const result = validateFilter(
      this.entities,
      body?.entityType,
      body?.filter,
    );
    if (!result.ok) {
      throw new BadRequestException({
        code: 'INVALID_FILTER',
        message: result.message,
      });
    }
    const view = this.registry.open(body!.entityType as string, result.filter);
    return {
      viewKey: view.viewKey,
      seq: view.seq,
      total: view.ids.size,
      ids: [...view.ids],
    };
  }
}
