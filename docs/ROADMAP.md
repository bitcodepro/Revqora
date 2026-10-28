# Revqora implementation roadmap

This is the agreed sequence. The commit-preview performance fix in PR #10 is
cross-cutting work and does not consume a feature stage.

| Stage | Scope | Status |
| --- | --- | --- |
| 1 | Repository operation queues and state preconditions | Merged (#6) |
| 2 | Persistent operation journal | Merged (#7) |
| 3 | Recovery checkpoints and Undo Center | Merged (#8) |
| 4 | Reviewed branch deletion | Merged (#9) |
| 5 | Ignored files, partial stash, autosquash, nested repositories, remote branch rename | Implemented; review pending |
| 6 | Rebase Studio: affected refs, force-push implications, result comparison, recovery | Planned |
| 7 | Conflict Studio: Base panel, navigation, user-selected validation commands | Planned |
| 8 | Repository favorites, project groups, workspaces and explicit Sync | Planned |
| 9 | Advanced Branch Manager | Planned |
| 10 | Reviewed bulk branch cleanup | Planned |
| 11 | Worktree Manager | Planned |
| 12 | Accounts and forge integrations | Planned |
| 13 | PR Center: browse, create, edit, templates and diffs | Planned |
| 14 | PR Center: comments, threads and review submissions | Planned |
| 15 | PR Center: CI, server protections, merge and branch cleanup | Planned |
| 16 | Agent Workspace | Planned |
| 17 | Workflow Builder | Planned |
| 18 | Automated PR Workflow | Planned |
| 19 | Semantic diff and history tools | Planned |
| 20 | Stacked branches | Planned |

Performance, compatibility, external-Git changes and data-safety regressions apply
to every stage. Application data remains portable beside the executable.
