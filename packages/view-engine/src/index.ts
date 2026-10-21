/**
 * @atlas/view-engine
 *
 * Pure logic, no network or database access, so every part is unit-testable.
 * Modules are added by these tasks (see docs/tasks/snir/04-view-engine.md):
 *
 * - registry/     E-01  field registry + filter tree types, validation, normalization, view key
 * - compiler/     E-02  filter tree -> parameterized SQL (full build, batched re-check, page/detail fetch)
 * - dependencies/ E-03  change event -> candidate views (reverse index)
 * - store/        E-04  typed-array membership store, sorted index, group counts, page windows
 * - tick/         E-05  per-tick diffing, version dedupe, sequence-gap and dirty-ID tracking
 * - cluster/      E-06  rendezvous hashing, membership epoch, flap damping
 */
export {};
