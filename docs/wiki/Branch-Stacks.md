# Branch Stacks: dependent branches and PRs

**Where:** **Ctrl+N → Branch Stacks…** or the toolbar action.

Use a stack when a feature should be reviewed as several dependent branches rather than one large PR.

Example:

```text
main
  └─ feature/api
       └─ feature/ui
            └─ feature/tests
```

Each layer has its own commits after the recorded parent boundary. Its PR can target the immediate parent branch.

## Create a stack and layers

1. Choose **New stack**.
2. Enter a stack name and select its local **Base branch**.
3. Choose **Create stack**.
4. Select the stack and choose **Add layer**.
5. Enter a branch name and review the exact parent commit.
6. Choose **Create dependent branch**, or explicitly adopt an eligible existing branch.

Creating tracking metadata or a new layer does not check out that branch or move your uncommitted edits. Choose **Check out layer** before working there, or open it in a suitable worktree.

## Develop and review each layer

Commit changes on the intended layer. Link a matching existing PR or create one targeting its immediate parent. Review the API account and exact source/target.

For the example above, the UI PR normally targets `feature/api`, while the API PR targets `main`. Changing a child's PR target is a separate server action.

## Restack after a parent changes

Restack means replaying a layer's own commits onto its updated parent.

1. Update the base/bottom layer as appropriate.
2. Work **bottom to top** through dependent layers.
3. Check out the layer you intend to update.
4. Choose **Review restack**.
5. Inspect its old tip, old boundary, new parent, own commits and publication status.
6. Give the required consent and choose **Rebase this layer**.
7. Inspect the result before continuing to the next layer.

Only the reviewed current layer is rebased. Other branches and remote references are kept. Publication, including any force-with-lease decision for rewritten published history, is separate.

## Conflicts and interrupted restacks

Close the stack screen if necessary and resolve/continue or abort using the existing Git controls. Return, refresh and use **Confirm completed / aborted result** after inspecting the branch and ensuring Git processes have stopped.

Recording the result does not run another rebase. A pending/interrupted entry is not replayed automatically after restarting Revqora.

## After the bottom PR is merged

Refresh the linked PR and update the local base. When offered, **Retire merged bottom layer…** removes the merged layer from stack tracking after verifying the merge/base relationship.

The next layer retains its old boundary for a reviewed update onto the base, including after squash merge. Retiring tracking does not automatically delete the branch or retarget a child PR.

## Forget a stack

**Forget stack** removes its tracking definition. Local branches, files, remote refs, PRs and recovery checkpoints remain.

The current implementation tracks local linear chains. For a history range containing merges or an unsupported structure, use the explicit Git/history tools rather than expecting an inferred restack.

**Related:** [Rebase Studio](https://github.com/bitcodepro/Revqora/wiki/Merge-rebase-and-conflicts) · [Worktrees](https://github.com/bitcodepro/Revqora/wiki/Worktree-Manager) · [PR Center](https://github.com/bitcodepro/Revqora/wiki/Pull-Request-Center)
