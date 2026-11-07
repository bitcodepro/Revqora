import { api, errorMessage } from "./api";
import { authorPreferencesKey, authorScope, matchesPrAuthor, restoreAuthorPreferences, type PrAuthor } from "./prAuthors";
import { safeWebUrl } from "./prCenter";
import { useSettings, type PullRequestWatch } from "./settings";
import { useRepos } from "./store";
import type { PrPage, PrReviewComment, PullRequest } from "./types";
import { useUi } from "./ui";

export const EMPTY_PR_WATCH: PullRequestWatch = { mineSince: null, selected: {} };
export const PR_PAGE_REFRESHED = "revqora:pr-page-refreshed";
export type PrPageRefresh = { root: string; page: PrPage; readId: number };
let prListReadId = 0;
// Order reads at initiation, including polls started before PR Center mounted.
export const nextPrListRead = () => ++prListReadId;

export function updatePrWatch(root: string, scope: string, update: (watch: PullRequestWatch) => PullRequestWatch) {
  useSettings.setState(state => {
    const scopes = { ...state.prWatches[root] };
    const next = update(scopes[scope] ?? EMPTY_PR_WATCH);
    if (next.mineSince || Object.keys(next.selected).length) scopes[scope] = next;
    else delete scopes[scope];
    const prWatches = { ...state.prWatches };
    if (Object.keys(scopes).length) prWatches[root] = scopes;
    else delete prWatches[root];
    return { prWatches };
  });
}

export function viewerAuthor(viewer: PrPage["viewer"]): PrAuthor | null {
  if (!viewer?.id && !viewer?.login) return null;
  return {
    key: viewer.id ? `id:${viewer.id}` : `login:${viewer.login.toLowerCase()}`,
    label: viewer.login,
    login: viewer.login,
  };
}

function myAuthor(root: string, scope: string, viewer: PrPage["viewer"]) {
  const verified = viewerAuthor(viewer);
  if (verified) return verified;
  try {
    const saved = localStorage.getItem(authorPreferencesKey(root, scope));
    return restoreAuthorPreferences(JSON.parse(saved ?? "null")).mine;
  } catch {
    return null;
  }
}

/** A display name alone cannot prove that the sender is another account. */
export function isOtherComment(comment: PrReviewComment, me: PrAuthor | null) {
  if (!me) return false;
  const login = comment.authorLogin?.toLowerCase();
  const ownLogin = me.login.toLowerCase();
  if (login && ownLogin && login === ownLogin) return false;
  if (comment.authorId && me.key.startsWith("id:")) return `id:${comment.authorId}` !== me.key;
  return !!(login && ownLogin);
}

type ActivityKind = "approved" | "changes requested" | "comment";
type Activity = { kind: ActivityKind; author: string };
type Snapshot = Map<string, Activity>;

export function reviewActivity(comment: PrReviewComment, feed: string, me: PrAuthor | null): Activity | null {
  if (!comment.id || comment.deleted) return null;
  const state = comment.state.trim().toUpperCase().replaceAll("_", " ");
  if (feed === "reviews") {
    if (["APPROVED", "VOTE 5", "VOTE 10"].includes(state)) return { kind: "approved", author: comment.author };
    if (["CHANGES REQUESTED", "REQUEST CHANGES", "NEEDS WORK", "REJECTED", "VOTE -5", "VOTE -10"].includes(state)) {
      return { kind: "changes requested", author: comment.author };
    }
    if (state !== "COMMENTED") return null;
  }
  if (["SYSTEM", "PENDING", "DELETED"].includes(state) || !comment.body.trim() || !isOtherComment(comment, me)) return null;
  return { kind: "comment", author: comment.author };
}

export function newReviewActivity(previous: Snapshot | undefined, fresh: Snapshot): Activity[] {
  if (!previous) return [];
  return [...fresh].filter(([id, event]) => previous.get(id)?.kind !== event.kind).map(([, event]) => event);
}

const MAX_PAGES = 40;
const MAX_ACTIVITY_ITEMS = 20_000;
async function visitPages<T extends { nextCursor: string | null }>(
  read: (cursor: string | null) => Promise<T>,
  current: () => boolean,
  visit: (page: T) => void | Promise<void>,
  start: string | null = null,
) {
  let cursor = start;
  for (let i = 0; i < MAX_PAGES && current(); i++) {
    const page = await read(cursor);
    if (!current()) return false;
    await visit(page);
    if (!current()) return false;
    if (!page.nextCursor) return true;
    if (page.nextCursor === cursor) throw Error("The provider returned the same activity page twice.");
    cursor = page.nextCursor;
  }
  if (!current()) return false;
  throw Error("This pull request or list exceeds the background page limit.");
}

const baselines = new Map<string, Snapshot>();
const failures = new Set<string>();
let connectionGeneration = 0;
export function resetPullRequestActivity() {
  connectionGeneration++;
  baselines.clear();
  failures.clear();
}

function warnOnce(key: string, title: string, error: unknown) {
  if (failures.has(key)) return;
  failures.add(key);
  useUi.getState().toast({ kind: "warning", title, detail: errorMessage(error) });
}

function notify(pull: PullRequest, events: Activity[]) {
  const comments = events.filter(event => event.kind === "comment").length;
  const decisions = events.filter(event => event.kind !== "comment").map(event => `${event.author || "Reviewer"}: ${event.kind}`);
  if (comments) decisions.push(`${comments} new ${comments === 1 ? "comment" : "comments"}`);
  const url = safeWebUrl(pull.url);
  useUi.getState().toast({
    kind: "info",
    title: `#${pull.number} · ${pull.title}`,
    detail: decisions.join(" · "),
    action: url ? { label: "Open PR", run: () => { void api.openPath(url); } } : undefined,
  }, 0);
}

async function checkRequest(root: string, number: number, page: PrPage, me: PrAuthor | null, key: string, live: Set<string>, current: () => boolean) {
  const connection = page.forge.connectionRevision!;
  const detail = await api.prDetail(root, number, connection);
  if (!current()) return;
  const feeds = page.forge.kind === "github" ? ["comments", "reviews", "threads"] : ["reviews", "threads"];
  const snapshots = new Map<string, Snapshot>();
  for (const feed of feeds) {
    const feedKey = JSON.stringify([key, feed]);
    live.add(feedKey);
    if (!current()) return;
    try {
      const snapshot: Snapshot = new Map();
      const complete = await visitPages(cursor => api.prReviewPage(root, number, connection, detail.revision, feed, cursor), current, async result => {
        for (const thread of result.items) {
          if (!current()) return;
          const completeThread = page.forge.kind === "github" && feed === "threads" && !thread.complete
            ? await api.prReviewThread(root, number, connection, detail.revision, thread.id)
            : thread;
          for (const comment of completeThread.comments) {
            const activity = reviewActivity(comment, feed, me);
            if (activity) snapshot.set(JSON.stringify([thread.id, comment.id]), activity);
            if (snapshot.size > MAX_ACTIVITY_ITEMS) throw Error("This pull request exceeds the background activity limit.");
          }
        }
      });
      if (!complete) return;
      snapshots.set(feedKey, snapshot);
      failures.delete(feedKey);
    } catch (error) {
      if (current()) warnOnce(feedKey, `Could not check ${feed} on watched PR #${number}`, error);
    }
  }
  if (!current()) return;
  const changes: Activity[] = [];
  for (const [feedKey, snapshot] of snapshots) {
    changes.push(...newReviewActivity(baselines.get(feedKey), snapshot));
    baselines.set(feedKey, snapshot);
  }
  if (changes.length) notify(detail.pull, changes);
}

/** One request at a time across repositories and watches. No PR mutations. */
export async function checkPullRequestActivity(running: () => boolean) {
  const generation = connectionGeneration;
  const current = () => running() && generation === connectionGeneration;
  const { order, active } = useRepos.getState();
  const roots = new Set(active ? [active, ...order] : order);
  const watches = useSettings.getState().prWatches;
  const live = new Set<string>();
  let complete = true;
  for (const root of roots) {
    if (!current()) return;
    const tab = useRepos.getState().tabs[root];
    const visible = root === useRepos.getState().active && tab?.view === "pulls";
    if (!tab?.info || (!watches[root] && !visible)) continue;
    const stillOpen = () => current() && !!useRepos.getState().tabs[root];
    try {
      const readId = nextPrListRead();
      const page = await api.prPage(root, "open");
      if (!stillOpen()) continue;
      failures.delete(root);
      window.dispatchEvent(new CustomEvent<PrPageRefresh>(PR_PAGE_REFRESHED, { detail: { root, page, readId } }));
      const scope = authorScope(page.forge, page.viewer);
      const watch = watches[root]?.[scope];
      if (!watch || !page.forge.connectionRevision) continue;
      const me = myAuthor(root, scope, page.viewer);
      const selected = new Map(Object.entries(watch.selected).map(([number, since]) => [Number(number), since]));
      if (watch.mineSince && me) {
        const since = watch.mineSince;
        const addMine = (p: PrPage) => {
          for (const pull of p.items) if (matchesPrAuthor(pull, me) && !selected.has(pull.number)) selected.set(pull.number, since);
        };
        addMine(page);
        if (page.nextCursor) {
          await visitPages(cursor => api.prPage(root, "open", cursor), stillOpen, addMine, page.nextCursor);
        }
      }
      for (const [number, since] of selected) {
        if (!stillOpen()) break;
        const key = JSON.stringify([root, scope, number, since, me?.key]);
        try {
          await checkRequest(root, number, page, me, key, live, stillOpen);
          failures.delete(key);
        } catch (error) {
          complete = false;
          if (stillOpen()) warnOnce(key, `Could not check watched PR #${number}`, error);
        }
      }
    } catch (error) {
      complete = false;
      if (stillOpen() && watches[root]) warnOnce(root, "Could not check watched pull requests", error);
    }
  }
  if (current() && complete) for (const key of baselines.keys()) if (!live.has(key)) baselines.delete(key);
}
