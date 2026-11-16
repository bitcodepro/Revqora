import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { status: vi.fn(), repositoryChangesStatus: vi.fn(), repoInfo: vi.fn(), layersState: vi.fn(), refs: vi.fn(), repoExtras: vi.fn(), squashMerged: vi.fn(), graphLoad: vi.fn(), graphCommitCount: vi.fn(), watchRepo: vi.fn() }, errorMessage: String }));
vi.mock("./settings", () => ({ useSettings: { getState: () => ({ set: vi.fn(), hideIncomingByRepo: {} }) } }));
vi.mock("./repositoryLibrary", async original => ({ ...await original<typeof import("./repositoryLibrary")>(), useLibrary: { getState: () => ({ remember: vi.fn() }) } }));
vi.mock("./ui", () => ({ useUi: { setState: vi.fn() }, toast: { warning: vi.fn() } }));
import { api } from "./api";
import { covers, CURRENT_HISTORY_BRANCH, graphHistoryScope, hasMoreHistory, INITIAL_GRAPH_COMMITS, loadEntireHistory, loadGraph, useRepos, type RepoTab } from "./store";
import { previewGeneration } from "./commitPreview";
import { repositoryCall, type Invoke } from "./operationClient";
import type { RepoInfo, StatusSummary } from "./types";

const root = "/quiet-diff";
const snapshot = (token: string, version: number) => ({ stateToken: token, stateVersion: version, files: [{ path: "selected.txt", diffToken: "same-content", index: ".", worktree: "M" }] }) as StatusSummary;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.status).mockResolvedValue(snapshot("after-wal", 2));
  vi.mocked(api.repoInfo).mockResolvedValue(null as never);
  vi.mocked(api.layersState).mockResolvedValue(null as never);
  vi.mocked(api.repoExtras).mockResolvedValue(null as never);
  useRepos.setState({ order: [root], active: root, tabs: { [root]: { root, status: snapshot("before-wal", 1), graph: {}, graphHasWorktree: true, diffRefreshVersion: 0 } as RepoTab } });
});
describe("background repository observation", () => {
  it("keeps the active section when switching repositories without moving the selected commit", () => {
    const other = "/other";
    const tab = useRepos.getState().tabs[root];
    useRepos.setState({ order: [root, other], tabs: {
      [root]: { ...tab, view: "pulls", selected: "first" },
      [other]: { ...tab, root: other, view: "history", selected: "second" },
    } });
    const repos = useRepos.getState();
    repos.activate(other);
    expect(useRepos.getState().tabs[other]).toMatchObject({ view: "pulls", selected: "second" });
    repos.patch(other, { view: "changes" });
    repos.activate(root);
    expect(useRepos.getState().tabs[root]).toMatchObject({ view: "changes", selected: "first" });
  });
  it("keeps cached history and previews while activation revalidates unchanged local state",async()=>{
    const refs={local:[],remote:[],tags:[],remotes:[]};const info={head:{branch:"main",oid:"a"}} as RepoInfo;
    useRepos.getState().patch(root,{info,refs:refs as never,loaded:true});vi.mocked(api.repoInfo).mockResolvedValue(info);vi.mocked(api.refs).mockResolvedValue(refs as never);
    const generation=previewGeneration(root);await useRepos.getState().refresh(root,{background:true,revalidate:true,info:true,refs:true,status:true});
    expect(api.graphLoad).not.toHaveBeenCalled();expect(previewGeneration(root)).toBe(generation);expect(useRepos.getState().tabs[root].graphLoading).not.toBe(true);
  });
  it("publishes branch information before slow optional layers and extras",async()=>{
    let release!:(value:never)=>void;vi.mocked(api.layersState).mockImplementation(()=>new Promise(resolve=>{release=resolve;}));const info={head:{branch:"topic",oid:"new"}} as RepoInfo;vi.mocked(api.repoInfo).mockResolvedValue(info);
    const pending=useRepos.getState().refresh(root,{background:true,revalidate:true,info:true,status:true,layers:true});
    await vi.waitFor(()=>expect(useRepos.getState().tabs[root].info).toBe(info));release(null as never);await pending;
  });
  it("rebuilds the graph after a detached HEAD update was already observed offscreen",async()=>{
    const refs={local:[],remote:[],tags:[],remotes:[]};const a={head:{branch:null,oid:"a",detached:true}} as RepoInfo;const b={head:{branch:null,oid:"b",detached:true}} as RepoInfo;
    useRepos.getState().patch(root,{info:a,refs:refs as never,graph:{key:"graph-a",headOid:"a",total:1,maxLanes:1,headIndex:0}});
    useRepos.setState({active:"another-repository"});vi.mocked(api.repoInfo).mockResolvedValue(b);vi.mocked(api.refs).mockResolvedValue(refs as never);
    await useRepos.getState().refresh(root,{background:true,info:true});
    expect(useRepos.getState().tabs[root].info).toBe(b);expect(api.graphLoad).not.toHaveBeenCalled();
    vi.mocked(api.graphLoad).mockResolvedValue({key:"graph-b",headOid:"b",total:1,maxLanes:1,headIndex:0});useRepos.setState({active:root});
    await useRepos.getState().refresh(root,{background:true,revalidate:true,info:true,refs:true});
    await vi.waitFor(()=>expect(useRepos.getState().tabs[root].graph?.headOid).toBe("b"));expect(api.graphLoad).toHaveBeenCalledTimes(1);
  });
  it("rebuilds an initial Current branch graph when repo info arrives with a newer HEAD", async () => {
    const store = useRepos.getState();
    const before = { head: { branch: "main", oid: "first" } } as RepoInfo;
    const after = { head: { branch: "other", oid: "second" } } as RepoInfo;
    store.patch(root, { info: before, graph: null, branchFilter: CURRENT_HISTORY_BRANCH, graphVersion: 0 });
    let publishHead!: (info: RepoInfo) => void;
    vi.mocked(api.repoInfo).mockImplementationOnce(() => new Promise(resolve => { publishHead = resolve; }));
    vi.mocked(api.graphLoad)
      .mockResolvedValueOnce({ key: "old-head", total: 2, maxLanes: 1, headIndex: 0 })
      .mockResolvedValueOnce({ key: "new-head", total: 3, maxLanes: 1, headIndex: 0 });

    const refresh = store.refresh(root, { background: true, graph: true, info: true });
    await vi.waitFor(() => expect(useRepos.getState().tabs[root].graph?.key).toBe("old-head"));
    publishHead(after);
    await refresh;

    const tab = useRepos.getState().tabs[root];
    expect(tab.graph?.key).toBe("new-head");
    expect(tab.graphScope).toBe(graphHistoryScope(tab, undefined, true).key);
    expect(api.graphLoad).toHaveBeenCalledTimes(2);
  });
  it("starts a new branch selection beside an obsolete build and publishes only the latest request", async () => {
    let release!: (v: never) => void;
    const first = new Promise<never>(resolve => { release = resolve; });
    vi.mocked(api.graphLoad).mockImplementationOnce(() => first).mockResolvedValue({key:"latest-branch",total:1,maxLanes:1,headIndex:0});
    useRepos.getState().patch(root, {branchFilter:"main",graphVersion:0});
    const old = loadGraph(root);
    await vi.waitFor(() => expect(api.graphLoad).toHaveBeenCalledTimes(1));
    useRepos.getState().patch(root, {branchFilter:"feature"});
    const current = loadGraph(root);
    // The obsolete build is still running: the new selection does not wait for it.
    await current;
    expect(vi.mocked(api.graphLoad).mock.calls.map(args=>args[1])).toEqual(["main","feature"]);
    expect(useRepos.getState().tabs[root]).toMatchObject({graph:{key:"latest-branch"},graphVersion:1,graphLoading:false});
    // The backend orders builds by this number and keeps the newest request's graph.
    const [older,newer]=vi.mocked(api.graphLoad).mock.calls.map(args=>args[7] as number);
    expect(newer).toBeGreaterThan(older);
    release({key:"old-main",total:4,maxLanes:1,headIndex:0} as never);
    await old;
    const tab=useRepos.getState().tabs[root];
    expect(tab.graph?.key).toBe("latest-branch");
    expect(tab.graphVersion).toBe(1);
    expect(tab.graphLoading).toBe(false);
  });
  it("runs at most two history builds per repository and only the newest queued request", async () => {
    const releases: ((v: never) => void)[] = [];
    const held = () => new Promise<never>(resolve => { releases.push(resolve); });
    vi.mocked(api.graphLoad).mockImplementationOnce(held).mockImplementationOnce(held).mockImplementationOnce(held);
    const summary = (key: string) => ({key,total:1,maxLanes:1,headIndex:0}) as never;
    useRepos.getState().patch(root, {branchFilter:"one",graphVersion:0});
    const one = loadGraph(root);
    useRepos.getState().patch(root, {branchFilter:"two"});
    const two = loadGraph(root);
    useRepos.getState().patch(root, {branchFilter:"three"});
    const three = loadGraph(root);
    useRepos.getState().patch(root, {branchFilter:"four"});
    const four = loadGraph(root);
    await Promise.resolve(); await Promise.resolve();
    expect(vi.mocked(api.graphLoad).mock.calls.map(args=>args[1])).toEqual(["one","two"]);
    releases[1](summary("two"));
    await Promise.all([two,three]);
    await vi.waitFor(() => expect(vi.mocked(api.graphLoad).mock.calls.map(args=>args[1])).toEqual(["one","two","four"]));
    expect(useRepos.getState().tabs[root].graph?.key).not.toBe("two");
    releases[2](summary("four")); releases[0](summary("one"));
    await Promise.all([one,four]);
    expect(useRepos.getState().tabs[root]).toMatchObject({graph:{key:"four"},graphVersion:1,graphLoading:false});
    const order=vi.mocked(api.graphLoad).mock.calls.map(args=>args[7] as number);
    expect([...order].sort((a,b)=>a-b)).toEqual(order);
  });
  it("keeps loaded rows and the exact total when the backend returns the same build", async () => {
    vi.mocked(api.graphLoad).mockResolvedValue({key:"graph-7",total:200,maxLanes:1,headIndex:0} as never);
    vi.mocked(api.graphCommitCount).mockResolvedValue(5275);
    useRepos.getState().patch(root, {branchFilter:null,graphVersion:3,graph:null});
    await loadGraph(root, false);
    await vi.waitFor(() => expect(useRepos.getState().tabs[root].graph?.commitCount).toBe(5275));
    expect(useRepos.getState().tabs[root].graphVersion).toBe(4);
    await loadGraph(root, false);
    const same=useRepos.getState().tabs[root];
    expect(same).toMatchObject({graphVersion:4,graphLoading:false,graph:{key:"graph-7",commitCount:5275}});
    expect(api.graphCommitCount).toHaveBeenCalledTimes(1);
    // The same key in another scope or with the working-tree row is a different view.
    await loadGraph(root, true);
    expect(useRepos.getState().tabs[root].graphVersion).toBe(5);
    vi.mocked(api.graphLoad).mockResolvedValue({key:"graph-8",total:200,maxLanes:1,headIndex:0} as never);
    await loadGraph(root, true);
    expect(useRepos.getState().tabs[root]).toMatchObject({graphVersion:6,graph:{key:"graph-8"}});
  });
  it("answers a repository selection from the read that is already running", async () => {
    const refs={local:[],remote:[],tags:[],remotes:[]};const info={head:{branch:"main",oid:"a"}} as RepoInfo;
    useRepos.getState().patch(root,{info,refs:refs as never,loaded:true});vi.mocked(api.repoInfo).mockResolvedValue(info);vi.mocked(api.refs).mockResolvedValue(refs as never);
    let release!:(value:StatusSummary)=>void;vi.mocked(api.status).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    vi.mocked(api.graphLoad).mockResolvedValue({key:"selection",total:1,maxLanes:1,headIndex:0} as never);
    const quiet={background:true,revalidate:true,info:true,status:true,refs:true,layers:true,graph:false};
    const running=useRepos.getState().refresh(root,quiet);
    await vi.waitFor(()=>expect(api.status).toHaveBeenCalledTimes(1));
    const joined=useRepos.getState().refresh(root,quiet);
    // A change notification is new information and still gets its own read.
    release(snapshot("after-wal",2));await Promise.all([running,joined]);
    expect(api.status).toHaveBeenCalledTimes(1);expect(api.refs).toHaveBeenCalledTimes(1);expect(api.layersState).toHaveBeenCalledTimes(1);
    vi.mocked(api.status).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const next=useRepos.getState().refresh(root,quiet);
    await vi.waitFor(()=>expect(api.status).toHaveBeenCalledTimes(2));
    const watcher=useRepos.getState().refresh(root,{background:true,status:true});
    const missingHistory=useRepos.getState().refresh(root,{...quiet,graph:true});
    release(snapshot("after-wal",3));await Promise.all([next,watcher,missingHistory]);
    expect(api.status).toHaveBeenCalledTimes(3);
    // A read that started before the repository was selected again does not answer the
    // selection's check: the check queues its own read.
    vi.mocked(api.status).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const older=useRepos.getState().refresh(root,quiet);
    await vi.waitFor(()=>expect(api.status).toHaveBeenCalledTimes(4));
    useRepos.getState().activate(root);
    release(snapshot("after-wal",4));await older;
    await vi.waitFor(()=>expect(api.status).toHaveBeenCalledTimes(5));
    expect(covers({info:true,status:true,refs:true,layers:true,graph:true},quiet)).toBe(true);
    expect(covers({summary:true,status:true,refs:true},{status:true})).toBe(false);
    expect(covers({changesDisplay:true,status:true},{status:true})).toBe(false);
    expect(covers({status:true},{status:true,refs:true})).toBe(false);
    expect(covers({status:true},{status:true,guard:true})).toBe(false);
    expect(covers(undefined,{status:true})).toBe(false);
  });
  it("loads a bounded history, expands it on demand and starts the next branch with a fresh window", async () => {
    vi.mocked(api.graphLoad).mockImplementation(async (_root, scope, _worktree, limit) => ({
      key: String(scope) + limit, total: limit!, commitCount: 5275, maxLanes: 1, headIndex: 0,
    }));
    const store = useRepos.getState();
    store.patch(root, { branchFilter: "refs/heads/main", graphVersion: 0 });
    await loadGraph(root, false);
    expect(hasMoreHistory(useRepos.getState().tabs[root])).toBe(true);
    await loadGraph(root, false, INITIAL_GRAPH_COMMITS * 2);
    await loadEntireHistory(root);
    expect(hasMoreHistory(useRepos.getState().tabs[root])).toBe(false);
    store.patch(root, { branchFilter: "refs/heads/topic" });
    await loadGraph(root, false);
    expect(vi.mocked(api.graphLoad).mock.calls.map(args => args[3])).toEqual([200, 400, 5275, 200]);
  });
  it("publishes history before the exact count and ignores a count from the previous branch", async () => {
    let countMain!: (count: number) => void;
    let countTopic!: (count: number) => void;
    vi.mocked(api.graphCommitCount)
      .mockImplementationOnce(() => new Promise(resolve => { countMain = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { countTopic = resolve; }));
    vi.mocked(api.graphLoad).mockImplementation(async (_root, scope, _worktree, limit) => ({
      key: String(scope), total: limit!, maxLanes: 1, headIndex: 0,
    }));
    const store = useRepos.getState();
    store.patch(root, { branchFilter: "main", graphVersion: 0 });
    await loadGraph(root, false);
    expect(useRepos.getState().tabs[root].graph).toMatchObject({ key: "main", total: 200 });
    expect(hasMoreHistory(useRepos.getState().tabs[root])).toBe(true);
    store.patch(root, { branchFilter: "topic" });
    await loadGraph(root, false);
    countMain(5275);
    await Promise.resolve();
    expect(useRepos.getState().tabs[root].graph?.commitCount).toBeUndefined();
    countTopic(1200);
    await vi.waitFor(() => expect(useRepos.getState().tabs[root].graph?.commitCount).toBe(1200));
  });
  it("updates the full mutation guard without invalidating previews for ordinary worktree activity", async () => {
    const generation = previewGeneration(root);
    await useRepos.getState().refresh(root, { background: true, status: true, layers: true });
    const tab = useRepos.getState().tabs[root];
    expect(tab.status?.stateToken).toBe("after-wal");
    expect(tab.status?.files[0].diffToken).toBe("same-content");
    expect(previewGeneration(root)).toBe(generation);
    expect(tab.diffRefreshVersion).toBe(0);
  });
  it("refreshes the Changes display for its selected path and drops the old mutation guard", async () => {
    const store = useRepos.getState();
    store.patch(root, { view: "changes", changeSel: { kind: "unstaged", path: "selected.txt", untracked: false } });
    vi.mocked(api.repositoryChangesStatus).mockResolvedValue({ ...snapshot("unused", 2), stateToken: null });
    await store.refresh(root, { background: true, status: true, changesDisplay: true });
    expect(api.repositoryChangesStatus).toHaveBeenCalledExactlyOnceWith(root, "selected.txt");
    expect(api.status).not.toHaveBeenCalled();
    expect(api.repoInfo).not.toHaveBeenCalled();
    expect(useRepos.getState().tabs[root].status).toMatchObject({ stateToken: null, stateVersion: 2 });
  });
  it("keeps the full status for active conflict validation and clean-worktree actions", async () => {
    const store = useRepos.getState();
    const initial = useRepos.getState().tabs[root].status!;
    for (const status of [{ ...initial, stateVersion: 3, conflictCount: 1 }, { ...initial, stateVersion: 4, files: [] }]) {
      store.patch(root, { view: "changes", status });
      await store.refresh(root, { background: true, status: true, changesDisplay: true });
    }
    expect(api.repositoryChangesStatus).not.toHaveBeenCalled();
    expect(api.status).toHaveBeenCalledTimes(2);
  });
  it("shows a failed status read without reusing its previous mutation guard", async () => {
    vi.mocked(api.status).mockRejectedValueOnce(new Error("Open file for status locked.txt (os error 32)"));
    await useRepos.getState().refresh(root, { background: true, status: true });
    const tab = useRepos.getState().tabs[root];
    expect(tab.error).toContain("locked.txt");
    expect(tab.status?.stateToken).toBeNull();
    expect(tab.status?.files[0].path).toBe("selected.txt");
  });
  it("keeps an explicit refresh effective even if the file token did not change", async () => {
    const generation = previewGeneration(root);
    await useRepos.getState().refresh(root, { status: true, layers: true });
    expect(previewGeneration(root)).toBe(generation + 1);
    expect(useRepos.getState().tabs[root].diffRefreshVersion).toBe(1);
  });
  it("still invalidates immutable previews for a metadata/attributes notification", async () => {
    const generation = previewGeneration(root);
    await useRepos.getState().refresh(root, { background: true, info: true, status: true });
    expect(previewGeneration(root)).toBe(generation + 1);
  });
  it("does not let an older observation replace a newer mutation precondition", async () => {
    useRepos.getState().patch(root, { status: snapshot("newer", 3) });
    await useRepos.getState().refresh(root, { background: true, status: true });
    expect(useRepos.getState().tabs[root].status?.stateToken).toBe("newer");
  });
  it("invalidates mounted immutable interpretations when indexed Git attributes change", async () => {
    const before = { ...snapshot("before", 3), diffContextToken: "attributes-one" };
    const after = { ...snapshot("after", 4), diffContextToken: "attributes-two" };
    useRepos.getState().patch(root, { status: before });
    const generation = previewGeneration(root);
    vi.mocked(api.status).mockResolvedValue(after);
    await useRepos.getState().refresh(root, { background: true, status: true, layers: true });
    expect(previewGeneration(root)).toBe(generation + 1);
    expect(useRepos.getState().tabs[root].diffRefreshVersion).toBe(0);
  });
  it("rejects an old attribute context without invalidating the newer mounted preview", async () => {
    useRepos.getState().patch(root, { status: { ...snapshot("newer", 5), diffContextToken: "new-context" } });
    const generation = previewGeneration(root);
    vi.mocked(api.status).mockResolvedValue({ ...snapshot("older", 4), diffContextToken: "old-context" });
    await useRepos.getState().refresh(root, { background: true, status: true });
    expect(previewGeneration(root)).toBe(generation);
    expect(useRepos.getState().tabs[root].status?.diffContextToken).toBe("new-context");
  });
  it("does not commit using a fresh status while the displayed branch information is still old", async () => {
    const oid = "a".repeat(40);
    const info = (branch: string) => ({ head: { branch, oid } } as RepoInfo);
    const status = { ...snapshot("topic-state", 5), branch: "topic", oid };
    useRepos.getState().patch(root, { status, info: info("main"), pendingMutations: 0 });
    const calls: string[] = [];
    const invoke: Invoke = async <T>(command: string) => {
      calls.push(command);
      if (command === "status") return status as T;
      if (command === "repo_info") return info("topic") as T;
      return "committed" as T;
    };
    await expect(repositoryCall(invoke, "commit", { repo: root, message: "Keep branch review coherent" })).rejects.toMatchObject({ kind: "stale-operation" });
    expect(calls).not.toContain("commit");
    expect(useRepos.getState().tabs[root].info?.head.branch).toBe("topic");
    await expect(repositoryCall(invoke, "commit", { repo: root, message: "Reviewed topic" })).resolves.toBe("committed");
    expect(calls.filter(c => c === "commit")).toHaveLength(1);
  });
});
