/** HTTPS addresses of bitbucket.org. SSH remotes (`git@bitbucket.org:…`, `ssh://…`) never ask Git Credential Manager. */
export const bitbucketHttps = (url: string) => /^https?:\/\/([^/@]*@)?bitbucket\.org(:\d+)?(\/|$)/i.test(url.trim());
