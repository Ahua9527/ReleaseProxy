# 参与贡献

使用 `.bun-version` 指定的 Bun 和 `.node-version` 指定的 Node 24；Vitest 使用 Node，其他
工具使用 Bun。安装固定依赖后依次完成五项检查：

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run format:check
bun run test
bun run build
```

`build` 只做 Wrangler dry-run，不部署。保持改动小且可验证，遵守 [AGENTS.md](AGENTS.md)
的安全约定；不要提交个人部署配置或令牌。注释与主文档用中文，标识符、日志键和命令用英文，
修改 README 时同步英文版。

提交信息使用 `feat:`、`fix:` 或 `docs:` 等前缀，加简短中文说明。PR 说明行为变化及验证结果；
安全问题按 [SECURITY.md](SECURITY.md) 私下报告。
