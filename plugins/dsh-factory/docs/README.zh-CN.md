<div align="center">

# dsh-factory

<!-- release-state-note -->

**面向 DeepSeek Harness 的多项目开发工厂：看板上的每张卡都在独立会话与 git worktree 里执行，任何 commit、push 或生成 PR 都必须由你明确批准。**

简体中文 · [English](../README.md)

</div>

---

## 做什么

- **看板管理多项目。** 按「项目 → 看板 → 卡片」组织工作。项目是一个绝对根路径加其下的仓库集合，卡片可以覆盖它运行所用的仓库，所以分散在不同目录的项目可以并存在同一块看板上。
- **每卡独立会话与 worktree。** 卡片派发时创建专属会话，并在按项目分目录的 git worktree 中隔离执行，两张卡不会共用同一个工作树。
- **人工批准的交付。** 插件可以起草提交信息与 PR 描述，但 commit、push 与生成 PR 只在你按下卡片上的专用批准控件后发生。它绝不自行提交、推送、合并或提权。
- **自动拉取 issue。** 从 GitHub 拉取开放的 issue 变成卡片，按仓库与编号去重，重复轮询不会产生重复卡片。
- **内置流程 skill。** 随包提供六个阶段 skill（triage / plan / build / self-review / review / rereview），装好即生效，把每个阶段该做的事交给处理该卡的会话。

## 安装

```sh
dsh plugin --profile web add @summerscar/dsh-factory
```

安装后刷新页面，打开左下角**设置**（齿轮），在左侧导航里选「项目工厂」即为看板。

## 使用

1. 建一个项目，填它的绝对根路径。
2. 在项目下建看板，再建卡片；或用 intake 从 GitHub 拉取 issue。
3. 把卡片派发出去，它会在自己的会话与 worktree 里执行。
4. 在评审阶段查看改动，按「确认提交」再按「推送分支并创建 PR」——这两步都是你的动作，插件不会代劳。
5. PR 开出后卡片停在评审，由你决定标记完成还是打回。

## GitHub 接入

按环境自动选择，优先级如下：

1. **复用 `gh` 登录态**——已经 `gh auth login` 过就直接可用，零配置。
2. **自建 OAuth App + Device Flow**——去 [创建 OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)，**务必勾选 Enable Device Flow**；callback URL 在该流程中不使用，填 `http://127.0.0.1` 占位即可；把 Client ID（非密钥）填进插件，再到 [github.com/login/device](https://github.com/login/device) 输入八位码。
3. **个人访问令牌**——存进 DSH 凭据，供前两者都不可用时兜底。

访问令牌一律存进 DSH 凭据，不写入配置、日志或状态文件。插件不内置任何 OAuth 凭据。

参考：[授权流程](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) · [创建入口](https://github.com/settings/applications/new) · [设备码输入](https://github.com/login/device)

## 主要限制

- **绝不自动执行 git 操作。** 没有人在卡片上按下批准控件，插件就不会 commit、push、开 PR 或合并。
- **没有 webhook。** 走 `gh` 与轮询，所以 issue 变化不是实时的，取决于轮询间隔。
- **只支持 GitHub。** GitLab 的评审流程尚未实现。
- **单机。** 面向在本机运行的 DSH，不提供多副本协调。
