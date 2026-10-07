# ReleaseProxy

ReleaseProxy 将多个产品的私有 GitHub Release 中获准的发布文件，通过
`https://updates.ahua.space/<product>/` 提供下载及原生自动更新。

产品源码和 Release 页面保持私有；获准资产的代理地址可以被任何人使用。各产品负责生成
自己的更新清单、签名和安装包，ReleaseProxy 原字节分发这些文件。

当前登记 `ipg-scope`，上游为 `Ahua9527/IPG-Scope`。源项目可以独立构建与发布，双方没有
源码、子模块或包依赖。

## 接口

| 路径                                         | 行为                                      | 缓存         |
| -------------------------------------------- | ----------------------------------------- | ------------ |
| `/<product>/releases/latest`                 | 最新稳定 Release 的必要信息和获准资产链接 | 5 分钟       |
| `/<product>/releases/download/<tag>/<asset>` | 指定稳定 Release 中的白名单资产           | 1 年、不可变 |
| `/<product>/latest/<alias>`                  | 登记的最新安装包或文件别名                | 5 分钟       |
| `/<product>/<native-manifest>`               | 登记的原生更新清单                        | 5 分钟       |

只接收 GET。未知产品、路径、资产、tag 和草稿 / 预发布版本均拒绝。文件响应流式转发，
GitHub 的临时下载跳转仅允许 HTTPS GitHub 资产域名，且不携带产品令牌。

Release 信息只含 `tag_name`、`published_at`、稳定版标志和获准的 `assets`；资产的
`browser_download_url` 使用代理地址。配置了 `publicReleasePage` 时才返回 `html_url`。
更新清单中的下载 URL 必须由产品构建时写入，代理不修改带签名的文件内容。

IPG Scope 既有地址保持可用：

- `/ipg-scope/update-darwin-universal.json`
- `/ipg-scope/update-windows-amd64.json`
- `/ipg-scope/update-windows-arm64.json`
- `/ipg-scope/ipg-scope-<version>-<target>.tar.gz` 与对应 `.delta`
- `/ipg-scope/latest/macos-universal.dmg`
- `/ipg-scope/latest/windows-amd64.exe`
- `/ipg-scope/latest/windows-arm64.exe`

## 登记产品

在 `src/products.ts` 增加产品，指定私有仓库、独立 Secret 名称、tag 规则、清单文件和安装包
别名，以及白名单判断函数。通用版本路径可分发任意已登记原生格式；`fileTag` 仅在原生更新器
需要目录中的版本化文件地址时设置。

例如另一产品可以使用 `r1` tag 和自己的 XML 更新清单：

```ts
sample: {
  repository: 'Ahua9527/Sample',
  tokenSecret: 'SAMPLE_RELEASES_READ_TOKEN',
  tagPattern: /^r[0-9]+$/,
  latestFiles: { 'appcast.xml': 'appcast.xml' },
  latestAliases: { 'desktop.zip': () => 'app.zip' },
  isAllowedAsset: (_tag, name) => ['appcast.xml', 'app.zip'].includes(name),
  publicReleasePage: 'https://sample.example/releases/{tag}',
}
```

将对应 Secret 名加入 `wrangler.json` 的 `secrets.required`。为该产品单独创建细粒度 GitHub
令牌，只选择该产品仓库并授予 `Contents: read`，通过 Wrangler 提示输入保存：

```bash
bunx --bun wrangler secret put IPG_SCOPE_RELEASES_READ_TOKEN
```

其他产品使用各自的 Secret 名。令牌缺失或失效只影响对应产品；不要设置共用令牌回退。
本地调试可把测试凭据放入被 Git 忽略的 `.dev.vars`。客户端和产品发布工作流均不需要这些读取令牌。
[GitHub 资产接口与权限说明](https://docs.github.com/en/rest/releases/assets)

产品发布顺序是构建并签名、创建私有草稿、上传及验证所有资产、发布稳定 Release。
版本 tag 与资产必须保持不可变，否则长期缓存可能仍提供先前版本的内容。

## 本地检查与 CI

环境为 `.bun-version` 指定的 Bun，Vitest 使用 Node 24。工具依赖及 Wrangler 均固定版本并
由 `bun.lock` 锁定；Worker 运行期只使用标准 Web API。

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run format:check
bun run test
bun run build
```

`bun run build` 只生成本地 Worker bundle，不部署。CI 使用自托管 macOS ARM64，包含同一组
检查；新仓库需要单独登记运行器后才能执行真实 CI。本轮仅完成代码和本地验收。

## 部署与费用

部署配置只绑定 `updates.ahua.space`，关闭 `workers.dev` 和预览 URL，并启用 Workers Cache。
完成每产品 Secret、Cloudflare 域名和 Free 计划核查后，维护者可显式部署：

```bash
bunx --bun wrangler deploy
```

保持 Workers Free。100,000 次每日请求额度属于整个账号，UTC 零点重置；所有产品及该账号
其他 Worker 共享额度，缓存命中同样计入。达到上限后 Cloudflare 返回 1027；自定义域名以
Worker 为源站，没有绕过代理的回退入口。服务不自动切换到付费计划。
[Cloudflare 请求限额](https://developers.cloudflare.com/workers/platform/limits/)、
[Workers Cache 计费](https://developers.cloudflare.com/workers/cache/)

当前尚未配置产品 Secret、部署 Worker 或验收在线升级；Wrangler dry-run 与模拟上游测试
不能替代正式域名上的真实下载及产品升级验收。
