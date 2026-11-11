# Quick start: from an open repository to a pull request

This walkthrough uses `main` as the shared branch and `feature/login` as your working branch. Use your project's actual branch names.

## 1. Install and open Revqora

Install system Git, then download and extract the appropriate [Revqora release](https://github.com/bitcodepro/Revqora/releases). On Windows, run `revqora.exe` from the extracted folder, not from inside the ZIP. Use a writable folder and keep the package files together.

Revqora needs Git 2.30 or newer. Advanced history, stage-layer and restack operations need Git 2.40 or newer. Windows also needs WebView2 Runtime. If Git is missing, open **Settings → Detect again** after installing it.

| Platform | Package and launch |
| --- | --- |
| Windows x64 | Extract `win-x64.zip` and open `revqora.exe`. |
| Linux x64 / ARM64 | Extract the matching `.tar.gz` and run `./revqora`. WebKitGTK 4.1 and the platform GTK/system libraries are required; the package is not an AppImage. |
| macOS Intel / Apple Silicon | Extract the matching archive and open `Revqora.app`. Packages are ad-hoc signed, not notarized. |

## 2. Open or clone your repository

- Already have a local folder? Press **Ctrl+O** and select it.
- Have only a remote URL? Press **Ctrl+N**, search **Clone repository…**, and choose a destination folder.
- Starting a local project? Use **New repository…**. This initializes local Git; creating a repository on a hosting website is a separate action.

The current repository and branch appear at the top. Check them before making changes.

To add a second repository, press **Ctrl+O** again. The existing one stays open. See [Repositories and workspaces](https://github.com/bitcodepro/Revqora/wiki/Repositories-and-workspaces).

## 3. Get the latest shared code

Select `main` in **Branches**, then use **Pull**. If you already have unfinished changes, commit or stash them when Git requires it.

You can first use **Fetch** to update remote information without changing your working files. A separate Fetch is not required before Pull.

## 4. Create your working branch

Press **Ctrl+B**, enter `feature/login`, check the starting revision and choose the option to check out the new branch.

Edits that were not committed stay in the current working folder when creating a branch from the current commit. They become part of the branch where you eventually commit them.

## 5. Edit, inspect and stage

Edit your files in your usual editor. Return to Revqora and open **Changes** with **Ctrl+2**.

1. Select a changed file and inspect its diff.
2. Use **+**, double-click the file, or choose **Stage all** for the intended files.
3. Check the **Staged** list.
4. Leave unrelated edits unstaged.

For example, stage `login.ts` for a login fix and leave an unfinished `theme.css` edit for a later commit. Staging selects commit content; it does not hide or discard the other edit.

## 6. Commit locally

Enter a short summary, such as `fix: handle expired login sessions`, and add a description if needed. Choose **Commit**.

If the button is disabled, check that you have a nonempty message, staged changes and no unresolved conflicts. Set your commit name/email in **Settings → Edit name & email** if Git asks for an identity.

The commit is now in local history. It has not been published yet.

## 7. Push and create a PR

1. Choose **Push**. For the first push, select the remote and destination branch and set upstream tracking when offered.
2. Open **Pull Requests** with **Ctrl+3**.
3. If needed, connect an account through **Accounts…**.
4. Choose **New** / **New PR**, select `feature/login` as source and `main` as target, enter a title and description, and submit.

If Push succeeded but PR access fails, use [Accounts and providers](https://github.com/bitcodepro/Revqora/wiki/Accounts-and-providers): Git transport and hosting APIs have separate authentication requirements.

## 8. Review, fix and finish

Read comments in **Discussions** and code in **Files**. Make further commits on the PR's source branch and push them; the existing PR receives those commits. Use **Reload request** to fetch updated PR data.

After the PR is merged, return to the shared branch and Pull. Review deletion of the completed feature branch separately.

**Next:** [Changes and commits](https://github.com/bitcodepro/Revqora/wiki/Changes-and-commits) · [Fetch, Pull, Push and Sync](https://github.com/bitcodepro/Revqora/wiki/Fetch-Pull-Push-and-Sync) · [Pull Request Center](https://github.com/bitcodepro/Revqora/wiki/Pull-Request-Center)
