import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { queryKey, type QueryDefinition } from './define-query.js';
import { toStatement } from './sql.js';
import { ViewLoader } from './view-loader.js';
import { ViewRegistry } from './view-registry.js';

/** What a route returns after opening a view. */
export interface ViewSnapshot {
  viewKey: string;
  seq: number;
  total: number;
  ids: string[];
}

/** Opens views for any route. Routes never see the registry or the loader. */
@Injectable()
export class ViewService {
  private readonly logger = new Logger(ViewService.name);

  constructor(
    private readonly registry: ViewRegistry,
    private readonly loader: ViewLoader,
  ) {}

  /**
   * Opens the view for a query and its params, or joins the existing one.
   * Undefined params don't change the viewKey and are left to `build` to skip.
   */
  async open<P>(query: QueryDefinition<P>, params: P): Promise<ViewSnapshot> {
    const view = this.registry.open(
      queryKey(query.name, params),
      query.entityType,
      toStatement(query.build(params)),
    );
    try {
      await this.loader.ensureLoaded(view);
    } catch (err) {
      this.registry.release(view.viewKey);
      this.logger.error(`loading view ${view.viewKey} failed`, err);
      throw new ServiceUnavailableException({
        code: 'RETRY',
        message: 'could not load the view, try again',
      });
    }
    return {
      viewKey: view.viewKey,
      seq: view.seq,
      total: view.ids.size,
      ids: [...view.ids.keys()],
    };
  }
}
