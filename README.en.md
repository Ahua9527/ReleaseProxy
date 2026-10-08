# ReleaseProxy

[中文](README.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

ReleaseProxy is a GitHub Release download proxy running on Cloudflare Workers. It anonymously
accelerates registered public repositories and uses separate read-only tokens to distribute approved
release assets and native update manifests from private repositories.

- Deploy a fork without editing files; configure products and public repositories through Cloudflare variables.
- Isolate private repository tokens per product and expose only approved assets and essential release metadata.
- Stream installers, manifests, and signatures without changing their bytes.
- Cache latest URLs for 5 minutes, versioned product assets for 1 year, and public repository assets for 7 days.
- MIT licensed; stays on Workers Free without automatically switching to a paid plan.

## Deployment

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Ahua9527/ReleaseProxy)

The button copies the public repository into your GitHub account and deploys through Workers Builds.
Alternatively, fork manually and select your ReleaseProxy repository in the Cloudflare dashboard under
Workers & Pages → Create → Import a repository. Use the repository root; if a deploy command is needed,
use `bunx --bun wrangler deploy`.

The Worker is available at `release-proxy.<account-subdomain>.workers.dev`. Every variable is optional:
without configuration the service starts normally and every path returns 404. Add configuration under
Workers → release-proxy → Settings → Variables and Secrets, then save and deploy the variable changes.
`keep_vars: true` preserves dashboard variables across later code deployments, without repository edits.
[Deploy button](https://developers.cloudflare.com/workers/platform/deploy-buttons/),
[environment variables](https://developers.cloudflare.com/workers/configuration/environment-variables/),
[preserving dashboard variables](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)

## Configuration

| Name                                                   | Type               | Purpose                                                                                                                  |
| ------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `PUBLIC_REPOSITORIES`                                  | Text or JSON array | Public repositories allowed for anonymous acceleration, as `owner/repo`; separate text entries with commas or whitespace |
| `PRODUCTS`                                             | JSON or JSON text  | Private repository product registry; dashboard JSON objects are supported directly                                       |
| `<UPPERCASE PRODUCT ID, - replaced by _>_GITHUB_TOKEN` | Secret             | Separate read-only token per product, e.g. `my-app` → `MY_APP_GITHUB_TOKEN`                                              |

For public acceleration alone, set `PUBLIC_REPOSITORIES`, for example text `jqlang/jq, me/MyApp` or
JSON `["jqlang/jq", "me/MyApp"]`. Repository matching ignores case; upstream URLs use the registered name.

Example `PRODUCTS` value (replace the repository and asset names with your own):

```json
{
  "my-app": {
    "repository": "me/MyApp",
    "assets": [
      "MyApp_{version}_*",
      "MyApp-{version}-*.dmg",
      "MyApp.Setup-{version}-*.exe",
      "latest.json",
      "SHA256SUMS.txt"
    ],
    "latest": {
      "macos-universal.dmg": "MyApp_{version}_universal.dmg",
      "windows-amd64.exe": "MyApp.Setup-{version}-x64.exe",
      "latest.json": "latest.json"
    }
  }
}
```

Field rules:

- Product IDs must match `^[a-z0-9][a-z0-9-]*$`.
- `repository` is required and must be `owner/repo`, never an arbitrary URL.
- `assets` is a required array of allowed asset name patterns. `*` matches any characters except `/`;
  `{version}` expands to the tag with its leading `v` removed. Other characters are literal and the
  entire name must match. A pattern containing `{version}` only matches that tag's own files, preventing
  a different version's file from being attached to the current tag. Prefer explicit allowlists.
- `latest` optionally maps aliases to asset name templates, with the same `{version}` substitution.
  Fixed manifests can map to themselves, e.g. `"latest.json": "latest.json"`. Targets must still match
  `assets`; `*` is not expanded here, so an alias must identify an exact file.
- `tagPattern` is an optional regular expression string, defaulting to `^v?\d+\.\d+\.\d+$`.
  Escape backslashes in JSON, e.g. `"tagPattern": "^v?\\d+\\.\\d+\\.\\d+$"`.
- `publicReleasePage` optionally provides a registered public release page URL. `{tag}` becomes the
  URL-encoded tag. Without it, `html_url` is omitted; private repository page URLs are never forwarded.
- Asset names, templates, and aliases must be nonempty, contain neither `/` nor `\`, and must not be
  `.` or `..`.

Invalid configuration returns 503 for the affected routes and logs `config_invalid`. Invalid `PRODUCTS`
does not affect public acceleration, and an invalid public allowlist does not affect product routes.
A missing product token returns 503 and logs `token_missing`. Never put tokens in `PRODUCTS`, plain
variables, source code, or clients.

## Routes

| Path                                                                  | Behavior                                                         | Cache             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------- |
| `/<id>/releases/latest`                                               | Essential latest stable release metadata and approved asset URLs | 5 minutes         |
| `/<id>/releases/download/<tag>/<asset>`                               | Approved asset from a specific stable release                    | 1 year, immutable |
| `/<id>/latest/<alias>`                                                | Latest asset or manifest alias                                   | 5 minutes         |
| `/https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>`  | Versioned release asset from a registered public repository      | 7 days            |
| `/https://github.com/<owner>/<repo>/releases/latest/download/<asset>` | Latest release asset from a registered public repository         | 5 minutes         |

Only GET is accepted; HEAD and Range are unsupported. Public acceleration also accepts
`/https:/github.com/` and `/github.com/`, including paths where consecutive slashes have been merged.
Example:

```text
https://release-proxy.<account-subdomain>.workers.dev/https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64
```

Product routes reject drafts, prereleases, and tags outside the configured pattern. Metadata contains
only `tag_name`, `published_at`, stable release flags, and approved `assets`. `browser_download_url`
uses the request's own origin. Products must write download URLs into their manifests at build time;
the proxy does not modify signed content.

Only the generic routes above are provided; product root manifest and versioned file routes are absent.

## Private repository tokens

1. In GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens, create a
   token, select the repository owner, and set an appropriate expiration.
2. Under Repository access, choose Only select repositories and select this product's single repository.
3. Set Repository permissions → Contents to Read-only. Complete organization approval if required.
4. Add a Secret in the Cloudflare dashboard using the naming rule above, e.g. `MY_APP_GITHUB_TOKEN`,
   with the token as its value. Create a separate token for every product; there is no shared fallback.

Clients and product publishing workflows do not need these read tokens. Rotate expiring tokens;
a missing or invalid token only affects its product.
[Creating GitHub tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens),
[release asset permissions](https://docs.github.com/en/rest/releases/assets)

## Custom domains

Add a custom domain under Cloudflare Workers → release-proxy → Settings → Domains & Routes.
No personal domain is registered in the repository. `workers.dev` stays enabled for all deployments
and uses the same Worker, allowlists, and account quota as custom domains. Custom domain failures do
not fall back to download URLs that bypass the proxy. Preview URLs remain disabled.
[Custom domain configuration](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

## Security and costs

- Requests cannot choose arbitrary upstream repositories or URLs. Public acceleration only distributes
  registered repositories' release assets, with no product token. Source archives, `archive`, `blob`,
  `releases.atom`, and GitHub API proxying are excluded.
- Product tokens are sent only to the registered repository's GitHub API. Temporary asset redirects
  are limited to HTTPS GitHub asset hosts and receive no token. Public GitHub redirects must stay
  within the same registered repository's release download path.
- Private notes, source archive links, commit details, and author information are not forwarded.
  Logs cover configuration errors, missing tokens, and upstream failures, redact configured product
  tokens, and do not record every invocation.
- Proxy URLs are anonymously accessible, so approved assets become publicly downloadable. Products
  own signing, installation, and release integrity. Upload and verify assets before publishing;
  publishing must reject overwrites of released tags and assets.
- Stay on Workers Free: the account shares 100,000 requests per day across products, public acceleration,
  and other Workers, resetting at midnight UTC. Cache hits also count. The hard limit returns Cloudflare 1027.
- Free Workers allow 64 variables each, including Secrets, with 5 KB per variable. Large `PRODUCTS`
  configurations are subject to that individual limit. The project does not automatically upgrade plans.

[Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workers Cache billing](https://developers.cloudflare.com/workers/cache/)

## Local development and checks

Use the Bun version in `.bun-version` and Node 24 from `.node-version`. Vitest runs on Node;
other checks use Bun. Tool versions are locked in `bun.lock`; runtime code uses standard Web APIs only.

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run format:check
bun run test
bun run build
```

These check lint, types, formatting, tests, and a build without deployment, in order. `bun run build`
only runs Wrangler dry-run to create a local bundle. CI runs the same checks on GitHub-hosted Ubuntu.

For local configuration, use the Git-ignored `.dev.vars`, e.g. `PUBLIC_REPOSITORIES=jqlang/jq` and
single-line JSON text for `PRODUCTS`. Keep test credentials only in `.dev.vars`; never commit them.
Start the local service with:

```bash
node node_modules/wrangler/bin/wrangler.js dev
```

Remove `.dev.vars` to verify unconfigured 404 responses. Mocked upstream tests and local execution
cannot replace downloads on the production domain, real private credentials, and product update validation.

## Acknowledgments and license

Public acceleration behavior was inspired by [asjdf/ghproxy](https://github.com/asjdf/ghproxy);
no code was copied.

[MIT License](LICENSE) · Copyright (c) 2026 Ahua9527
