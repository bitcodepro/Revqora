import { describe, expect, it } from "vitest";
import { bitbucketHttps } from "./bitbucketHttps";

describe("bitbucketHttps", () => {
  it("matches HTTPS bitbucket.org remotes, with or without a user name", () => {
    expect(bitbucketHttps("https://bitbucket.org/team/repo.git")).toBe(true);
    expect(bitbucketHttps("https://someone@bitbucket.org/team/repo.git")).toBe(true);
    expect(bitbucketHttps("HTTPS://BITBUCKET.ORG/team/repo")).toBe(true);
  });

  it("does not match SSH remotes or other hosts", () => {
    expect(bitbucketHttps("git@bitbucket.org:team/repo.git")).toBe(false);
    expect(bitbucketHttps("ssh://git@bitbucket.org/team/repo.git")).toBe(false);
    expect(bitbucketHttps("https://bitbucket.org.example.com/team/repo.git")).toBe(false);
    expect(bitbucketHttps("https://git.example.com/bitbucket.org/repo.git")).toBe(false);
    expect(bitbucketHttps("")).toBe(false);
  });
});
