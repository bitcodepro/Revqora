import type { ForgeAccountKind } from "./types";

/** How an API account signs in. `git` reuses the token Git already holds for a Bitbucket remote. */
export type SignInMethodId = "token" | "bearer" | "basic" | "git";
/** `email` is required; `optionalEmail` may stay empty. */
export type SignInField = "email" | "optionalEmail" | "token";

export interface SignInMethod {
  id: SignInMethodId;
  title: string;
  description: string;
  fields: SignInField[];
  /** Label of the secret field for this method. */
  tokenLabel?: string;
  /** Permissions the token needs, shown under the token field. */
  permissions?: string;
}

export const providerNames: Record<ForgeAccountKind, string> = { github: "GitHub", gitlab: "GitLab", azure: "Azure DevOps", bitbucket: "Bitbucket Cloud" };
/** Azure DevOps has no single server: its organization URL is always entered. */
export const providerServers: Record<ForgeAccountKind, string> = { github: "https://github.com", gitlab: "https://gitlab.com", azure: "", bitbucket: "https://bitbucket.org" };

/** Sign-in methods offered for a provider, the default first. `gitRemote` names a Bitbucket remote whose Git token can be reused. */
export function signInMethods(kind: ForgeAccountKind, gitRemote: string | null = null): SignInMethod[] {
  switch (kind) {
    case "github":
      return [{ id: "token", title: "Personal access token", description: "A classic or fine-grained token from your GitHub developer settings.", fields: ["token"], tokenLabel: "Personal access token", permissions: "Needs access to the repository's pull requests, contents and checks. Organizations with SAML SSO may require authorizing the token." }];
    case "gitlab":
      return [{ id: "token", title: "Personal access token", description: "A token from your GitLab user settings.", fields: ["token"], tokenLabel: "Personal access token", permissions: "Needs user and API access (the api scope)." }];
    case "azure":
      return [
        { id: "token", title: "Personal access token (PAT)", description: "A token from User settings → Personal access tokens in your organization.", fields: ["token"], tokenLabel: "Personal access token", permissions: "Needs the Code scope; Read & write to comment, vote and complete pull requests." },
        { id: "bearer", title: "Microsoft Entra access token", description: "A short-lived Bearer token, for example from az account get-access-token.", fields: ["token"], tokenLabel: "Access token" },
      ];
    case "bitbucket":
      return [
        { id: "basic", title: "API token + Atlassian email", description: "A personal API token from your Atlassian account, used together with your account email.", fields: ["email", "token"], tokenLabel: "API token", permissions: "Give it repository and pull request scopes. Add read:user:bitbucket only to read your profile." },
        { id: "bearer", title: "Access token", description: "A repository, project or workspace access token, or an OAuth token. No email needed.", fields: ["token"], tokenLabel: "Access token", permissions: "Needs repository and pull request permissions." },
        ...(gitRemote ? [{ id: "git" as const, title: `Git token of ${gitRemote}`, description: `Reuse the token Git already uses for ${gitRemote}. Nothing to paste.`, fields: ["optionalEmail" as const] }] : []),
      ];
  }
}

/** The method a reconnect starts with, from the saved account's authentication. */
export function methodOf(kind: ForgeAccountKind, authMode: string | undefined, gitRemote: string | null = null): SignInMethodId {
  const methods = signInMethods(kind, gitRemote);
  return methods.find(m => m.id === authMode && m.id !== "git")?.id ?? methods[0].id;
}

/** The `authMode` the backend expects. A reused Bitbucket Git token is an API token with an email, otherwise a Bearer token. */
export function authModeOf(kind: ForgeAccountKind, method: SignInMethodId, email: string): string {
  if (kind === "bitbucket") return method === "git" ? (email.trim() ? "basic" : "bearer") : method;
  if (kind === "azure") return method === "bearer" ? "bearer" : "token";
  return "token";
}

/** What is still missing before the account can be saved, or "" when the form is complete. */
export function missingInput(kind: ForgeAccountKind, method: SignInMethodId, input: { server: string; email: string; token: string }): string {
  if (!input.server.trim()) return kind === "azure" ? "Enter your Azure DevOps organization URL." : "Enter the server address.";
  const fields = signInMethods(kind, method === "git" ? "git" : null).find(m => m.id === method)?.fields ?? ["token"];
  if (fields.includes("email") && !input.email.trim()) return "Enter your Atlassian email.";
  if (fields.includes("token") && !input.token) return "Paste the token.";
  return "";
}

/** Where to create a token for this method, when the provider has one page for it. */
export function tokenPage(kind: ForgeAccountKind, method: SignInMethodId, server: string): string | null {
  let base: URL;
  try {
    base = new URL(server.trim());
  } catch {
    return null;
  }
  if (base.protocol !== "https:") return null;
  const root = base.href.replace(/\/+$/, "");
  if (kind === "github") return `${root}/settings/tokens`;
  if (kind === "gitlab") return `${root}/-/user_settings/personal_access_tokens`;
  if (kind === "azure") return method === "token" && base.pathname.length > 1 ? `${root}/_usersSettings/tokens` : null;
  if (kind === "bitbucket") return method === "basic" ? "https://id.atlassian.com/manage-profile/security/api-tokens" : null;
  return null;
}
