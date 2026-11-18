# Accounts, credentials and hosting providers

**Where:** **Pull Requests → Accounts…**, or **Ctrl+N → Accounts and API connections**.

## Three identities to understand

| Identity | Used for | Configured through |
| --- | --- | --- |
| Git author name/email | Attribution inside commits. | Git identity / **Settings → Edit name & email**. |
| Git transport credentials | Fetch, Pull and Push over HTTPS or SSH. | Your system Git credential helper, SSH agent/keys and Git configuration. |
| Hosting API account | PR descriptions, discussions, review votes, checks and supported merge actions. | **Accounts and API connections**. |

Git may successfully use an SSH key while the PR API has no usable token. A browser login also does not automatically supply Revqora with an API credential.

**Use Git credential helper** is available as an API connection choice when the stored credential is suitable for the provider API. SSH authentication by itself does not supply an HTTPS API token. If reuse fails, add an API account explicitly. Revqora remembers the helper's answer while it runs: for a minute as it is, then for up to 30 minutes it is still used at once while the helper is asked again in the background. A rejected token (HTTP 401), a new sign-in or **Forget saved tokens** drops it, so the next request asks the helper.

## Add an API account

1. Open **Accounts and API connections**.
2. Choose **Add API account**. The form replaces the account list until you save or cancel it.
3. **Service**: choose the provider. The selected remote preselects it. The server is shown as a summary; use **Change server** for GitHub Enterprise or a self-hosted GitLab (include its installation prefix). Azure DevOps always asks for the organization URL.
4. **How do you sign in?**: choose one method. Each method lists only the fields it needs:

   | Provider | Methods | Fields |
   | --- | --- | --- |
   | GitHub, GitLab | Personal access token | Token |
   | Azure DevOps | Personal access token (PAT) or Microsoft Entra access token | Token |
   | Bitbucket Cloud | API token + Atlassian email | Email and token |
   | | Access token (repository, project, workspace or OAuth) | Token |
   | | Git token of the selected remote | Nothing; the Atlassian email is optional (enter it when the Git token is an API token) |

5. Fill the fields marked **required**. **Create a token** opens the provider's token page when it has one. While something is missing, the form says what next to the disabled save button.
6. **Options** are optional: use the account for this repository's PRs and checks (on by default), read the Bitbucket profile, keep the token after restarting (needs an unlocked vault).
7. Choose **Verify and save account** (Bitbucket without profile reading: **Save token connection**).

To change the account of a repository later, select the intended **Remote** and **API account** in the repository connection section and choose **Use for PR and checks**.

The token needs access to the relevant repositories and API operations. Obtain it through the provider's current account/organization procedures. Server permissions, organization authorization and branch policies still apply.

## Provider reference

| Provider | Account setup in Revqora | Things to check |
| --- | --- | --- |
| GitHub / GitHub Enterprise | GitHub provider, matching server and PAT. | Repository access and any required organization SSO authorization. |
| GitLab | GitLab provider and personal token; include a self-hosted installation prefix in the server URL. | User/API access and approval permissions. |
| Azure DevOps | Azure provider, organization/collection server address and PAT. | Grant **Code (Read)** (`vso.code`) to browse PRs. Review and publication also depend on project permissions and branch policies. |
| Bitbucket Cloud | Bitbucket provider with **API token + Atlassian email**, or **OAuth access token**. | Grant **Pull requests Read** (`read:pullrequest:bitbucket`) to list PRs and **Repositories Read** (`read:repository:bitbucket`) to view commits and files when using an API token. |
| Bitbucket Server / Data Center | Existing Git-credential integration for the server. | Capabilities depend on the server and verified API identity; some actions remain on the website. |

The Add API account form manages GitHub, GitLab, Azure and Bitbucket Cloud accounts. Bitbucket Server/Data Center uses its existing credential-based integration rather than that Cloud token form.

## Save tokens across restarts

For HTTPS Git operations, Revqora first uses the configured credential helper.
Once Revqora holds a token for a repository (remembered, or typed in this session),
Fetch, Pull and Push in Automatic mode ask Revqora for it before the configured
helpers, so Git Credential Manager no longer starts for every request; it is still
asked for hosts Revqora has no token for. A configuration that resets the helper
list with an empty `credential.helper` keeps Git's own order.
On Windows, if Revqora prompts for a token, **Remember in Revqora on this Windows
account** stores Git-approved credentials under `data/git-credentials`, encrypted
for that Windows user. In the Bitbucket prompt, enter the token to sign in to Git.
Leave the optional PR email blank to reuse the token as Bearer. If your PR API
connection uses Basic authentication, choose **Add email for pull requests
(optional)** and enter your Atlassian email. Basic uses that email and the same
token. If a remembered token expires, sign in again or reconnect the API account.

To persist an API account token in Revqora's separate vault:

1. Under **Portable token vault** (optional), choose **Set up vault…** and enter a vault password twice, or unlock an existing vault with its password. The password fields appear only then.
2. Enable **Keep after restarting (encrypted vault)** in the account form's options.
3. After restarting, unlock the vault again.

The encrypted store is under `data/accounts` beside the executable. The vault password is not saved. **Lock tokens and clear sessions** clears active credentials. Forgetting saved tokens requires reconnecting accounts; it does not delete remote repositories.

An already-bound account that is locked/expired/removed must be unlocked or reconnected explicitly. The app does not silently change to another account for a pending PR write.

## Check connection

**Check connection…** (Accounts, PR Center, a repository that needs attention in the all-repositories PR list) tests one remote and shows a separate result for each part:

| Check | How it is tested |
|---|---|
| Git read (HTTPS or SSH) | `git ls-remote --heads` |
| Git push | `git push --dry-run` of HEAD to a branch name that is never created; no commit is sent. Branch protection is checked only by a real push. A repository without commits, or a server that checks access only when data arrives, shows **Not verified**. |
| Account profile | a live profile request with the connection's credential |
| Pull request list | the first page of open pull requests |
| Pull request files, Checks | the first open pull request's files and checks |

Every check runs without sign-in prompts and with a time limit. Each result is **Works**, **Failed**, **Limited** (for example a Bitbucket token that reads pull requests but not your profile), **Not verified** or **Not checked**, with the cause (no credentials, credential rejected, insufficient permissions, not found, timed out, rate limit, network, SSH host key, provider error, incomplete response) and the next step. The dialog names the repository, remote URL without credentials, provider and where the credentials come from (an API account or Git's credential helper). **Copy diagnostics…** opens the report for review before copying.

## SSH aliases and multiple accounts

For an SSH alias, explicitly confirm the mapping to the selected API server when the form asks. The SSH user name `git` is a transport identity, not your GitHub/GitLab API account name.

Bindings are per repository remote. Check the active account/remote shown in PR Center when the same machine has personal and work accounts.

**Related:** [PR Center](https://github.com/bitcodepro/Revqora/wiki/Pull-Request-Center) · [Remote operations](https://github.com/bitcodepro/Revqora/wiki/Fetch-Pull-Push-and-Sync) · [Troubleshooting](https://github.com/bitcodepro/Revqora/wiki/Settings-and-troubleshooting)
