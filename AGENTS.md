# ReleaseProxy 协作约定

ReleaseProxy 是多个产品的私有 GitHub Release 下载代理与原生自动更新源。

- 使用中文注释、文档和沟通；标识符、日志键和命令使用英文。
- 产品与加速名单来自 Cloudflare 变量，仓库不包含任何部署者配置；请求参数不得决定上游仓库或任意 URL。
- 公开仓库加速只分发 `PUBLIC_REPOSITORIES` 登记仓库的 Release 附件，匿名访问，不带任何令牌，不透传源码归档。
- Secret 名为产品 ID 大写、`-` 换成 `_` 后加 `_GITHUB_TOKEN`，如 `my-app` → `MY_APP_GITHUB_TOKEN`。
- 每个产品用独立 Worker Secret，只授权对应仓库 `Contents: read`。源码、日志和客户端不得包含令牌。
- 更新清单、签名和安装包按原字节分发；签名私钥及安装流程由各产品维护。
- 仅公开登记资产及必要 Release 信息；私有说明、源码归档、提交和作者信息不得被透传。
- 原生目录地址属于客户端合同，改动前检查已有安装版本的依赖。
- 最新地址缓存 5 分钟；版本资产长期缓存，产品发布流程必须拒绝覆盖已发布资产。
- 保持 Workers Free 和账号每日硬上限；自定义域名失败时不回退到绕过代理的下载地址。
- CI 使用 GitHub 托管运行器 `ubuntu-latest`；Vitest 使用 Node 24，其他工具使用 Bun。
- 提交前运行 `bun run lint`、`bun run typecheck`、`bun run format:check`、`bun run test`、`bun run build`。
- `bun run build` 只执行 Wrangler dry-run；真实部署需要用户明确指示。
- 使用小而可验证的改动，不添加与当前产品登记、分发和测试无关的框架或管理界面。
