import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorScope } from "./prAuthors";
import { checkPullRequestActivity, resetPullRequestActivity, reviewActivity, updatePrWatch } from "./prTracking";
import type { ForgeInfo, PrPage, PrReviewComment, PullRequest } from "./types";

const mocks = vi.hoisted(() => ({
  prPage: vi.fn(), prDetail: vi.fn(), prReviewPage: vi.fn(), toast: vi.fn(),
  repositories: { active: "repo", order: ["repo"], tabs: { repo: { info: {}, view: "history" } } },
  settings: { prWatches: {} as Record<string, unknown> },
}));
vi.mock("./api", () => ({ api: mocks, errorMessage: String }));
vi.mock("./store", () => ({ useRepos: { getState: () => mocks.repositories } }));
vi.mock("./settings", () => ({
  useSettings: {
    getState: () => mocks.settings,
    setState: (update: (state: typeof mocks.settings) => typeof mocks.settings) => Object.assign(mocks.settings, update(mocks.settings)),
  },
}));
vi.mock("./ui", () => ({ useUi: { getState: () => ({ toast: mocks.toast }) } }));

const forge = { kind: "github", api: "https://api.example.invalid", project: "team/repo", remote: "origin", accountId: "profile", connectionRevision: "connection" } as ForgeInfo;
const viewer = { id: "13", login: "me" };
const scope = authorScope(forge, viewer);
const pull = (number: number, authorId = "13") => ({ number, authorId, title: `PR ${number}`, url: `https://example.invalid/${number}` }) as PullRequest;
const page = (items: PullRequest[], nextCursor: string | null = null): PrPage => ({ items, forge, viewer, nextCursor });
const comment = (id: string, authorId = "99", state = ""): PrReviewComment => ({
  id, authorId, author: "Reviewer", body: "Review text", created: "", state,
});
const feedPage = (comments: PrReviewComment[]) => ({ items: [{ id: "thread", comments, complete: true }], nextCursor: null });
const watch = (numbers: number[], mineSince: number | null = null) => {
  updatePrWatch("repo", scope, () => ({ mineSince, selected: Object.fromEntries(numbers.map(n => [n, 1])) }));
};

beforeEach(() => {
  vi.resetAllMocks();
  resetPullRequestActivity();
  mocks.settings.prWatches = {};
  vi.stubGlobal("window", new EventTarget());
  mocks.prPage.mockResolvedValue(page([pull(1)]));
  mocks.prDetail.mockImplementation(async (_root, n) => ({ pull: pull(n), revision: "revision" }));
  mocks.prReviewPage.mockResolvedValue(feedPage([]));
});
afterEach(() => vi.unstubAllGlobals());

describe("PR background activity", () => {
  it("tracks explicitly selected requests and Mine across pages without re-reading a duplicate watch", async () => {
    watch([1, 2], 1);
    mocks.prPage.mockImplementation(async (_root, _state, cursor) => cursor
      ? page([pull(3), pull(4, "99")])
      : page([pull(1), pull(2, "99")], "next"));
    await checkPullRequestActivity(() => true);
    expect(mocks.prPage.mock.calls.map(([, , cursor]) => cursor)).toEqual([undefined, "next"]);
    expect(mocks.prDetail.mock.calls.map(([, n]) => n)).toEqual([1, 2, 3]);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("skips saved PR watches from repositories outside the open session", async () => {
    watch([1]);
    updatePrWatch("closed-workspace-repo", scope, () => ({ mineSince: 1, selected: { 2: 1 } }));
    await checkPullRequestActivity(() => true);
    expect(mocks.prPage).toHaveBeenCalledExactlyOnceWith("repo", "open");
    expect(mocks.prDetail).toHaveBeenCalledExactlyOnceWith("repo", 1, "connection");
  });

  it("reports new feedback once in History and ignores own comments despite a failed inline feed", async () => {
    watch([1]);
    let incoming = false;
    mocks.prReviewPage.mockImplementation(async (_root, _n, _connection, _revision, feed) => {
      if (feed === "threads") throw new Error("GraphQL permission denied");
      if (feed === "comments") return feedPage([
        comment("old"),
        ...(incoming ? [comment("new"), comment("own", "13")] : []),
      ]);
      return feedPage(incoming ? [comment("approve", "99", "APPROVED"), comment("reject", "23", "CHANGES_REQUESTED")] : []);
    });
    await checkPullRequestActivity(() => true);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast.mock.calls[0][0].kind).toBe("warning");
    incoming = true;
    await checkPullRequestActivity(() => true);
    await checkPullRequestActivity(() => true);
    expect(mocks.toast).toHaveBeenCalledTimes(2);
    expect(mocks.toast.mock.calls[1][0]).toMatchObject({
      kind: "info", title: "#1 · PR 1", detail: "Reviewer: approved · Reviewer: changes requested · 1 new comment",
    });
  });

  it("ignores a response after polling is disabled and retains the baseline for the next sweep", async () => {
    watch([1]);
    await checkPullRequestActivity(() => true);
    let running = true;
    let release!: (page: ReturnType<typeof feedPage>) => void;
    const held = new Promise<ReturnType<typeof feedPage>>(resolve => { release = resolve; });
    mocks.prReviewPage.mockReturnValueOnce(held);
    const check = checkPullRequestActivity(() => running);
    await vi.waitFor(() => expect(mocks.prReviewPage).toHaveBeenCalledTimes(4));
    running = false;
    release(feedPage([comment("arrived")]));
    await check;
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.prReviewPage).toHaveBeenCalledTimes(4);
    mocks.prReviewPage.mockResolvedValueOnce(feedPage([comment("arrived")]));
    await checkPullRequestActivity(() => true);
    expect(mocks.toast).toHaveBeenCalledOnce();
  });

  it("uses verified identities for comments and filters draft, system and deleted messages", () => {
    const me = { key: "id:13", label: "Me", login: "me" };
    expect(reviewActivity({ ...comment("self"), authorId: "", authorLogin: "ME" }, "threads", me)).toBeNull();
    expect(reviewActivity({ ...comment("unknown"), authorId: "" }, "threads", me)).toBeNull();
    expect(reviewActivity(comment("pending", "99", "PENDING"), "threads", me)).toBeNull();
    expect(reviewActivity(comment("system", "99", "system"), "threads", me)).toBeNull();
    expect(reviewActivity({ ...comment("deleted"), deleted: true }, "threads", me)).toBeNull();
    expect(reviewActivity(comment("mine"), "threads", null)).toBeNull();
    expect(reviewActivity({ ...comment("graph"), authorId: "", authorLogin: "other" }, "threads", me)?.kind).toBe("comment");
    expect(reviewActivity(comment("azure", "99", "vote -5"), "reviews", me)?.kind).toBe("changes requested");
  });
});
