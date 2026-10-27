// Mirrors of the Rust backend types (serde camelCase).

export interface RemoteBranchTarget {
  label: string;
  remote: string;
  pushUrl: string;
  remoteRef: string;
  trackingRef: string;
  oid: string;
  isUpstream: boolean;
}

export interface RemoteDeletionReview {
  target: RemoteBranchTarget;
  previousOid: string;
  newCommits: number;
  removedCommits: number;
  unmergedCommits: number;
  commits: string[];
}

export interface GitError {
  message: string;
  stderr: string;
  code: number | null;
  kind: string;
  details: string[];
}

export interface HeadInfo {
  branch: string | null;
  oid: string | null;
  detached: boolean;
  unborn: boolean;
}

export type OpKind = "none" | "merge" | "squash" | "rebase" | "cherry-pick" | "revert" | "am" | "bisect";

export interface OpState {
  kind: OpKind;
  incoming: string | null;
  incomingLabel: string | null;
  message: string | null;
  step: number | null;
  total: number | null;
  headName: string | null;
  onto: string | null;
  stoppedAt: string | null;
}

export interface RepoInfo {
  root: string;
  gitDir: string;
  commonDir?: string;
  name: string;
  head: HeadInfo;
  state: OpState;
  isBare: boolean;
}

export interface FileStatus {
  path: string;
  origPath: string | null;
  index: string;
  worktree: string;
  conflict: string | null;
  untracked: boolean;
  submodule: boolean;
}

export interface StatusSummary {
  stateToken?: string | null;
  stateVersion?: number;
  branch: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: FileStatus[];
  stagedCount: number;
  unstagedCount: number;
  conflictCount: number;
}

export interface DiffLine {
  kind: " " | "+" | "-" | "\\";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  binary: boolean;
  isNew: boolean;
  isDeleted: boolean;
  oldMode: string | null;
  newMode: string | null;
  similarity: number | null;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  truncated: boolean;
  hash: string;
  empty: boolean;
}

export interface DiffOptions {
  context?: number;
  ignoreWhitespace?: boolean;
}

export interface Seg {
  a: number;
  b: number;
  t: 0 | 1 | 2;
  c: number;
}

export interface RefLabel {
  name: string;
  kind: "head" | "local" | "remote" | "tag" | "detached" | "bisect";
  syncedRemote: string | null;
}

export interface GraphRow {
  index: number;
  oid: string;
  parents: string[];
  author: string;
  email: string;
  authorTime: number;
  committer: string;
  commitTime: number;
  subject: string;
  refs: RefLabel[];
  col: number;
  color: number;
  segs: Seg[];
  isHead: boolean;
  isMerge: boolean;
  localOnly: boolean;
}

export interface GraphSummary {
  key: string;
  total: number;
  maxLanes: number;
  headIndex: number | null;
}

export type SearchMode = "quick" | "message" | "author" | "hash" | "content" | "path";

export interface ChangedFile {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface CommitDetails {
  oid: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorTime: number;
  committer: string;
  committerEmail: string;
  commitTime: number;
  subject: string;
  body: string;
  files: ChangedFile[];
  diffBase: string | null;
  containedInRemote: boolean;
}

export interface FileHistoryEntry {
  oid: string;
  author: string;
  time: number;
  subject: string;
  path: string;
}

export interface BranchInfo {
  name: string;
  fullName: string;
  oid: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  isHead: boolean;
  remote: string | null;
  time: number;
  subject: string;
  author: string;
}

export interface BranchDetails {
  name: string;
  tip: string;
  base: string;
  forkPoint: string | null;
  forkSubject: string | null;
  forkTime: number | null;
  ahead: number;
  behind: number;
  firstTime: number | null;
  firstSubject: string | null;
  lastTime: number;
  lastSubject: string;
  authors: string[];
  merged: boolean;
}

export interface TagInfo {
  name: string;
  oid: string;
  target: string;
  annotated: boolean;
  time: number;
  subject: string;
}

export interface StashInfo {
  index: number;
  name: string;
  oid: string;
  time: number;
  message: string;
}

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface RefsSnapshot {
  local: BranchInfo[];
  remote: BranchInfo[];
  tags: TagInfo[];
  stashes: StashInfo[];
  remotes: RemoteInfo[];
}

export interface OpOutcome {
  status: "done" | "conflicts" | "stopped" | "upToDate" | "fastForward" | "pending";
  conflicts: string[];
  message: string;
}

export interface ConflictSide {
  exists: boolean;
  binary: boolean;
  text: string;
  oid: string | null;
}

export interface ConflictInfo {
  stateToken?: string;
  path: string;
  code: string;
  base: ConflictSide;
  ours: ConflictSide;
  theirs: ConflictSide;
  merged: string;
  conflictCount: number;
  working: string | null;
  workingHasMarkers: boolean;
  oursLabel: string;
  theirsLabel: string;
  eolCrlf: boolean;
}

export interface LayerFile {
  path: string;
  oldPath: string | null;
  status: string;
}

export interface LayerView {
  index: number;
  name: string;
  created: number;
  files: LayerFile[];
  fromTree: string;
  toTree: string;
}

export interface LayersState {
  active: boolean;
  layers: LayerView[];
  openFiles: LayerFile[];
  stagedBase: string | null;
  note: string | null;
}

export interface ReflogEntry {
  oid: string;
  selector: string;
  message: string;
  time: number;
}

export interface CommitOptions {
  sign?: boolean;
  amend?: boolean;
  noVerify?: boolean;
  signOff?: boolean;
  allowEmpty?: boolean;
}

export interface PushOptions {
  remote?: string;
  branch?: string;
  remoteBranch?: string;
  setUpstream?: boolean;
  forceWithLease?: boolean;
  tags?: boolean;
}

export type RewriteAction =
  | { action: "reword"; oid: string; message: string }
  | { action: "drop"; oids: string[] }
  | { action: "squash"; oids: string[]; message: string }
  | { action: "edit"; oid: string }
  | { action: "move"; oid: string; delta: number };

export interface GitVersionInfo {
  version: string;
  supported: boolean;
  layersReorder: boolean;
}

export interface Identity {
  name: string | null;
  email: string | null;
}

export const WORKTREE = "WORKTREE";

export interface GitSelection {
  source: "system" | "custom" | "none";
  path: string;
  version: string;
  tooOld: boolean;
  minVersion: string;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  notes: string;
  publishedAt: string | null;
  htmlUrl: string;
  asset: { name: string; url: string; size: number; checksumUrl: string | null } | null;
  canInstall: boolean;
  reason: string | null;
}

export interface AskpassRequest {
  id: number;
  prompt: string;
  kind: "username" | "secret" | "yesno" | "text";
}

export interface BlameCommit {
  oid: string;
  author: string;
  email: string;
  time: number;
  summary: string;
  previous: string | null;
}

export interface BlameLine {
  oid: string;
  origLine: number;
  line: number;
  text: string;
}

export interface Blame {
  path: string;
  rev: string | null;
  lines: BlameLine[];
  commits: Record<string, BlameCommit>;
}

export interface RangeCommit {
  oid: string;
  author: string;
  time: number;
  subject: string;
}

export interface Comparison {
  from: string;
  to: string;
  base: string;
  mergeBase: string | null;
  files: ChangedFile[];
  ahead: RangeCommit[];
  behind: number;
}

export interface BlobSpec {
  rev?: string;
  worktree?: string;
}

export interface BlobData {
  base64: string;
  size: number;
  mime: string;
}

export type RebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

export interface PlanCommit {
  oid: string;
  subject: string;
  body: string;
  author: string;
  time: number;
}

export interface RebasePlan {
  stateToken?: string;
  base: string | null;
  commits: PlanCommit[];
}

export type LayerOp = { op: "unstage"; index: number } | { op: "move"; index: number; delta: number } | { op: "commitLayer"; index: number };

export interface LayerConflict {
  item: number;
  label: string;
  files: ConflictInfo[];
}

export interface Submodule {
  path: string;
  url: string | null;
  oid: string;
  state: "ok" | "uninitialized" | "modified" | "conflict";
  describe: string | null;
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  isCurrent: boolean;
}

export interface BisectStatus {
  active: boolean;
  good: string[];
  bad: string | null;
  current: string | null;
  message: string;
  remaining: number | null;
  steps: number | null;
  firstBad: string | null;
}

export interface LfsStatus {
  available: boolean;
  version: string | null;
  used: boolean;
  patterns: string[];
}

export interface LfsFile {
  oid: string;
  downloaded: boolean;
  path: string;
}

export interface RepoExtras {
  submodules: Submodule[];
  worktrees: Worktree[];
  lfs: LfsStatus | null;
  bisect: BisectStatus | null;
}

export interface SigningConfig {
  signCommits: boolean;
  signTags: boolean;
  format: "openpgp" | "ssh" | "x509";
  key: string | null;
}

export interface Signature {
  status: string;
  signer: string;
  key: string;
  fingerprint: string;
}

export interface RepoSize {
  looseObjects: number;
  looseSizeKib: number;
  packs: number;
  packSizeKib: number;
  garbage: number;
  commitGraph: boolean;
  maintenanceRegistered: boolean;
}

export interface LargeFile {
  path: string;
  size: number;
}

export interface DeletedBranch {
  name: string;
  oid: string;
  time: number;
  subject: string;
  source: "revqora" | "reflog";
}

export interface RefLogEntry {
  oid: string;
  message: string;
  time: number;
}

export interface StashContents {
  oid: string;
  base: string;
  files: ChangedFile[];
  untracked: ChangedFile[];
  untrackedCommit: string | null;
}

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

export interface WorktreeComparison {
  from: string;
  files: ChangedFile[];
}

export interface CommitHelpers {
  template: string | null;
  recent: string[];
  hooks: string[];
}

export interface ForgeInfo {
  kind: "github" | "gitlab" | "bitbucket" | "bitbucket-server";
  host: string;
  project: string;
  remote: string;
  webUrl: string;
  api: string;
}

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  head: string;
  base: string;
  url: string;
  draft: boolean;
  state: string;
  created: string;
  headSha: string;
}

export interface Check {
  name: string;
  state: "success" | "failure" | "pending" | "neutral" | "skipped" | "cancelled";
  url: string | null;
}
