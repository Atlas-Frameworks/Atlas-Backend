import { Injectable } from '@nestjs/common';
import type { ChangeEvent } from '../changes/change-event.js';
import type { Dependency } from './define-query.js';
import type { Match } from './match.js';
import type { Sql } from './sql.js';

// Local stand-in for DependencyIndex from @atlas/view-engine (E-03), built from
// the dependencies each query declares instead of a field registry.

/**
 * How a change can affect a view:
 * - `filter`: it can add or remove rows, so ids the view doesn't hold matter too;
 * - `shown`: only the rows the view already holds can change.
 */
export type Level = 'filter' | 'shown';

/** A view of the event's own type. */
export interface OwnCandidate {
  viewKey: string;
  level: Level;
  /** The view's exact-match conditions on its own type, if any. */
  match?: Match;
}

/** A view that depends on the event's type as a related type. */
export interface LinkedCandidate {
  viewKey: string;
  level: Level;
  /** Finds the view's ids linked to changed ids, for `filter` changes. */
  link: (ids: string[]) => Sql;
  /** The view's column holding this type's id, to find held rows from memory. */
  via?: string;
}

/** The views one change event may affect. */
export interface Candidates {
  /** Views of the event's own type: re-check the event's id (or remove it on delete). */
  own: OwnCandidate[];
  /** Views of another type: re-check the held rows that show it, and for `filter`, run `link`. */
  linked: LinkedCandidate[];
}

interface Entry {
  entityType: string;
  dependsOn: Record<string, Dependency>;
  match?: Match;
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

  /**
   * Registers a view's dependencies, and its exact-match conditions on its
   * own type. Its own type is always included.
   */
  add(
    viewKey: string,
    entityType: string,
    dependsOn: Record<string, Dependency>,
    match?: Match,
  ): void {
    if (this.views.has(viewKey)) {
      return;
    }
    const deps = { [entityType]: {}, ...dependsOn };
    this.views.set(viewKey, { entityType, dependsOn: deps, match });
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
   * The views this event may affect, and how. False positives are fine, a
   * missed view is not, so a delete, an insert or a field in neither list of
   * a dependency without `filter` counts as a filter change.
   */
  candidates(evt: ChangeEvent): Candidates {
    const result: Candidates = { own: [], linked: [] };
    const views = this.byType.get(evt.type);
    if (!views) {
      return result;
    }
    for (const [viewKey, dep] of views) {
      const entry = this.views.get(viewKey)!;
      const level = levelOf(evt, dep);
      if (level === undefined) {
        continue;
      }
      if (entry.entityType === evt.type) {
        result.own.push(
          entry.match
            ? { viewKey, level, match: entry.match }
            : { viewKey, level },
        );
      } else {
        result.linked.push({ viewKey, level, link: dep.link!, via: dep.via });
      }
    }
    return result;
  }

  /** Every view that depends on this type, its own or a related one. */
  viewsOf(type: string): string[] {
    return [...(this.byType.get(type)?.keys() ?? [])];
  }

  /** Entity types that at least one view depends on: the streams to read. */
  watchedTypes(): string[] {
    return [...this.byType.keys()];
  }

  dependenciesOf(viewKey: string): Record<string, Dependency> | undefined {
    return this.views.get(viewKey)?.dependsOn;
  }

  matchOf(viewKey: string): Match | undefined {
    return this.views.get(viewKey)?.match;
  }
}

/** How the event affects a view with this dependency, or undefined if it can't. */
function levelOf(evt: ChangeEvent, dep: Dependency): Level | undefined {
  if (evt.op === 'delete' || !evt.changes) {
    return 'filter';
  }
  const { old: before, new: after } = evt.changes;
  const isInsert =
    Object.keys(before).length === 0 && Object.keys(after).length > 0;
  if (isInsert) {
    return 'filter';
  }
  const changed = Object.keys({ ...before, ...after });
  const shown = dep.shown ?? [];
  if (dep.filter === undefined) {
    // Undeclared: every field not shown may be filtered on.
    if (changed.length === 0 || changed.some((f) => !shown.includes(f))) {
      return 'filter';
    }
    return 'shown';
  }
  if (changed.some((f) => dep.filter!.includes(f))) {
    return 'filter';
  }
  if (changed.some((f) => shown.includes(f))) {
    return 'shown';
  }
  return undefined;
}
