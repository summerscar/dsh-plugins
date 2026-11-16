<div align="center">

# dsh-factory

<!-- release-state-note -->

**面向 DeepSeek Harness 的多项目开发工厂：看板上的每张卡都在独立会话与 git worktree 里执行，任何 commit、push 或生成 PR 都必须由你明确批准。**

简体中文 · [English](../README.md)

</div>

---

## 做什么

- **看板管理多项目。** 按「项目 → 看板 → 卡片」组织工作。项目是一个绝对根路径加其下的仓库集合。卡片的仓库信息只作为上下文传给它的会话；卡片实际运行所在的 worktree 始终由项目根路径创建，所以卡片不会改变它在哪个目录里执行。
- **可配置的 worktrees root。** 一个全局设置决定新 worktree 建在哪里；留空即用按用户主目录解析的默认 `~/dsh-factory-worktrees`。它只对之后新建的 worktree 生效，已有项目与卡片不受影响。该根必须位于 DSH 数据目录外，只对默认的主目录子树留一条窄例外。
- **每卡独立会话与 worktree。** 卡片派发时创建专属会话，并在按项目分目录的 git worktree 中隔离执行，两张卡不会共用同一个工作树。
- **阶段接续。** 卡片推进到下一阶段时，插件在同一个 worktree 里接着干，按可用性依次尝试：会话还活着就直接续话；会话已结束但历史在磁盘上就重建到那份历史上；历史不可用才新建会话，并把这次降级记在卡片上。接续永不新建 worktree。
- **连续失败自动停。** 同一张卡连续失败达到 3 次会被标记为已停，不再自动重试，避免反复空转。
- **人工批准的交付。** 插件可以起草提交信息与 PR 描述，但 commit、push 与生成 PR 只在你按下卡片上的专用批准控件后发生。它绝不自行提交、推送、合并或提权。
- **自动拉取 issue。** 从 GitHub 拉取开放的 issue 变成卡片，按仓库与编号去重，重复轮询不会产生重复卡片。
- **内置流程 skill。** 随包提供六个阶段 skill（triage / plan / build / self-review / review / rereview），装好即生效，把每个阶段该做的事交给处理该卡的会话。另有一个添加项目的 skill，教 agent 如何分析一个仓库并注册成项目。

## 安装

```sh
dsh plugin --profile web add @summerscar/dsh-factory
```

安装后刷新页面，打开左下角**设置**（齿轮），在左侧导航里选「项目工厂」即为看板。

## 使用

1. 建一个项目，填它的绝对根路径。
2. 在项目下建看板，再建卡片；或用 intake 从 GitHub 拉取 issue。
3. 把卡片派发出去，它会在自己的会话与 worktree 里执行。
4. 卡片推进到下一阶段时走接续：同一个 worktree、同一条分支，只重新拿到会话（会话还活着就直接续，结束过就接回历史，历史没了才新建并记下降级）。
5. 在评审阶段查看改动，按「确认提交」再按「推送分支并创建 PR」——这两步都是你的动作，插件不会代劳。
6. PR 开出后卡片停在评审，由你决定标记完成还是打回。

## 命令

在会话里用 `/factory` 注册项目：

- `/factory add` — 把当前会话的工作目录注册为项目。
- `/factory add <绝对路径> [项目名]` — 注册指定仓库；不给项目名时用目录名。
- `/factory inspect <绝对路径>` — 只读列出仓库的原始特征：根目录的文件名与子目录名、各 ignore 文件的条目、值得一读的清单文件、`package.json` 声明的包管理器。它不判定项目类型，也不创建任何东西。

`add` 不会自己建项目：它把请求交给当前会话的 agent，由 agent 按内置的 `factory-add-project` skill 先调 `factory_inspect_repo` 拿到仓库的原始特征，再自己读关键文件判断真实技术栈、提议 `copyFiles` 与 `postCreate`，经你确认后建项。安装命令与需要复制的本地文件由**目标仓库自己的** `AGENTS.md` / `CONTRIBUTING` 决定，插件不预设。

## GitHub 接入

按环境自动选择，优先级如下：

1. **复用 `gh` 登录态**——已经 `gh auth login` 过就直接可用，零配置。
2. **自建 OAuth App + Device Flow**——去 [创建 OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)，**务必勾选 Enable Device Flow**；callback URL 在该流程中不使用，填 `http://127.0.0.1` 占位即可；把 Client ID（非密钥）填进插件，再到 [github.com/login/device](https://github.com/login/device) 输入八位码。
3. **个人访问令牌**——存进 DSH 凭据，供前两者都不可用时兜底。

访问令牌一律存进 DSH 凭据，不写入配置、日志或状态文件。插件不内置任何 OAuth 凭据。

参考：[授权流程](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) · [创建入口](https://github.com/settings/applications/new) · [设备码输入](https://github.com/login/device)

## 主要限制

- **绝不自动执行 git 操作。** 没有人在卡片上按下批准控件，插件就不会 commit、push、开 PR 或合并。
- **暂停与接管目前只能走 HTTP。** 引擎可全局暂停（`POST /api/dsh-factory/engine/pause`，用 `.../resume` 恢复，已在跑的会话不会被打断），单张卡可从引擎手里接管（`POST /api/dsh-factory/cards/<卡片 id>/takeover`——是 `takeover`，不是 `take-over`）。这两项在界面上都还没有入口。
- **没有 webhook。** 走 `gh` 与轮询，所以 issue 变化不是实时的，取决于轮询间隔。
- **只支持 GitHub。** GitLab 的评审流程尚未实现。
- **单机。** 面向在本机运行的 DSH，不提供多副本协调。
