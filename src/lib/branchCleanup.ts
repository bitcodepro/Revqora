import type { BranchCleanupReview, DeletionPlan } from "./types";

type SelectedItem = BranchCleanupReview["items"][number] & { plan: DeletionPlan };

// Keep decisions belong to branch references, not positions in an asynchronous
// review. Validity can remove a row; it must never erase an explicit exclusion.
export function selectedCleanupItems(review: BranchCleanupReview | null, excluded: ReadonlySet<string>): SelectedItem[] {
  return review?.items.filter((item): item is SelectedItem => !!item.plan && !item.error && !excluded.has(item.request.reference)) ?? [];
}
