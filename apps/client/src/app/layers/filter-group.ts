import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { RegistryField } from './registry';
import { MAX_GROUP_DEPTH, OP_LABELS, emptyGroup, newCondition, valueEditor } from './filter-model';
import type { ConditionDraft, FilterDraft, GroupDraft } from './filter-model';

/** Text of an input/select change event. */
export function eventValue(event: Event): string {
  const t = event.target;
  return t instanceof HTMLInputElement || t instanceof HTMLSelectElement ? t.value : '';
}

/**
 * One and/or group of the filter builder; nested groups render this component again. The draft is
 * immutable: every edit emits a new group upward.
 */
@Component({
  selector: 'app-filter-group',
  template: `
    @let g = group();
    <div class="head">
      <select aria-label="Match" [value]="g.join" (change)="setJoin(event($event))">
        <option value="and">All of</option>
        <option value="or">Any of</option>
      </select>
      <span class="spacer"></span>
      <button type="button" class="link" (click)="addCondition()">+ condition</button>
      @if (depth() < maxGroupDepth) {
        <button type="button" class="link" (click)="addGroup()">+ group</button>
      }
      @if (depth() > 1) {
        <button type="button" class="link" aria-label="Remove group" (click)="remove.emit()">
          ×
        </button>
      }
    </div>
    @if (issues().get(g.id); as issue) {
      <p class="error">{{ issue }}</p>
    }
    @for (child of g.children; track child.id; let i = $index) {
      @if (child.kind === 'group') {
        <app-filter-group
          class="nested"
          [group]="child"
          [fields]="fields()"
          [depth]="depth() + 1"
          [issues]="issues()"
          (groupChange)="replace(i, $event)"
          (remove)="removeAt(i)"
        />
      } @else {
        @let field = fieldOf(child);
        @let editor = editorOf(child);
        <div class="cond">
          <select aria-label="Field" [value]="child.field" (change)="setField(i, event($event))">
            @for (f of fields(); track f.name) {
              <option [value]="f.name">{{ f.label }}</option>
            }
          </select>
          <select aria-label="Operator" [value]="child.op" (change)="setOp(i, event($event))">
            @for (op of field?.ops ?? []; track op) {
              <option [value]="op">{{ opLabels[op] }}</option>
            }
          </select>
          <button type="button" class="link" aria-label="Remove condition" (click)="removeAt(i)">
            ×
          </button>
          @switch (editor) {
            @case ('single') {
              <input
                class="val"
                aria-label="Value"
                [type]="field?.type === 'number' ? 'number' : 'text'"
                [value]="child.value"
                (input)="patch(i, { value: event($event) })"
              />
            }
            @case ('list') {
              <input
                class="val"
                aria-label="Values, comma-separated"
                placeholder="a, b, c"
                [value]="child.value"
                (input)="patch(i, { value: event($event) })"
              />
            }
            @case ('range') {
              <span class="val range">
                <input
                  type="number"
                  aria-label="From"
                  [value]="child.value"
                  (input)="patch(i, { value: event($event) })"
                />
                <input
                  type="number"
                  aria-label="To"
                  [value]="child.to"
                  (input)="patch(i, { to: event($event) })"
                />
              </span>
            }
            @case ('enum') {
              <select
                class="val"
                aria-label="Value"
                [value]="child.value"
                (change)="patch(i, { value: event($event) })"
              >
                <option value="">—</option>
                @for (v of field?.values ?? []; track v) {
                  <option [value]="v">{{ v }}</option>
                }
              </select>
            }
            @case ('boolean') {
              <select
                class="val"
                aria-label="Value"
                [value]="child.value"
                (change)="patch(i, { value: event($event) })"
              >
                <option value="">—</option>
                <option value="true">yes</option>
                <option value="false">no</option>
              </select>
            }
            @case ('enum-list') {
              <span class="val chips">
                @for (v of field?.values ?? []; track v) {
                  <label
                    ><input
                      type="checkbox"
                      [checked]="child.values.includes(v)"
                      (change)="toggle(i, v)"
                    />{{ v }}</label
                  >
                }
              </span>
            }
          }
          @if (issues().get(child.id); as issue) {
            <p class="error val">{{ issue }}</p>
          }
        </div>
      }
    } @empty {
      @if (depth() === 1) {
        <p class="muted">No conditions: every entity in scope.</p>
      }
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--atlas-space-2);
    }
    :host(.nested) {
      padding-left: var(--atlas-space-2);
      border-left: 2px solid var(--atlas-border);
    }
    .head,
    .cond {
      display: flex;
      flex-wrap: wrap;
      gap: var(--atlas-space-1);
      align-items: center;
    }
    .spacer {
      flex: 1;
    }
    .cond select {
      flex: 1;
      min-width: 0;
    }
    .val {
      flex: 1 0 100%;
      min-width: 0;
    }
    .range {
      display: flex;
      gap: var(--atlas-space-1);
      input {
        flex: 1;
        min-width: 0;
      }
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--atlas-space-1) var(--atlas-space-2);
      font-size: var(--atlas-font-sm);
    }
    p {
      margin: 0;
      font-size: var(--atlas-font-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FilterGroup {
  readonly group = input.required<GroupDraft>();
  readonly fields = input.required<readonly RegistryField[]>();
  /** The root group is depth 1 (contracts §5 counts the root). */
  readonly depth = input(1);
  /** Validation messages by draft node id. */
  readonly issues = input<ReadonlyMap<number, string>>(new Map());
  readonly groupChange = output<GroupDraft>();
  readonly remove = output();

  protected readonly maxGroupDepth = MAX_GROUP_DEPTH;
  protected readonly opLabels = OP_LABELS;
  protected readonly event = eventValue;
  private readonly byName = computed(() => new Map(this.fields().map((f) => [f.name, f])));

  protected fieldOf(c: ConditionDraft): RegistryField | undefined {
    return this.byName().get(c.field);
  }

  protected editorOf(c: ConditionDraft) {
    return valueEditor(this.fieldOf(c), c.op);
  }

  protected setJoin(join: string): void {
    this.emit({ ...this.group(), join: join === 'or' ? 'or' : 'and' });
  }

  protected addCondition(): void {
    this.setChildren([...this.group().children, newCondition(this.fields()[0])]);
  }

  protected addGroup(): void {
    const g = emptyGroup(this.group().join === 'and' ? 'or' : 'and');
    this.setChildren([
      ...this.group().children,
      { ...g, children: [newCondition(this.fields()[0])] },
    ]);
  }

  protected replace(index: number, child: FilterDraft): void {
    this.setChildren(this.group().children.map((c, i) => (i === index ? child : c)));
  }

  protected removeAt(index: number): void {
    this.setChildren(this.group().children.filter((_, i) => i !== index));
  }

  protected setField(index: number, name: string): void {
    const c = this.condition(index);
    const fresh = newCondition(this.byName().get(name));
    if (c) this.replace(index, { ...fresh, id: c.id });
  }

  protected setOp(index: number, op: string): void {
    const c = this.condition(index);
    const field = c && this.fieldOf(c);
    const next = field?.ops.find((o) => o === op);
    if (!c || !next) return;
    // Keep what was typed when the editor stays the same; reset it otherwise.
    const same = valueEditor(field, next) === valueEditor(field, c.op);
    this.replace(
      index,
      same ? { ...c, op: next } : { ...c, op: next, value: '', to: '', values: [] },
    );
  }

  protected patch(index: number, change: Partial<Pick<ConditionDraft, 'value' | 'to'>>): void {
    const c = this.condition(index);
    if (c) this.replace(index, { ...c, ...change });
  }

  protected toggle(index: number, value: string): void {
    const c = this.condition(index);
    if (!c) return;
    const values = c.values.includes(value)
      ? c.values.filter((v) => v !== value)
      : [...c.values, value];
    this.replace(index, { ...c, values });
  }

  private condition(index: number): ConditionDraft | undefined {
    const c = this.group().children[index];
    return c?.kind === 'condition' ? c : undefined;
  }

  private setChildren(children: FilterDraft[]): void {
    this.emit({ ...this.group(), children });
  }

  private emit(group: GroupDraft): void {
    this.groupChange.emit(group);
  }
}
