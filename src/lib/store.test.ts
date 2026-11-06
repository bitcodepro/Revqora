import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { status: vi.fn(), repoInfo: vi.fn(), layersState: vi.fn(), refs: vi.fn(), repoExtras: vi.fn(), squashMerged: vi.fn(), graphLoad: vi.fn() }, errorMessage: String }));
vi.mock("./settings", () => ({ useSettings: { getState: () => ({ set: vi.fn() }) } }));
vi.mock("./repositoryLibrary", async original => ({ ...await original<typeof import("./repositoryLibrary")>(), useLibrary: { getState: () => ({ remember: vi.fn() }) } }));
vi.mock("./ui", () => ({ useUi: { setState: vi.fn() } }));
import { api } from "./api";
import { loadGraph, useRepos, type RepoTab } from "./store";
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
  it("keeps cached history and previews while activation revalidates unchanged local state",async()=>{
    const refs={local:[],remote:[],tags:[],remotes:[]};const info={head:{branch:"main",oid:"a"}} as RepoInfo;
    useRepos.getState().patch(root,{info,refs:refs as never,loaded:true});vi.mocked(api.repoInfo).mockResolvedValue(info);vi.mocked(api.refs).mockResolvedValue(refs as never);
    const generation=previewGeneration(root);await useRepos.getState().refresh(root,{background:true,activation:true,info:true,refs:true,status:true});
    expect(api.graphLoad).not.toHaveBeenCalled();expect(previewGeneration(root)).toBe(generation);expect(useRepos.getState().tabs[root].graphLoading).not.toBe(true);
  });
  it("publishes branch information before slow optional layers and extras",async()=>{
    let release!:(value:never)=>void;vi.mocked(api.layersState).mockImplementation(()=>new Promise(resolve=>{release=resolve;}));const info={head:{branch:"topic",oid:"new"}} as RepoInfo;vi.mocked(api.repoInfo).mockResolvedValue(info);
    const pending=useRepos.getState().refresh(root,{background:true,activation:true,info:true,status:true,layers:true});
    await vi.waitFor(()=>expect(useRepos.getState().tabs[root].info).toBe(info));release(null as never);await pending;
  });
  it("rebuilds the graph after a detached HEAD update was already observed offscreen",async()=>{
    const refs={local:[],remote:[],tags:[],remotes:[]};const a={head:{branch:null,oid:"a",detached:true}} as RepoInfo;const b={head:{branch:null,oid:"b",detached:true}} as RepoInfo;
    useRepos.getState().patch(root,{info:a,refs:refs as never,graph:{key:"graph-a",headOid:"a",total:1,maxLanes:1,headIndex:0}});
    useRepos.setState({active:"another-repository"});vi.mocked(api.repoInfo).mockResolvedValue(b);vi.mocked(api.refs).mockResolvedValue(refs as never);
    await useRepos.getState().refresh(root,{background:true,info:true});
    expect(useRepos.getState().tabs[root].info).toBe(b);expect(api.graphLoad).not.toHaveBeenCalled();
    vi.mocked(api.graphLoad).mockResolvedValue({key:"graph-b",headOid:"b",total:1,maxLanes:1,headIndex:0});useRepos.setState({active:root});
    await useRepos.getState().refresh(root,{background:true,activation:true,info:true,refs:true});
    await vi.waitFor(()=>expect(useRepos.getState().tabs[root].graph?.headOid).toBe("b"));expect(api.graphLoad).toHaveBeenCalledTimes(1);
  });
  it("serializes graph cache builds and publishes only the latest branch request", async () => {
    let release!: (v: never) => void;
    const first = new Promise<never>(resolve => { release = resolve; });
    vi.mocked(api.graphLoad).mockImplementationOnce(() => first).mockResolvedValue({key:"latest-branch",total:1,maxLanes:1,headIndex:0});
    useRepos.getState().patch(root, {branchFilter:"main",graphVersion:0});
    const old = loadGraph(root);
    await vi.waitFor(() => expect(api.graphLoad).toHaveBeenCalledTimes(1));
    useRepos.getState().patch(root, {branchFilter:"feature"});
    const current = loadGraph(root);
    await Promise.resolve();
    expect(api.graphLoad).toHaveBeenCalledTimes(1);
    release({key:"old-main",total:4,maxLanes:1,headIndex:0} as never);
    await Promise.all([old,current]);
    expect(vi.mocked(api.graphLoad).mock.calls.map(args=>args[1])).toEqual(["main","feature"]);
    const tab=useRepos.getState().tabs[root];
    expect(tab.graph?.key).toBe("latest-branch");
    expect(tab.graphVersion).toBe(1);
    expect(tab.graphLoading).toBe(false);
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
