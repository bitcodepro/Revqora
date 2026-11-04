import { describe, expect, it } from "vitest";
import { bitbucketPromptKind as parse } from "./bitbucketCredentials";
const bitbucketPromptKind = (prompt: string) => parse(prompt, "git");
describe("Bitbucket Cloud Git token prompts", () => {
  it("never offers saved tokens or Bitbucket hints for SSH or missing provenance", () => {
    for (const origin of ["ssh", undefined, "", "https"]) {
      expect(parse("Password for 'https://bitbucket.org': ", origin)).toBeNull();
      expect(parse("Username for 'https://bitbucket.org': ", origin)).toBeNull();
    }
  });
  it("recognizes only exact HTTPS destinations for username and password hints", () => {
    expect(bitbucketPromptKind("Username for 'https://bitbucket.org': ")).toBe("username");
    expect(bitbucketPromptKind("Password for 'https://x-bitbucket-api-token-auth@bitbucket.org/workspace/repo.git': ")).toBe("secret");
    expect(bitbucketPromptKind("Password for 'https://x-token-auth@bitbucket.org:443': ")).toBe("secret");
    for (const address of ["http://bitbucket.org", "ssh://git@bitbucket.org", "https://bitbucket.org.evil.invalid", "https://bitbucket.org@evil.invalid", "https://bitbucket.org:8443", "https://bitbucket.org?host=evil", "https://bitbucket.org/#fake", "https://me:secret@bitbucket.org", "https://bitbucket.org\\@evil.invalid"]) {
      expect(bitbucketPromptKind(`Password for '${address}': `)).toBeNull();
    }
    expect(bitbucketPromptKind("Password for 'https://elsewhere.invalid': https://bitbucket.org ")).toBeNull();
    expect(bitbucketPromptKind("Enter passphrase for key 'bitbucket.org': ")).toBeNull();
  });
});
