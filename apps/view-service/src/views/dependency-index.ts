import { Injectable } from '@nestjs/common';
import type { ChangeEvent } from '../changes/change-event.js';
import type { Dependency } from './define-query.js';
import type { Sql } from './sql.js';

// Local stand-in for DependencyIndex from @atlas/view-engine (E-03), built from
// the dependencies each query declares instead of a field registry.

/** A view that depends on a related type, with the SQL that finds its own ids. */
export interface LinkedCandidate {
  viewKey: string;
  link: (ids: string[]) => Sql;
}

/** The views one change event may affect. */
export interface Candidates {
  /** Views of the event's own type: re-check the event's id (or remove it on delete). */
  own: string[];
  /** Views of another type: run `link([evt.id])`, then re-check the ids it returns. */
  linked: LinkedCandidate[];
}

interface Entry {
  entityType: string;
  dependsOn: Record<string, Dependency>;
}

/**
 * Which views depend on which entity types and fields. A view is
 * registered when it opens, so a change that arrives while it loads is not missed.
 */
@Injectable()
export class DependencyIndex {
  private readonly views = new Map<string, Entry>();
  /** entity type → viewKey → how that view depends on the type. */
  private readonly byType = new Map<string, Map<string, Dependency>>();

  /** Registers a view's dependencies. Its own type is always included. */
  add(
    viewKey: string,
    entityType: string,
    dependsOn: Record<string, Dependency>,
  ): void {
    if (this.views.has(viewKey)) {
      return;
    }
    const deps = { [entityType]: {}, ...dependsOn };
    this.views.set(viewKey, { entityType, dependsOn: deps });
    for (const [type, dep] of Object.entries(deps)) {
      let views = this.byType.get(type);
      if (!views) {
        views = new Map();
        this.byType.set(type, views);
      }
      views.set(viewKey, dep);
    }
  }

  remove(viewKey: string): void {
    const entry = this.views.get(viewKey);
    if (!entry) {
      return;
    }
    this.views.delete(viewKey);
    for (const type of Object.keys(entry.dependsOn)) {
      const views = this.byType.get(type)!;
      views.delete(viewKey);
      if (views.size === 0) {
        this.byType.delete(type);
      }
    }
  }

  /**
   * The views this event may affect. False positives are fine, a missed
   * view is not, so a delete, an insert or an undeclared field list
   * always counts as a match.
   */
  candidates(evt: ChangeEvent): Candidates {
    const result: Candidates = { own: [], linked: [] };
    const views = this.byType.get(evt.type);
    if (!views) {
      return result;
    }
    for (const [viewKey, dep] of views) {
      const entry = this.views.get(viewKey)!;
      if (!touches(evt, dep)) {
        continue;
      }
      if (entry.entityType === evt.type) {
        result.own.push(viewKey);
      } else {
        result.linked.push({ viewKey, link: dep.link! });
      }
    }
    return result;
  }

  /** Entity types that at least one view depends on: the streams to read. */
  watchedTypes(): string[] {
    return [...this.byType.keys()];
  }

  /** Every view that depends on this type, its own or a related one. */
  viewsOf(type: string): string[] {
    return [...(this.byType.get(type)?.keys() ?? [])];
  }

  dependenciesOf(viewKey: string): Record<string, Dependency> | undefined {
    return this.views.get(viewKey)?.dependsOn;
  }
}

function touches(evt: ChangeEvent, dep: Dependency): boolean {
  if (evt.op === 'delete' || dep.fields === undefined || !evt.changes) {
    return true;
  }
  const { old: before, new: after } = evt.changes;
  const isInsert =
    Object.keys(before).length === 0 && Object.keys(after).length > 0;
  if (isInsert) {
    return true;
  }
  return dep.fields.some((field) => field in before || field in after);
}
