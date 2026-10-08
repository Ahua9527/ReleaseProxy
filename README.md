# ReleaseProxy

[English](README.en.md) · [安全报告](SECURITY.md) · [参与贡献](CONTRIBUTING.md)

ReleaseProxy 是运行在 Cloudflare Workers 上的 GitHub Release 下载代理：匿名加速登记的
公开仓库，也可用独立只读令牌分发私有仓库中获准的发布附件与原生更新清单。

- fork 后无需改文件即可部署；产品与公开仓库白名单都通过 Cloudflare 变量配置。
- 私有仓库按产品隔离令牌，仅公开登记附件与必要 Release 信息。
- 安装包、更新清单与签名保持原字节，文件流式转发。
- 最新地址缓存 5 分钟；私有产品的版本化附件缓存 1 年，公开仓库附件缓存 7 天。
- MIT 许可，保持 Workers Free，不自动切换付费计划。

## 部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Ahua9527/ReleaseProxy)

点击按钮，将公开仓库复制到自己的 GitHub 账号，并通过 Workers Builds 部署。
也可以手动 fork，然后在 Cloudflare 控制台「Workers 和 Pages → 创建 → 导入仓库」选择
自己的 ReleaseProxy 仓库。使用仓库根目录；如需填写部署命令，使用
`bunx --bun wrangler deploy`。

部署后得到 `release-proxy.<账号子域名>.workers.dev`。所有变量均可选，未配置时服务正常
启动，所有路径返回 404。在「Workers → release-proxy → 设置 → 变量和机密」添加配置，
保存并部署变量变更。`keep_vars: true` 会保留控制台配置，后续代码部署无需修改仓库文件。
[部署按钮说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)、
[变量配置](https://developers.cloudflare.com/workers/configuration/environment-variables/)、
[保留控制台变量](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)

## 配置参考

| 名称                                  | 类型                 | 作用                                                            |
| ------------------------------------- | -------------------- | --------------------------------------------------------------- |
| `PUBLIC_REPOSITORIES`                 | 文本或 JSON 数组     | 允许匿名加速的公开仓库，使用 `owner/repo`；文本用逗号或空白分隔 |
| `PRODUCTS`                            | JSON 或文本形式 JSON | 私有仓库产品登记；控制台 JSON 类型可直接使用对象                |
| `<产品 ID 大写，- 换 _>_GITHUB_TOKEN` | Secret               | 产品独立只读令牌，例如 `my-app` → `MY_APP_GITHUB_TOKEN`         |

仅需要公开加速时，设置 `PUBLIC_REPOSITORIES` 即可，例如文本 `jqlang/jq, me/MyApp`，
或 JSON 数组 `["jqlang/jq", "me/MyApp"]`。请求中的仓库名忽略大小写，上游使用登记名称。

`PRODUCTS` 示例（请换成自己的仓库与附件名）：

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

字段规则：

- 产品 ID 必须匹配 `^[a-z0-9][a-z0-9-]*$`。
- `repository` 必填，使用 `owner/repo`，不接受任意 URL。
- `assets` 必填，为允许公开的附件名模式数组。`*` 匹配任意字符但不含 `/`；`{version}`
  替换为 tag 去掉开头 `v` 后的版本号。其余字符按字面匹配，整串匹配；含 `{version}` 的
  模式只匹配该 tag 自己的文件，不能把另一版本文件挂到当前 tag。尽量使用明确的白名单。
- `latest` 可选，别名映射到附件名模板，使用相同的 `{version}` 替换规则。固定清单可映射
  到自身，如 `"latest.json": "latest.json"`。别名对应的文件仍须符合 `assets` 白名单；这里的
  `*` 不展开，别名必须指向确定文件。
- `tagPattern` 可选，为正则表达式字符串，默认 `^v?\d+\.\d+\.\d+$`；JSON 中反斜线要
  双写，例如 `"tagPattern": "^v?\\d+\\.\\d+\\.\\d+$"`。
- `publicReleasePage` 可选，为登记的公开 Release 页面地址，`{tag}` 替换为 URL 编码后的
  tag。未设置时不返回 `html_url`，不会透传私有仓库页面地址。
- 附件名、模板和别名不得为空或包含 `/`、`\`，也不得为 `.` 或 `..`。

无效配置使对应路由返回 503，日志事件为 `config_invalid`。`PRODUCTS` 无效不影响公开
加速，公开名单无效也不影响产品路由；产品缺少令牌时返回 503 并记录 `token_missing`。
不要把令牌放入 `PRODUCTS`、普通变量、源码或客户端。

## 接口

| 路径                                                                  | 行为                                    | 缓存         |
| --------------------------------------------------------------------- | --------------------------------------- | ------------ |
| `/<id>/releases/latest`                                               | 最新稳定 Release 必要信息与获准附件链接 | 5 分钟       |
| `/<id>/releases/download/<tag>/<asset>`                               | 指定稳定 Release 的获准附件             | 1 年、不可变 |
| `/<id>/latest/<alias>`                                                | 最新版附件或清单别名                    | 5 分钟       |
| `/https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>`  | 登记公开仓库的版本化 Release 附件       | 7 天         |
| `/https://github.com/<owner>/<repo>/releases/latest/download/<asset>` | 登记公开仓库的最新 Release 附件         | 5 分钟       |

只接收 GET，不支持 HEAD 或 Range。公开加速前缀也接受 `/https:/github.com/` 和
`/github.com/`，兼容路径中的连续斜线被合并的情况。示例：

```text
https://release-proxy.<账号子域名>.workers.dev/https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64
```

产品接口拒绝草稿、预发布和不符合 tag 规则的版本。Release 信息只含 `tag_name`、
`published_at`、稳定版标志和获准的 `assets`；`browser_download_url` 使用请求自身域名。
更新清单中的下载 URL 由产品构建时写入；代理不修改带签名内容。

仅提供上述通用路由，不提供产品根目录的清单或版本文件地址。

## 私有仓库令牌

1. 在 GitHub「Settings → Developer settings → Personal access tokens → Fine-grained tokens」
   创建细粒度令牌，选择对应仓库的所有者，并设置合适的有效期。
2. 「Repository access」选择「Only select repositories」，仅选这个产品的单个仓库。
3. 「Repository permissions → Contents」设为「Read-only」。如组织要求审批，先完成审批。
4. 在 Cloudflare 控制台添加 Secret，名称遵循上述规则，例如 `MY_APP_GITHUB_TOKEN`，
   值填写该令牌。每个产品分别创建令牌；不要使用共用令牌回退。

客户端与产品发布工作流都不需要此读取令牌。定期更新到期令牌；令牌缺失或失效只影响
对应产品。[GitHub 令牌创建说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)、
[Release 附件接口权限](https://docs.github.com/en/rest/releases/assets)

## 自定义域名

在 Cloudflare「Workers → release-proxy → 设置 → 域和路由」添加自定义域名；仓库不登记
个人域名。`workers.dev` 对所有部署保持开启，与自定义域名使用同一个 Worker、同样的
白名单和账号额度。自定义域名失败时不回退到绕过代理的下载地址。
预览 URL 保持关闭。[域名配置](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

## 安全模型与费用

- 请求参数不得决定任意上游仓库或 URL。公开加速仅分发登记仓库的 Release 附件，不提供
  源码归档、`archive`、`blob`、`releases.atom` 或 GitHub API 代理，且不带任何产品令牌。
- 产品令牌只发送给登记仓库的 GitHub API；临时附件跳转限于 HTTPS GitHub 资产域名，
  不带令牌。公开加速的 GitHub 跳转仅限同一登记仓库的 Release 下载路径。
- 不透传私有说明、源码归档、提交和作者信息。日志只记录配置错误、缺令牌和上游失败，
  不记录每次调用，并遮蔽已配置产品的令牌。
- 代理地址可匿名访问，获准附件因此可公开下载。各产品负责签名、安装流程和发布完整性；
  发布前先上传并验证附件，必须拒绝覆盖已发布的 tag 和附件。
- 保持 Workers Free：整个账号每日 100,000 次请求，UTC 零点重置，所有产品、公开加速和
  该账号其他 Worker 共享额度；缓存命中同样计入。达到硬上限返回 Cloudflare 1027。
- Free 计划每个 Worker 最多 64 个变量（含 Secret），每个变量最多 5 KB。大型 `PRODUCTS`
  配置也受单个变量限制；项目不自动升级付费计划。

[Cloudflare 限制](https://developers.cloudflare.com/workers/platform/limits/)、
[Workers Cache 计费说明](https://developers.cloudflare.com/workers/cache/)

## 本地开发与检查

使用 `.bun-version` 指定的 Bun 和 `.node-version` 指定的 Node 24。Vitest 使用 Node，其他
检查通过 Bun 执行。工具版本由 `bun.lock` 锁定，Worker 运行期只使用标准 Web API。

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run format:check
bun run test
bun run build
```

五项检查依次为代码规范、类型、格式、测试与不部署构建。`bun run build` 只执行 Wrangler
的 dry-run，生成本地 bundle，不部署。CI 在 GitHub 托管的 Ubuntu 运行器执行同一组检查。

本地可在被 Git 忽略的 `.dev.vars` 中填写配置，例如 `PUBLIC_REPOSITORIES=jqlang/jq`；
`PRODUCTS` 可用单行 JSON 文本。测试凭据仅存于 `.dev.vars`，不要提交。启动本地服务：

```bash
node node_modules/wrangler/bin/wrangler.js dev
```

删除 `.dev.vars` 后可验证无配置的 404。模拟上游测试与本地运行不能替代正式域名上的
下载、私有凭据和产品升级验收。

## 致谢与许可证

公开加速行为参考 [asjdf/ghproxy](https://github.com/asjdf/ghproxy)，未复制其代码。

[MIT License](LICENSE) · Copyright (c) 2026 Ahua9527
