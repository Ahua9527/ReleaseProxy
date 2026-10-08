import { assetMatcher, loadConfig, tokenSecretName } from './config';
import type { Product } from './config';

const GITHUB_API_VERSION = '2026-03-10';
const LATEST_CACHE = 'public, max-age=300';
const VERSIONED_CACHE = 'public, max-age=31536000, immutable';
const MIRROR_PREFIX = /^\/(?:https?:\/\/?)?github\.com(?=\/)/i;
const MIRROR_CACHE = 'public, max-age=604800';

export type Env = Readonly<Record<string, unknown>>;

interface GithubAsset {
  id: number;
  name: string;
  size: number;
  state: string;
}

interface GithubRelease {
  draft: boolean;
  prerelease: boolean;
  tag_name: string;
  published_at: string;
  assets: GithubAsset[];
}

type Route =
  | { kind: 'metadata' }
  | { kind: 'alias'; alias: string }
  | { kind: 'versioned'; tag: string; name: string };

interface MirrorRoute {
  repository: string;
  tag?: string;
  name: string;
}

class ProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly upstream?: number,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRelease(value: unknown): GithubRelease {
  if (
    !isRecord(value) ||
    typeof value.draft !== 'boolean' ||
    typeof value.prerelease !== 'boolean' ||
    typeof value.tag_name !== 'string' ||
    typeof value.published_at !== 'string' ||
    !Array.isArray(value.assets)
  ) {
    throw new ProxyError(502, 'GitHub release response is invalid');
  }

  const assets: GithubAsset[] = [];
  for (const item of value.assets) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'number' ||
      !Number.isSafeInteger(item.id) ||
      item.id <= 0 ||
      typeof item.name !== 'string' ||
      typeof item.size !== 'number' ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      typeof item.state !== 'string'
    ) {
      throw new ProxyError(502, 'GitHub release response is invalid');
    }
    assets.push({ id: item.id, name: item.name, size: item.size, state: item.state });
  }

  return {
    draft: value.draft,
    prerelease: value.prerelease,
    tag_name: value.tag_name,
    published_at: value.published_at,
    assets,
  };
}

function responseHeaders(cacheControl: string, type: string): Headers {
  return new Headers({
    'Cache-Control': cacheControl,
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
  });
}

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: responseHeaders('no-store', 'text/plain; charset=utf-8'),
  });
}

function decodePath(pathname: string): string[] | undefined {
  try {
    const parts = pathname.split('/').slice(1).map(decodeURIComponent);
    if (
      parts.some(
        (part) =>
          !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\'),
      )
    )
      return undefined;
    return parts;
  } catch {
    return undefined;
  }
}

function versionedRoute(product: Product, tag: string, name: string): Route | undefined {
  if (!product.tagPattern.test(tag) || !isAllowedAsset(product, tag, name)) return undefined;
  return { kind: 'versioned', tag, name };
}

function isAllowedAsset(product: Product, tag: string, name: string): boolean {
  return product.assets.some((pattern) => assetMatcher(pattern, tag.replace(/^v/, '')).test(name));
}

function resolveRoute(product: Product, path: string[]): Route | undefined {
  if (path.length === 2 && path[0] === 'releases' && path[1] === 'latest') {
    return { kind: 'metadata' };
  }
  if (path.length === 4 && path[0] === 'releases' && path[1] === 'download' && path[2] && path[3]) {
    return versionedRoute(product, path[2], path[3]);
  }
  if (
    path.length === 2 &&
    path[0] === 'latest' &&
    path[1] &&
    Object.hasOwn(product.latest, path[1])
  ) {
    return { kind: 'alias', alias: path[1] };
  }
  return undefined;
}

function resolveMirror(path: string[], mirrors: readonly string[]): MirrorRoute | undefined {
  const [owner, repo, section, action, tag, name] = path;
  if (path.length !== 6 || !owner || !repo || section !== 'releases' || !name) return undefined;
  const repository = mirrors.find(
    (mirror) => mirror.toLowerCase() === `${owner}/${repo}`.toLowerCase(),
  );
  if (!repository) return undefined;
  if (action === 'download' && tag) return { repository, tag, name };
  if (action === 'latest' && tag === 'download') return { repository, name };
  return undefined;
}

async function getRelease(
  product: Product,
  token: string,
  tag: string | undefined,
  fetcher: typeof fetch,
): Promise<GithubRelease> {
  const suffix = tag ? `/tags/${encodeURIComponent(tag)}` : '/latest';
  const response = await fetcher(
    `https://api.github.com/repos/${product.repository}/releases${suffix}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'ReleaseProxy',
      },
      redirect: 'manual',
    },
  );
  if (response.status === 404) throw new ProxyError(404, 'Release not found');
  if (response.status !== 200)
    throw new ProxyError(502, 'GitHub release lookup failed', response.status);
  const release = parseRelease(await response.json());
  if (
    release.draft ||
    release.prerelease ||
    !product.tagPattern.test(release.tag_name) ||
    (tag !== undefined && release.tag_name !== tag)
  ) {
    throw new ProxyError(404, 'Release not found');
  }
  return release;
}

function releaseMetadata(
  origin: string,
  id: string,
  product: Product,
  release: GithubRelease,
): Response {
  const base = `${origin}/${encodeURIComponent(id)}/releases/download/${encodeURIComponent(release.tag_name)}`;
  const metadata = {
    tag_name: release.tag_name,
    published_at: release.published_at,
    draft: false,
    prerelease: false,
    assets: release.assets
      .filter(
        (asset) =>
          asset.state === 'uploaded' && isAllowedAsset(product, release.tag_name, asset.name),
      )
      .map((asset) => ({
        name: asset.name,
        size: asset.size,
        browser_download_url: `${base}/${encodeURIComponent(asset.name)}`,
      })),
    ...(product.publicReleasePage
      ? {
          html_url: product.publicReleasePage.replaceAll(
            '{tag}',
            encodeURIComponent(release.tag_name),
          ),
        }
      : {}),
  };
  return new Response(JSON.stringify(metadata), {
    headers: responseHeaders(LATEST_CACHE, 'application/json; charset=utf-8'),
  });
}

async function downloadAsset(
  product: Product,
  token: string,
  asset: GithubAsset,
  fetcher: typeof fetch,
): Promise<Response> {
  const response = await fetcher(
    `https://api.github.com/repos/${product.repository}/releases/assets/${asset.id}`,
    {
      headers: {
        Accept: 'application/octet-stream',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'ReleaseProxy',
      },
      redirect: 'manual',
    },
  );
  if (response.status === 200 && response.body) return response;
  if (response.status !== 302)
    throw new ProxyError(502, 'GitHub asset download failed', response.status);

  const target = redirectTarget(response.headers.get('Location'));

  // 临时下载地址只接收匿名请求，产品令牌始终留在 GitHub API 请求中。
  const redirected = await fetcher(target, { redirect: 'manual' });
  if (redirected.status !== 200 || !redirected.body)
    throw new ProxyError(502, 'GitHub asset download failed', redirected.status);
  return redirected;
}

function redirectTarget(location: string | null, allowedGithubPath?: string): URL {
  let target: URL;
  try {
    target = new URL(location ?? '');
  } catch {
    throw new ProxyError(502, 'GitHub asset redirect is invalid');
  }
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    !(
      target.hostname === 'githubusercontent.com' ||
      target.hostname.endsWith('.githubusercontent.com') ||
      (allowedGithubPath &&
        target.hostname === 'github.com' &&
        target.pathname.startsWith(allowedGithubPath))
    )
  ) {
    throw new ProxyError(502, 'GitHub asset redirect host is not allowed');
  }

  return target;
}

function contentType(name: string): string {
  if (name.endsWith('.json')) return 'application/json; charset=utf-8';
  if (name.endsWith('.xml')) return 'application/xml; charset=utf-8';
  if (name.endsWith('.yml') || name.endsWith('.yaml')) return 'application/yaml; charset=utf-8';
  if (name.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (name.endsWith('.dmg')) return 'application/x-apple-diskimage';
  return 'application/octet-stream';
}

async function serveRoute(
  origin: string,
  id: string,
  product: Product,
  route: Route,
  token: string,
  fetcher: typeof fetch,
): Promise<Response> {
  const release = await getRelease(
    product,
    token,
    route.kind === 'versioned' ? route.tag : undefined,
    fetcher,
  );
  if (route.kind === 'metadata') return releaseMetadata(origin, id, product, release);
  const name =
    route.kind === 'alias'
      ? product.latest[route.alias]?.replaceAll('{version}', release.tag_name.replace(/^v/, ''))
      : route.name;
  if (!name || !isAllowedAsset(product, release.tag_name, name))
    throw new ProxyError(404, 'Release asset not found');
  const asset = release.assets.find(
    (candidate) => candidate.name === name && candidate.state === 'uploaded',
  );
  if (!asset || asset.size <= 0) throw new ProxyError(404, 'Release asset not found');
  const response = await downloadAsset(product, token, asset, fetcher);
  const headers = responseHeaders(
    route.kind === 'versioned' ? VERSIONED_CACHE : LATEST_CACHE,
    contentType(name),
  );
  headers.set('Content-Length', String(asset.size));
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  return new Response(response.body, { headers });
}

async function serveMirror(route: MirrorRoute, fetcher: typeof fetch): Promise<Response> {
  const base = `https://github.com/${route.repository}/releases`;
  let url: string | URL = route.tag
    ? `${base}/download/${encodeURIComponent(route.tag)}/${encodeURIComponent(route.name)}`
    : `${base}/latest/download/${encodeURIComponent(route.name)}`;
  let upstream: number | undefined;
  for (let hop = 0; hop < 3; hop += 1) {
    const response = await fetcher(url, {
      headers: { 'User-Agent': 'ReleaseProxy' },
      redirect: 'manual',
    });
    upstream = response.status;
    if (response.status === 200 && response.body) {
      const headers = responseHeaders(
        route.tag ? MIRROR_CACHE : LATEST_CACHE,
        contentType(route.name),
      );
      const length = response.headers.get('Content-Length');
      if (length !== null) headers.set('Content-Length', length);
      headers.set(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(route.name)}`,
      );
      return new Response(response.body, { headers });
    }
    if ([301, 302, 307, 308].includes(response.status)) {
      url = redirectTarget(
        response.headers.get('Location'),
        `/${route.repository}/releases/download/`,
      );
      continue;
    }
    if (response.status === 404) throw new ProxyError(404, 'Release asset not found');
    throw new ProxyError(502, 'GitHub asset download failed', response.status);
  }
  throw new ProxyError(502, 'GitHub asset download failed', upstream);
}

export function createHandler(fetcher: typeof fetch = fetch) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      if (request.method !== 'GET') {
        const response = errorResponse(405, 'Method not allowed');
        response.headers.set('Allow', 'GET');
        return response;
      }
      const { pathname, origin } = new URL(request.url);
      const config = loadConfig(env);
      const registry = config.products;
      let context: { product?: string; repository?: string; route: string } | undefined;
      try {
        if (MIRROR_PREFIX.test(pathname)) {
          if (!config.publicRepositories) return configInvalid('PUBLIC_REPOSITORIES');
          const path = decodePath(pathname.replace(MIRROR_PREFIX, ''));
          const route = path ? resolveMirror(path, config.publicRepositories) : undefined;
          if (!route) return errorResponse(404, 'Not found');
          context = {
            repository: route.repository,
            route: route.tag ? 'versioned' : 'latest-file',
          };
          return await serveMirror(route, fetcher);
        }
        const path = decodePath(pathname);
        const id = path?.[0];
        if (!path || !id) return errorResponse(404, 'Not found');
        if (!registry) return configInvalid('PRODUCTS');
        if (!Object.hasOwn(registry, id)) return errorResponse(404, 'Not found');
        const product = registry[id];
        if (!product) return errorResponse(404, 'Not found');
        const route = resolveRoute(product, path.slice(1));
        if (!route) return errorResponse(404, 'Not found');
        context = { product: id, route: route.kind };
        const rawToken = env[tokenSecretName(id)];
        const token = typeof rawToken === 'string' ? rawToken.trim() : undefined;
        if (!token) {
          console.error(
            JSON.stringify({
              event: 'token_missing',
              ...context,
              status: 503,
              message: 'Update origin is unavailable',
            }),
          );
          return errorResponse(503, 'Update origin is unavailable');
        }
        return await serveRoute(origin, id, product, route, token, fetcher);
      } catch (error) {
        const status = error instanceof ProxyError ? error.status : 502;
        if (status >= 500) {
          let name = error instanceof Error ? error.name : 'Error';
          let message = error instanceof Error ? error.message : 'Unknown error';
          // 异常消息可能包含调用方抛出的凭据，写日志前遮蔽已配置的产品令牌。
          for (const id of Object.keys(registry ?? {})) {
            const rawToken = env[tokenSecretName(id)];
            const token = typeof rawToken === 'string' ? rawToken.trim() : undefined;
            if (token) {
              name = name.replaceAll(token, '[redacted]');
              message = message.replaceAll(token, '[redacted]');
            }
          }
          console.error(
            JSON.stringify({
              event: 'upstream_failure',
              ...context,
              status,
              ...(error instanceof ProxyError ? { upstream: error.upstream } : { name }),
              message,
            }),
          );
        }
        if (error instanceof ProxyError) return errorResponse(error.status, error.message);
        return errorResponse(502, 'Update origin is unavailable');
      }
    },
  };
}

function configInvalid(variable: string): Response {
  console.error(
    JSON.stringify({
      event: 'config_invalid',
      variable,
      status: 503,
      message: 'Proxy configuration is invalid',
    }),
  );
  return errorResponse(503, 'Proxy configuration is invalid');
}

export default createHandler();
