# Accounts, credentials and hosting providers

**Where:** **Pull Requests → Accounts…**, or **Ctrl+N → Accounts and API connections**.

## Three identities to understand

| Identity | Used for | Configured through |
| --- | --- | --- |
| Git author name/email | Attribution inside commits. | Git identity / **Settings → Edit name & email**. |
| Git transport credentials | Fetch, Pull and Push over HTTPS or SSH. | Your system Git credential helper, SSH agent/keys and Git configuration. |
| Hosting API account | PR descriptions, discussions, review votes, checks and supported merge actions. | **Accounts and API connections**. |

Git may successfully use an SSH key while the PR API has no usable token. A browser login also does not automatically supply Revqora with an API credential.

**Use Git credential helper** is available as an API connection choice when the stored credential is suitable for the provider API. SSH authentication by itself does not supply an HTTPS API token. If reuse fails, add an API account explicitly.

## Add an API account

1. Open **Accounts and API connections**.
2. Choose **Add API account**.
3. Select the provider.
4. Enter its web **Server URL**, including the organization/installation prefix when applicable.
5. Enter the provider access token and any required account/email field.
6. Choose **Verify and save account**.
7. In the repository connection section, select the intended **Remote** and **API account**.
8. Choose **Use for PR and checks**.

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
On Windows, if Revqora prompts for a token, **Remember in Revqora on this Windows
account** stores Git-approved credentials under `data/git-credentials`, encrypted
for that Windows user. In the Bitbucket prompt, enter the token to sign in to Git.
Leave the optional PR email blank to reuse the token as Bearer. If your PR API
connection uses Basic authentication, choose **Add email for pull requests
(optional)** and enter your Atlassian email. Basic uses that email and the same
token. If a remembered token expires, sign in again or reconnect the API account.

To persist an API account token in Revqora's separate vault:

1. Create or unlock the **Portable token vault** with your vault password.
2. Enable **Save token in the encrypted vault** while saving the account.
3. After restarting, unlock the vault again.

The encrypted store is under `data/accounts` beside the executable. The vault password is not saved. **Lock tokens and clear sessions** clears active credentials. Forgetting saved tokens requires reconnecting accounts; it does not delete remote repositories.

An already-bound account that is locked/expired/removed must be unlocked or reconnected explicitly. The app does not silently change to another account for a pending PR write.

## SSH aliases and multiple accounts

For an SSH alias, explicitly confirm the mapping to the selected API server when the form asks. The SSH user name `git` is a transport identity, not your GitHub/GitLab API account name.

Bindings are per repository remote. Check the active account/remote shown in PR Center when the same machine has personal and work accounts.

**Related:** [PR Center](https://github.com/bitcodepro/Revqora/wiki/Pull-Request-Center) · [Remote operations](https://github.com/bitcodepro/Revqora/wiki/Fetch-Pull-Push-and-Sync) · [Troubleshooting](https://github.com/bitcodepro/Revqora/wiki/Settings-and-troubleshooting)
