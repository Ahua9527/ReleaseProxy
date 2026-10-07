export interface Product {
  repository: string;
  tokenSecret: string;
  tagPattern: RegExp;
  latestFiles: Readonly<Record<string, string>>;
  latestAliases: Readonly<Record<string, (tag: string) => string>>;
  isAllowedAsset: (tag: string, name: string) => boolean;
  // 原生更新器使用目录中的版本化文件时，解析文件所属的 Release tag。
  fileTag?: (name: string) => string | undefined;
  // 可选公开页面；{tag} 会替换为经过 URL 编码的 tag。
  publicReleasePage?: string;
}

export type ProductRegistry = Readonly<Record<string, Product>>;

const targets = ['darwin-universal', 'windows-amd64', 'windows-arm64'] as const;
const versionPattern = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const targetPattern = targets.join('|');
const archivePattern = new RegExp(`^ipg-scope-(${versionPattern})-(${targetPattern})\\.tar\\.gz$`);
const deltaPattern = new RegExp(
  `^ipg-scope-${versionPattern}-to-(${versionPattern})-(${targetPattern})\\.delta$`,
);
const latestFiles = Object.fromEntries(
  targets.map((target) => [`update-${target}.json`, `update-${target}.json`]),
);
const latestAliases: Product['latestAliases'] = {
  'macos-universal.dmg': (tag) => `IPG.Scope-${tag.slice(1)}-darwin-universal.dmg`,
  'windows-amd64.exe': (tag) => `IPG.Scope.Setup-${tag.slice(1)}-windows-amd64.exe`,
  'windows-arm64.exe': (tag) => `IPG.Scope.Setup-${tag.slice(1)}-windows-arm64.exe`,
};

export const products: ProductRegistry = {
  'ipg-scope': {
    repository: 'Ahua9527/IPG-Scope',
    tokenSecret: 'IPG_SCOPE_RELEASES_READ_TOKEN',
    tagPattern: new RegExp(`^v${versionPattern}$`),
    latestFiles,
    latestAliases,
    isAllowedAsset(tag, name) {
      if (Object.hasOwn(latestFiles, name) || name === 'SHA256SUMS.txt') return true;
      if (Object.values(latestAliases).some((makeName) => makeName(tag) === name)) return true;
      const archive = archivePattern.exec(name);
      const delta = deltaPattern.exec(name);
      return archive?.[1] === tag.slice(1) || delta?.[1] === tag.slice(1);
    },
    fileTag(name) {
      const version = archivePattern.exec(name)?.[1] ?? deltaPattern.exec(name)?.[1];
      return version ? `v${version}` : undefined;
    },
  },
};
