# 新产品接入提示词

把产品接入 ReleaseProxy 时，产品仓库通常要调整发布流程和客户端更新地址。下面的提示词交给
产品仓库里的编程 Agent（如 Claude Code、Codex），由它完成调查、改代码，并整理出需要你在
Cloudflare 和 GitHub 上手动完成的步骤。

使用方法：

1. 如果还没部署 ReleaseProxy，先按 [README 的「部署」](README.md#部署)完成部署并确认代理地址。
2. 在产品仓库里启动 Agent，复制下面整段提示词，填好开头三项后发送。
3. 按 Agent 最后给出的清单，在 Cloudflare 添加产品变量和令牌 Secret，再发布一个新版本验收。

````text
你要把当前仓库的产品接入 ReleaseProxy（https://github.com/Ahua9527/ReleaseProxy）：一个运行在
Cloudflare Workers 上的 GitHub Release 下载代理，用只读令牌从（可能是私有的）仓库分发登记过的
Release 附件，并作为客户端自动更新源。请完成调查、发布流程和客户端适配，并给出需要我手动完成的
配置清单。

已知信息（尖括号内容由我填写，留空的请你建议后让我确认）：
- 代理地址：<例如 https://updates.example.com，末尾不带 />
- 产品 ID：<小写字母、数字和 -，以字母或数字开头，例如 my-app>
- 产品变量名：<PRODUCTS 后接未被占用的数字，例如 PRODUCTS3>

## 代理的规则（必须遵守，不要假设代理会做额外的事）

接口（只接受 GET，不支持 HEAD 和 Range，不能断点续传）：
- `<代理地址>/<产品ID>/releases/latest`：最新稳定版信息，JSON 只含 `tag_name`、`published_at`、
  `draft`、`prerelease`、`assets`（每项含 `name`、`size`、`browser_download_url`），缓存 5 分钟。
- `<代理地址>/<产品ID>/releases/download/<tag>/<附件名>`：指定版本的附件，缓存 1 年、不可变。
- `<代理地址>/<产品ID>/latest/<别名>`：最新稳定版里某个附件或清单，缓存 5 分钟。

产品登记（之后由我放进 Cloudflare 变量）格式：

```json
{
  "<产品ID>": {
    "repository": "owner/repo",
    "assets": ["MyApp-{version}-*.dmg", "MyApp-{version}.apk", "latest.json"],
    "latest": { "macos.dmg": "MyApp-{version}-universal.dmg", "latest.json": "latest.json" },
    "tagPattern": "^v?\\d+\\.\\d+\\.\\d+$"
  }
}
```

- `assets`：允许公开的附件名白名单。`*` 匹配任意字符但不含 `/`；`{version}` 是 tag 去掉开头 `v`
  后的版本号；整串匹配。`{version}` 两侧不能紧挨 `*`（如 `app-{version}*` 无效），要用 `-`、`_`、`.`
  等固定分隔符。名称不得为空、不得含 `/` 或 `\`、不得为 `.` 或 `..`。不在白名单的附件一律 404。
- `latest`：可选，别名到附件名模板的映射，模板只能用 `{version}`，不能用 `*`，且结果必须在白名单内。
- `tagPattern`：可选正则，默认 `^v?\d+\.\d+\.\d+$`。草稿、预发布和不符合规则的 tag 一律不分发。
- `publicReleasePage`：可选的公开发布说明页，`{tag}` 会被替换；不设置则不返回页面地址。
- 不透传 Release 正文、源码归档、提交和作者信息。附件按原字节分发，代理不改清单和签名。
- 读取令牌只存于 Cloudflare Secret，客户端和产品发布流程都不需要它。

## 步骤

1. 只读调查，先汇报再动手：
   - 找出发布工作流、打包脚本、版本号来源、tag 命名方式。
   - 用 `gh release list` 和 `gh api repos/<owner>/<repo>/releases/latest` 查看已发布附件的实际命名。
   - 找出客户端的更新机制（Tauri updater、Sparkle、electron-updater、Android 自写检查等）、更新清单
     格式，以及代码、网站和文档中写死的 GitHub 下载或 API 地址。
   - 确认已安装的旧版本客户端依赖哪些地址；改动不能让它们收不到更新。
   - 汇报现状、拟定的产品登记 JSON 和改动清单，等我确认后再改。
2. 发布流程适配：
   - 附件名固定且包含版本号，能被 `assets` 白名单精确匹配；附带校验文件（如 SHA256SUMS.txt）。
   - 禁止覆盖已发布的附件（去掉 `--clobber` 之类参数，tag 或附件已存在时直接失败）。代理会把版本化
     附件缓存 1 年，覆盖会导致用户拿到旧文件。
   - 先建草稿 Release、上传并校验全部附件，再正式发布；代理不分发草稿，可避免用户下载到半成品。
   - 更新清单里的下载地址使用版本化接口 `<代理地址>/<产品ID>/releases/download/<tag>/<附件名>`，
     不要用 `latest` 别名，也不要用 github.com 地址；签名针对最终上传的原字节生成。
3. 客户端适配：
   - 更新检查改为请求 `<代理地址>/<产品ID>/latest/<清单别名>` 或 `/<产品ID>/releases/latest`。
   - 下载使用普通 GET，不依赖 HEAD、Range 或断点续传。
   - 代理失败时如实报错，不要回退到 github.com 或其他绕过代理的地址；客户端不得包含任何令牌。
   - 网站或文档中的「下载最新版」链接可改为 `<代理地址>/<产品ID>/latest/<别名>`。
4. 运行本仓库已有的 lint、类型检查、测试和构建，只跑与改动相关的部分。
5. 不要推 tag、不要发布真实 Release、不要推送默认分支，这些等我确认；不要修改 ReleaseProxy 仓库。

## 最后交给我的内容

1. 改动摘要和检查结果。
2. 产品变量：变量名、压成一行的 JSON 值。在 Cloudflare「Workers → release-proxy → 设置 → 变量和机密」
   添加文本变量后保存并部署；控制台提示「更新 Wrangler 配置」可以忽略。
3. 令牌 Secret 名：产品 ID 转大写、`-` 换成 `_`，再加 `_GITHUB_TOKEN`（如 `my-app` →
   `MY_APP_GITHUB_TOKEN`）。令牌在 GitHub 创建细粒度令牌：只选这个仓库，`Contents` 设为 `Read-only`。
4. 发布第一个版本后的验收命令（只用 GET），例如：
   - `curl -s <代理地址>/<产品ID>/releases/latest`：能看到新版本和附件列表。
   - `curl -sS -o /dev/null -w '%{http_code}\n' <代理地址>/<产品ID>/latest/<别名>`：返回 200。
   - 下载附件并与 SHA256SUMS.txt 核对哈希。
   - 用旧版本客户端实际检查一次更新。
5. 常见错误对照：503 且日志 `token_missing` 表示没配令牌或令牌为空；503 且日志 `config_invalid`
   表示日志 `variable` 字段对应的变量写错，或产品 ID 与其他变量重复；404 表示附件名或 tag 不符合登记规则，
   或最新版是草稿、预发布。
````
