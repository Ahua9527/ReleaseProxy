export interface Product {
  repository: string;
  assets: readonly string[];
  latest: Readonly<Record<string, string>>;
  tagPattern: RegExp;
  // 读取令牌的 Secret 名；多个产品可指向同一个 Secret 共用令牌。
  tokenSecret: string;
  // 可选公开页面；{tag} 会替换为经过 URL 编码的 tag。
  publicReleasePage?: string;
}

export type ProductRegistry = Readonly<Record<string, Product>>;

interface Config {
  // undefined 表示该配置无效；空集合表示未配置。
  products: ProductRegistry | undefined;
  // products 无效时记录首个出错的变量名，便于定位。
  invalidProductsVariable?: string;
  publicRepositories: readonly string[] | undefined;
}

type ProductsConfig = Pick<Config, 'products' | 'invalidProductsVariable'>;
type ProductsEntries = readonly (readonly [string, unknown])[];

// PRODUCTS、PRODUCTS1、PRODUCTS2…；只认数字后缀，避免把 PRODUCTS_X_GITHUB_TOKEN 当成配置。
const PRODUCTS_VARIABLE = /^PRODUCTS\d*$/;

let productsCache: { entries: ProductsEntries; value: ProductsConfig } | undefined;
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
        // `*` 紧挨 `{version}` 会让 1.2.3 匹配到 1.2.33，无法保证文件属于当前 tag。
        !item.assets.every(
          (asset) => validName(asset) && !/\*\{version\}|\{version\}\*/.test(asset),
        ) ||
        (item.tagPattern !== undefined && typeof item.tagPattern !== 'string') ||
        // 只接受 Secret 名，避免指向普通变量或误把令牌本身写进配置。
        (item.tokenSecret !== undefined &&
          (typeof item.tokenSecret !== 'string' ||
            !/^[A-Z0-9_]+_GITHUB_TOKEN$/.test(item.tokenSecret))) ||
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
        tokenSecret: item.tokenSecret ?? tokenSecretName(id),
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

function productsEntries(env: Readonly<Record<string, unknown>>): ProductsEntries {
  return Object.keys(env)
    .filter((name) => PRODUCTS_VARIABLE.test(name))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .map((name) => [name, env[name]] as const);
}

// 按变量名顺序合并；任一变量无效或产品 ID 重复时整体无效。
function mergeProducts(entries: ProductsEntries): ProductsConfig {
  const products: Record<string, Product> = {};
  for (const [name, raw] of entries) {
    const parsed = parseProducts(raw);
    if (!parsed || Object.keys(parsed).some((id) => Object.hasOwn(products, id))) {
      return { products: undefined, invalidProductsVariable: name };
    }
    Object.assign(products, parsed);
  }
  return { products };
}

function sameEntries(a: ProductsEntries, b: ProductsEntries): boolean {
  return (
    a.length === b.length &&
    a.every(([name, raw], index) => b[index]?.[0] === name && b[index]?.[1] === raw)
  );
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
  const entries = productsEntries(env);
  if (!productsCache || !sameEntries(productsCache.entries, entries)) {
    productsCache = { entries, value: mergeProducts(entries) };
  }
  if (!repositoriesCache || repositoriesCache.raw !== env.PUBLIC_REPOSITORIES) {
    repositoriesCache = {
      raw: env.PUBLIC_REPOSITORIES,
      value: parseRepositories(env.PUBLIC_REPOSITORIES),
    };
  }
  return { ...productsCache.value, publicRepositories: repositoriesCache.value };
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
