# Address PR feedback with an agent

**Where:** open a PR in **Pull Requests**, then choose **PR workflow…**.

This recipe connects feedback, an isolated agent task, tests, commit/publication, CI and a follow-up review. Use it when you already have a PR with actionable feedback and want to follow the repair process in one workspace.

## Before starting

- Select the correct repository, API remote/account and PR.
- Fetch needed source commits if they are not local.
- Install/authenticate the intended CLI, including its reviewed portable profile.
- Read the feedback and decide which test/build commands apply.

Built-in PR-agent workflows require a source branch in the selected repository. Fork/unknown source repositories and incomplete feedback are reported as unsupported for this path. You can continue through ordinary Git and PR tools.

## A typical recipe

| Step | What to review |
| --- | --- |
| **Agent: address PR feedback** | Exact PR source, collected discussions/reviews, full prompt, executable, arguments and worktree. |
| **Run test / build command** | The literal command and effective working directory. |
| **Stage and commit edits** | All Git-visible edits being included and the commit message. |
| **Publish branch** | The PR's actual remote/source branch and exact commit. |
| **Wait for PR CI** | Checks for the newly published source, with a suitable timeout. |
| **Request GitHub review** | The intended reviewer logins, when supported. |
| **Merge pull request** / **Clean up merged PR source** | Optional separately reviewed actions after server requirements are satisfied. |

Keep only the steps you want. A request to fix feedback does not require enabling merge or deletion.

## Run it step by step

1. Configure the recipe's CLI, instructions, working-copy folder, validation commands and message.
2. Review the PR number and publication destination throughout the recipe.
3. Save/start the waiting run.
4. Choose **Review next step**.
5. Inspect the captured feedback and full agent prompt before **Start**/execution consent.
6. Inspect the agent output and changes.
7. Review validation and the staged commit content.
8. Publish only the intended commit to the PR source.
9. Check CI and request another review as appropriate.

After the agent finishes, subsequent steps use its isolated working copy. **Open agent working copy** lets you inspect it directly. Editing that copy can invalidate earlier checks, requiring a fresh review.

## Feedback and provider limits

Feedback capture supports complete GitHub threads/comments/reviews and supported GitLab/Azure discussion feeds. An incomplete feed stops preparation rather than quietly dropping comments. The current Bitbucket preview can therefore be insufficient for the built-in PR-agent path even though ordinary PR reading works.

Named automatic re-review requests currently target GitHub. Other providers retain their available manual review actions.

## Understand the gates

- Changed source, feedback, account or executable invalidates a prepared agent launch.
- Publication targets the same PR source branch selected in the recipe.
- Later CI/re-review/merge/cleanup requires the expected published source and a clean effective working copy.
- Green checks for the old source do not approve unpublished agent changes.
- Missing, failed, cancelled, skipped or neutral checks are not counted as a green result by the workflow CI gate.
- Queued/accepted merge requests remain pending until the server confirms completion.

Optional automatic validation follows the [Workflow Builder](https://github.com/bitcodepro/Revqora/wiki/Workflow-Builder) rules. It is not a background scheduler that autonomously approves every later action.

## If a step stops

Read the step's reason. For a false condition, follow the configured Skip/Stop behavior. For conflicts, resolve/continue or abort through Git controls. For uncertain publication or an interrupted process, inspect actual server/process state before acknowledging it.

Do not assume that a workflow failure reversed its earlier commits, pushes or comments. The result and recovery history describe what actually completed.

**Related:** [Pull Request Center](https://github.com/bitcodepro/Revqora/wiki/Pull-Request-Center) · [Agent Workspace](https://github.com/bitcodepro/Revqora/wiki/Agent-Workspace) · [Workflow Builder](https://github.com/bitcodepro/Revqora/wiki/Workflow-Builder)
