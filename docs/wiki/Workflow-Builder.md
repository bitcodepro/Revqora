# Workflow Builder

**Where:** **Ctrl+N → Workflow Builder**, or its toolbar action.

A workflow is a saved sequence of checks and reviewed actions. It is useful for repeating a team routine, such as checking a branch, running tests, publishing a commit and creating a PR.

Saving a workflow does not start it. Creating a run saves a copy of its definition; steps are then reviewed and executed through the run screen.

## Your first workflow: test the current branch

1. Open Workflow Builder and choose the new-workflow action.
2. Set **Workflow name**, for example `Check login branch`.
3. Keep/add these steps and remove unused default steps:

| Order | Step type | Example value |
| --- | --- | --- |
| 1 | **Require branch** | The branch you intend to test, such as `feature/login`. |
| 2 | **Run test / build command** | `npm test` |
| 3 | **Run test / build command** | `npm run build` |

4. Review commands, conditions and timeouts, then choose **Save workflow**.
5. Start it and inspect the branch/base parameters.
6. Choose **Create waiting run**. No command runs yet.
7. Select the run and choose **Review next step**.
8. Review and execute each step, reading its output before continuing.

Use commands that exist in your project. They execute project scripts and can change files or contact services.

## Available step types

| Step | Purpose |
| --- | --- |
| Require clean files / Require branch | Check Git-visible state before proceeding. |
| Create and check out branch | Create a new branch from the reviewed starting commit. |
| Cherry-pick commits | Apply the specified commits in order. |
| Run test / build command | Execute a literal shell command and retain its result. |
| Stage and commit edits | Review a commit containing Git-visible edits in the effective working copy. |
| Publish branch | Publish the exact reviewed commit to a named remote/destination. |
| Create pull request | Create a PR after its source commit is published. |
| PR-specific steps | Agent feedback, CI, re-review, merge and source cleanup; see [PR agent workflows](https://github.com/bitcodepro/Revqora/wiki/PR-agent-workflows). |

Git/server actions keep their separate reviews. Source changes, the API account and publication destination are checked again when needed.

## Conditions and parameters

Each step can run **Always**, when **Files are clean**, or when **Files have changes**. If its condition is false, choose whether to **Stop workflow** or **Skip step**.

Clean/dirty checks concern Git-visible content; ignored build output is outside that check.

In supported Git fields, `${branch}` and `${base}` can fill an entire field. Shell commands, PR titles and descriptions stay literal. For example, writing `${branch}` inside a shell command is not Revqora's parameter expansion feature.

Move steps up/down to change their order. Editing a saved definition does not silently replace the frozen definition of a run that already exists.

## Read the run result

Inspect the current step, phase, logs, exit status and any changed working copy. A failure or conflict stops later steps. Resolve Git conflicts using the normal operation controls before following the offered result/acknowledgment path.

**Stop** uses the managed command stop controls; a Git/HTTP action may finish its current operation before stopping later dispatch. A stopped workflow does not automatically undo earlier successful steps.

After a crash or uncertain remote write, inspect the repository/server and acknowledge the result as required. Restarting does not replay the consumed step automatically.

## Optional automatic validation

The run screen can offer **Run displayed test commands and CI checks automatically while this screen is open**. Enable it only after reviewing those commands.

This applies to eligible displayed check/command/CI steps while the workspace stays open. Built-in agent, Git and server steps pause for their required review. Closing the screen stops new automatic dispatch; an already running command has its existing stop controls.

**Related:** [Agent Workspace](https://github.com/bitcodepro/Revqora/wiki/Agent-Workspace) · [PR workflows](https://github.com/bitcodepro/Revqora/wiki/PR-agent-workflows) · [Recovery](https://github.com/bitcodepro/Revqora/wiki/Recovery-and-repository-tools)
