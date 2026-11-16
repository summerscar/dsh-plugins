# site/ 专项规则

改动 `site/**`（插件发布站 <https://summerscar.github.io/dsh-plugins/>）时适用；通用规则见根目录 `AGENTS.md`。

站点由 `site/` 生成到 `_site/`（本地构建产物，忽略提交）。站点只维护当前插件目录，文档阅读指向官方站点。

| 文件 | 职责 |
| --- | --- |
| `site/catalog.json` | 唯一手工维护的数据 |
| `site/render.mjs` | 纯渲染：catalog + npm 数据 → 页面、`plugins.json`、`index.json`、`llms.txt`，保持纯函数 |
| `site/build.mjs` | 拉 npm 数据，校验发布包并写 `_site/` |
| `site/market.mjs` | 用同一份渲染逻辑更新或核对 Git 根目录的 `index.json` |
| `site/npm.mjs` | 在内存中校验读取 npm 包 |
| `site/assets/` | 样式与脚本；脚本做渐进增强，纯 HTML 页面直接可用 |
| `site/site.test.mjs` | 离线测试，含在 `pnpm check` |

`plugins.json`、`_site/index.json`（插件市场索引，只收 bundle 类）、`llms.txt` 由构建自动生成，改动在 `site.test.mjs` 覆盖。根目录 `index.json` 是同一市场索引的 Git 发布副本，用 `pnpm site:market` 更新，CI 用 `pnpm site:market:check` 核对。

## 增改/下线插件

只改 `catalog.json` 并同步根 README 插件表格。规则：只收录 npm 上有 `latest` 的 DSH 插件；`slug` 用小写字母数字连字符、通常去掉作用域和 `dsh-` 前缀，已发布 slug 保持稳定；`category` 用 `categories` 里的 id，`kind` 只取 `preset`/`plugin`/`service`；`title`/`summary` 双语，一句话说清用户价值；`readme.zh`/`readme.en` 填包内相对路径（缺语言仍填预期路径，构建时告警并回退另一语言）；`repository` 填 GitHub URL，`directory` 是子目录（根即包填 `""`）；版本、日期、依赖、图标由构建时从 npm 自动读取，依赖按 catalog 内同名依赖自动推导（安装命令只列插件本身和未标 `optional` 的必需 peer——`dsh plugin add` 转发 pnpm 且 profile `autoInstallPeers: false`，其余依赖自动安装）。

## 修改渲染

README 原始 HTML 只保留 `<img>`、`<br>`，链接/图片地址只允许 http(s)、mailto、锚点、相对路径；改链接改写、依赖推导或页面结构时在 `site.test.mjs` 补离线测试；中文在根路径、英文在 `en/`，结构一致，新文案同步 `render.mjs` 的 `T.zh`/`T.en`；视觉采用蓝墨配冷色纸底，重点突出安装命令行，静态资源全部本地自包含。

## 验证与部署

`pnpm site:test`（离线）、`pnpm site:build`（拉线上数据）、`pnpm site:market:check`（核对 Git 市场索引与 npm）、`node site/build.mjs --save-snapshot|--snapshot .scratch/snap.json`（快照离线重建）、`pnpm check`。改页面后本地预览 `_site/`（桌面+手机宽度）；站点在 `/dsh-plugins/` 子路径下，页面内链接用相对路径（404 除外）。

部署：`.github/workflows/pages.yml` 在推 `main` 和每天 01:17 UTC 跑 test+build 后，用 `upload-pages-artifact` + `deploy-pages` 部署 `_site/`。**仓库 Pages 设置的 Source 必须是「GitHub Actions」**；若设成「Deploy from a branch」，GitHub 会用 Jekyll 渲染仓库根 README 覆盖站点，表现为首页变成 README、`/assets/site.css` 404。上传产物前会校验 `_site/index.html` 与 `_site/.nojekyll` 存在；仓库根也留了 `.nojekyll` 兜底。拉取失败时构建直接报错退出，线上保留上一版已验证页面。

**发布与站点的先后关系**：发布流程的 `commit` 步骤 push 到 `main` 会自然触发 Pages，但 `site:build` 从 packument CDN 现拉 `dist-tags.latest`，CDN 复制有延迟，刚发完的版本可能尚未可见，页面会显示旧版。为保序，Pages 在 `site:build` 前多一步「Wait for npm registry freshness」（`node site/fresh.mjs`）：读 `index.json`（发布流程 `pnpm site:market` 写回的最新版本快照），轮询 npm packument 直到其 `dist-tags.latest` 不再落后于 `index.json` 记录；普通代码推送时 `index.json` 与线上本就一致，首次轮询即通过、零额外耗时；只有刚发完版的推送才等待。超过 300s 仍未追平时**不判红**，告警后按线上现有版本构建（`deploy-pages` 永远取最近一次 `github-pages` artifact，下一次发布会再次触发本流程自愈）。

因此**不要**改成 `workflow_run` 触发源：`deploy-pages` 只能消费*本次 run* 自己上传的 `github-pages` artifact，由另一 workflow（publish）的 `workflow_run` 触发的 run 无法执行 `deploy-pages`（GitHub 报 “No artifacts named github-pages were found”），且并发 push 触发会争用同名 artifact。先后关系在本 run 内用 fresh-wait 解决即可。本地可 `pnpm site:fresh` 手动验证 registry 是否已追上 `index.json`。
