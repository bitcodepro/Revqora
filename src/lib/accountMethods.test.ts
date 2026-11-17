import { describe, expect, it } from "vitest";
import { authModeOf, methodOf, missingInput, providerServers, signInMethods, tokenPage } from "./accountMethods";

describe("account sign-in methods", () => {
  it("offers one token method for GitHub and GitLab and two for Azure DevOps", () => {
    expect(signInMethods("github").map(m => m.id)).toEqual(["token"]);
    expect(signInMethods("gitlab").map(m => m.id)).toEqual(["token"]);
    expect(signInMethods("azure").map(m => m.id)).toEqual(["token", "bearer"]);
  });

  it("offers the Git token of a Bitbucket remote only when there is one", () => {
    expect(signInMethods("bitbucket").map(m => m.id)).toEqual(["basic", "bearer"]);
    const withRemote = signInMethods("bitbucket", "origin");
    expect(withRemote.map(m => m.id)).toEqual(["basic", "bearer", "git"]);
    expect(withRemote[2].title).toBe("Git token of origin");
    expect(withRemote[2].fields).toEqual(["optionalEmail"]);
  });

  it("asks only for the fields of the chosen method", () => {
    expect(signInMethods("bitbucket")[0].fields).toEqual(["email", "token"]);
    expect(signInMethods("bitbucket")[1].fields).toEqual(["token"]);
    for (const kind of ["github", "gitlab", "azure"] as const) for (const m of signInMethods(kind)) expect(m.fields).toEqual(["token"]);
  });

  it("starts a reconnect with the saved method and falls back to the default", () => {
    expect(methodOf("bitbucket", "bearer")).toBe("bearer");
    expect(methodOf("bitbucket", "basic")).toBe("basic");
    expect(methodOf("bitbucket", undefined)).toBe("basic");
    expect(methodOf("bitbucket", "git", "origin")).toBe("basic");
    expect(methodOf("azure", "bearer")).toBe("bearer");
    expect(methodOf("github", "basic")).toBe("token");
  });

  it("maps methods to the authentication the backend expects", () => {
    expect(authModeOf("github", "token", "")).toBe("token");
    expect(authModeOf("gitlab", "token", "x@example.invalid")).toBe("token");
    expect(authModeOf("azure", "bearer", "")).toBe("bearer");
    expect(authModeOf("azure", "token", "")).toBe("token");
    expect(authModeOf("bitbucket", "basic", "")).toBe("basic");
    expect(authModeOf("bitbucket", "bearer", "x@example.invalid")).toBe("bearer");
    // A reused Git token with an email is an API token; without one it is a Bearer token.
    expect(authModeOf("bitbucket", "git", "x@example.invalid")).toBe("basic");
    expect(authModeOf("bitbucket", "git", "  ")).toBe("bearer");
  });

  it("names the first missing input", () => {
    const full = { server: "https://bitbucket.org", email: "x@example.invalid", token: "secret-token" };
    expect(missingInput("bitbucket", "basic", full)).toBe("");
    expect(missingInput("bitbucket", "basic", { ...full, email: " " })).toBe("Enter your Atlassian email.");
    expect(missingInput("bitbucket", "basic", { ...full, token: "" })).toBe("Paste the token.");
    expect(missingInput("bitbucket", "bearer", { ...full, email: "" })).toBe("");
    expect(missingInput("bitbucket", "git", { ...full, email: "", token: "" })).toBe("");
    expect(missingInput("github", "token", { ...full, server: "" })).toBe("Enter the server address.");
    expect(missingInput("azure", "token", { ...full, server: providerServers.azure })).toBe("Enter your Azure DevOps organization URL.");
  });

  it("links to the page that creates the token, only over HTTPS", () => {
    expect(tokenPage("github", "token", "https://github.com")).toBe("https://github.com/settings/tokens");
    expect(tokenPage("github", "token", "https://git.example.com/")).toBe("https://git.example.com/settings/tokens");
    expect(tokenPage("gitlab", "token", "https://gitlab.example.com/gitlab")).toBe("https://gitlab.example.com/gitlab/-/user_settings/personal_access_tokens");
    expect(tokenPage("azure", "token", "https://dev.azure.com/contoso")).toBe("https://dev.azure.com/contoso/_usersSettings/tokens");
    expect(tokenPage("azure", "token", "https://dev.azure.com")).toBeNull();
    expect(tokenPage("azure", "bearer", "https://dev.azure.com/contoso")).toBeNull();
    expect(tokenPage("bitbucket", "basic", "https://bitbucket.org")).toBe("https://id.atlassian.com/manage-profile/security/api-tokens");
    expect(tokenPage("bitbucket", "bearer", "https://bitbucket.org")).toBeNull();
    expect(tokenPage("github", "token", "http://127.0.0.1:8080")).toBeNull();
    expect(tokenPage("github", "token", "not a url")).toBeNull();
  });
});
