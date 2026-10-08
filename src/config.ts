export interface Product {
  repository: string;
  assets: readonly string[];
  latest: Readonly<Record<string, string>>;
  tagPattern: RegExp;
  // 可选公开页面；{tag} 会替换为经过 URL 编码的 tag。
  publicReleasePage?: string;
}

export type ProductRegistry = Readonly<Record<string, Product>>;

interface Config {
  // undefined 表示该配置无效；空集合表示未配置。
  products: ProductRegistry | undefined;
  publicRepositories: readonly string[] | undefined;
}

let productsCache: { raw: unknown; value: Config['products'] } | undefined;
let repositoriesCache: { raw: unknown; value: Config['publicRepositories'] } | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validRepository(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(value) &&
    !['.', '..'].includes(value.split('/')[1] ?? '')
  );
}

function validName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !/[/\\]/.test(value)
  );
}

function parseProducts(raw: unknown): Config['products'] {
  if (raw === undefined || raw === '') return {};
  try {
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!isRecord(value)) return undefined;
    const products: Record<string, Product> = {};
    for (const [id, item] of Object.entries(value)) {
      if (
        !/^[a-z0-9][a-z0-9-]*$/.test(id) ||
        !isRecord(item) ||
        !validRepository(item.repository) ||
        !Array.isArray(item.assets) ||
        !item.assets.every(validName) ||
        (item.tagPattern !== undefined && typeof item.tagPattern !== 'string') ||
        (item.publicReleasePage !== undefined && typeof item.publicReleasePage !== 'string')
      )
        return undefined;
      const latest = item.latest === undefined ? {} : item.latest;
      if (
        !isRecord(latest) ||
        !Object.entries(latest).every(
          ([alias, template]) => validName(alias) && validName(template),
        )
      )
        return undefined;
      products[id] = {
        repository: item.repository,
        assets: [...item.assets],
        latest: { ...latest } as Record<string, string>,
        tagPattern: new RegExp(item.tagPattern ?? '^v?\\d+\\.\\d+\\.\\d+$'),
        ...(item.publicReleasePage !== undefined
          ? { publicReleasePage: item.publicReleasePage }
          : {}),
      };
    }
    return products;
  } catch {
    return undefined;
  }
}

function parseRepositories(raw: unknown): Config['publicRepositories'] {
  if (raw === undefined || raw === '') return [];
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.split(/[,\s]+/).filter(Boolean);
    } catch {
      return undefined;
    }
  }
  return Array.isArray(value) && value.every(validRepository) ? [...value] : undefined;
}

export function loadConfig(env: Readonly<Record<string, unknown>>): Config {
  if (!productsCache || productsCache.raw !== env.PRODUCTS) {
    productsCache = { raw: env.PRODUCTS, value: parseProducts(env.PRODUCTS) };
  }
  if (!repositoriesCache || repositoriesCache.raw !== env.PUBLIC_REPOSITORIES) {
    repositoriesCache = {
      raw: env.PUBLIC_REPOSITORIES,
      value: parseRepositories(env.PUBLIC_REPOSITORIES),
    };
  }
  return { products: productsCache.value, publicRepositories: repositoriesCache.value };
}

export function tokenSecretName(id: string): string {
  return `${id.toUpperCase().replaceAll('-', '_')}_GITHUB_TOKEN`;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function assetMatcher(pattern: string, version: string): RegExp {
  const source = pattern
    .split(/(\*|\{version\})/)
    .map((part) => {
      if (part === '*') return '[^/]*';
      if (part === '{version}') return escapePattern(version);
      return escapePattern(part);
    })
    .join('');
  return new RegExp(`^${source}$`);
}
