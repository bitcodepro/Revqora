# Revqora development rules

- Stack: Tauri 2 + Rust backend in `src-tauri/` (calls the system `git`), React + TypeScript UI in `src/`.
- Backend modules live in `src-tauri/src/git/`; every Tauri command is registered in `src-tauri/src/lib.rs` and wrapped in `src/lib/api.ts` (types in `src/lib/types.ts`).
- Stage layers are hidden commits under `refs/worktree/revqora/layers`; read paths must never rewrite the index (no `write-tree` outside mutating operations).
- Never create commits during a merge without the user's confirmation (`merge --no-commit`).
- Revqora uses the system git (found by `src-tauri/src/git/locate.rs`; no git is bundled). Credential prompts go through `src-tauri/src/askpass.rs` (the exe doubles as the askpass helper, see `main.rs`).
- `runner.rs` serializes writing git commands per repository; add new read-only subcommands to `is_read_only`.
- After every change run `npm run verify` (format, clippy, Rust + git workflow tests, typecheck, vitest, release build, UI smoke test). Report any step that fails or could not run.
