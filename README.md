# dsh-web-profile

用 Git 管理 dsh `web` profile 的配置：profile 只版本化 4 个配置文件，并提供一键安装脚本、CI 校验和自动化依赖更新。

[![CI](https://github.com/Yiklek/dsh-web-profile/actions/workflows/ci.yml/badge.svg)](https://github.com/Yiklek/dsh-web-profile/actions/workflows/ci.yml)
[![Update dependencies](https://github.com/Yiklek/dsh-web-profile/actions/workflows/update-deps.yml/badge.svg)](https://github.com/Yiklek/dsh-web-profile/actions/workflows/update-deps.yml)

## 为什么用这个仓库

dsh 的 profile 位于 `$DSH_HOME/profiles/<name>`（`DSH_HOME` 默认 `~/.dsh`），目录里既有需要版本管理的配置，也有不该提交的内容：`node_modules/`、本机生成的 `cordis.patch.yml`、运行期数据 `.dsh-market/`、本地凭据 `.env` 等。

profile 需要管理的配置只有这 4 个：

```text
package.json          # profile 依赖 + dsh.profile.bundles 声明
pnpm-lock.yaml        # 依赖版本锁定
pnpm-workspace.yaml   # pnpm 安装策略（hoisted、允许构建的原生模块）
cordis.yml            # profile 根（空列表，实际由 bundles 与 patch 组合）
```

通过 `install.sh` 安装到 profile 目录，支持 **clone** 与 **git worktree** 两种方式。

## 特性

| 能力 | 说明 |
|---|---|
| 配置版本化 | profile 配置只跟踪 4 个文件；`node_modules/` 与运行期数据被忽略 |
| 一键安装 | 本地一条命令；远程 `curl \| bash` 无需先 clone |
| worktree 工作流 | profile 目录即本仓库的 worktree，改动可直接提交并快进回 `main` |
| 覆盖保护 | 覆盖已有 profile 前自动备份为 `<name>.bak.<YYYYMMDD-HHMMSS>` |
| CI 校验 | shellcheck / prettier、profile 可组合可启动、Playwright 冒烟测试 |
| 自动化依赖 | 每 6 小时 `pnpm update --latest` 自动提 PR；Dependabot 每日更新 npm、每周更新 Actions |

## 目录结构

```text
dsh-web-profile/
├── .github/
│   ├── dependabot.yml            # 每日 npm / 每周 GitHub Actions 更新
│   └── workflows/
│       ├── ci.yml                # lint + profile 启动校验 + Playwright 冒烟
│       └── update-deps.yml       # 定时 pnpm update --latest 并提 PR
├── tests/e2e/                    # Playwright 冒烟测试
├── install.sh                    # 安装脚本（clone / worktree）
├── package.json                  # profile 依赖与 bundles
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── cordis.yml
├── .gitignore
├── LICENSE
└── README.md
```

## 快速开始

环境要求：`git`、`bash`。依赖安装优先用 `dsh`，没有 `dsh` 时用 `pnpm dlx`，没有 `pnpm` 时用 `npx --yes`。CI 参考环境为 Node 22 + pnpm 11.22（见 `.github/workflows/ci.yml`）。

### 1. 安装

本地安装（在仓库目录执行，只支持 worktree 模式）：

```bash
git clone https://github.com/Yiklek/dsh-web-profile.git
cd dsh-web-profile

./install.sh                 # 安装为默认 profile：web
./install.sh web2            # 安装为自定义 profile
./install.sh web2 --force    # 覆盖已存在的 profile（覆盖前仍会备份）
```

远程一键安装（默认 clone 到 `~/.dsh/profiles/web`）：

```bash
curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web
```

### 2. 启动

```bash
dsh --profile web
# 或
npx @deepseek-ai/dsh --profile web
```

安装脚本完成后会直接打印对应的启动命令。

> dsh CLI 的版本通道会影响插件兼容性：CI 用 `@deepseek-ai/dsh@alpha` 验证，安装脚本回退时使用 `@next`。遇到插件加载异常时，先对齐 dsh 版本。

## 安装详解

### 参数

| 参数 | 作用 | 默认值 | 适用模式 |
|---|---|---|---|
| `[profile-name]` | 目标 profile 名称 | `web` | 全部 |
| `--force` / `-f` | 跳过覆盖确认（仍会备份） | 关闭 | 全部 |
| `--branch <branch>` / `-b` | worktree 分支名 | `profile-<name>` | 仅 worktree |
| `--mode <clone\|worktree>` | 安装方式 | 本地 worktree；远程 clone | 仅远程 |
| `--dir <path>` | source 仓库目录路径或名称 | `<cwd>/<仓库名>` | 仅远程 worktree |
| `--help` / `-h` | 显示用法 | — | 全部 |

> `--branch` 在 worktree 模式生效（本地或远程）；`--dir` 只对**远程** worktree 安装生效，本地执行时会被忽略。`--mode clone` 下指定两者会直接报错。

### clone vs worktree

| 方式 | 行为 | 适合场景 |
|---|---|---|
| **clone** | 把仓库 `git clone` 到 profile 目录 | 远程一键安装，不打算在 profile 里改配置提交 |
| **worktree** | 在 profile 目录创建本仓库的 git worktree | 本地开发，需要把 profile 改动合并回 `main` |

### 脚本执行流程

1. **判定模式**
   - 在本地 git 检出中执行：强制 `worktree`；显式指定 `--mode clone` 会报错。
   - 不在 git 检出中执行（如 `curl | bash`）：未指定 `--mode` 时默认 `clone`。
2. **确认覆盖（仅当 profile 已存在）**
   - 交互终端会询问；非交互执行必须加 `--force`。
3. **准备 source 仓库（worktree 模式）**
   - 远程 worktree：clone 到 `<cwd>/<仓库名>`，或用 `--dir` 指定目录；已存在则 `fetch --all --prune`。
4. **创建分支与 worktree**
   - 分支不存在时创建 `profile-<name>`：本地从 `main`（无则 `master`，分离 HEAD 则当前提交），远程从 `origin/main`（无则 `origin/master`，都没有则报错）。
   - 分支已被其他 worktree 占用时报错退出。
   - 需要覆盖时先把原目录备份为 `~/.dsh/profiles/<name>.bak.<YYYYMMDD-HHMMSS>`，再创建 worktree。
5. **安装依赖**，按可用性依次尝试：

   ```bash
   dsh plugin --profile <name> install
   pnpm dlx @deepseek-ai/dsh@next plugin --profile <name> install
   npx --yes @deepseek-ai/dsh@next plugin --profile <name> install
   ```

## 更新与同步

> 以下流程仅适用于 **worktree 安装**。clone 安装直接在 profile 目录 `git pull` 即可。
>
> - `<name>`：profile 名，默认 `web`
> - `<source-repo>`：source 仓库目录。本地安装即本仓库；远程 worktree 安装是 `--dir` 指定的目录，或默认的 `<cwd>/dsh-web-profile`

### 拉取上游更新

```bash
cd <source-repo> && git pull --ff-only origin main
cd ~/.dsh/profiles/<name> && git rebase main
dsh plugin --profile <name> install   # package.json / pnpm-lock.yaml 有变化时
```

profile 分支没有本地提交时，也可以直接快进：

```bash
git -C ~/.dsh/profiles/<name> merge --ff-only main
```

### 本地改动回流 main

```bash
cd ~/.dsh/profiles/<name>
git add -A && git commit -m "update profile config"
# 提示：git add -A 会连带暂存未忽略的本地文件（如自定义 Caddyfile）；
# 只想提交配置改动时改用 git add <file>...

cd <source-repo>
git merge --ff-only profile-<name>
git push origin main                  # 需要发布时
```

`--ff-only` 失败说明 `main` 与 `profile-<name>` 已分叉（例如 `main` 上有新提交）。先让 profile 分支基于最新 `main`，再快进：

```bash
cd ~/.dsh/profiles/<name>
git fetch origin main
git rebase origin/main                # 冲突时：git add -A && git rebase --continue
cd <source-repo>
git merge --ff-only profile-<name>
```

### 把依赖升到最新（可选）

与自动化工作流做的事一致，在 profile 目录执行后按上面的流程提交：

```bash
cd ~/.dsh/profiles/<name>
pnpm update --latest
dsh plugin --profile <name> install
```

### 冲突处理

```bash
git status                # 查看冲突文件
git add -A
git rebase --continue     # 放弃本次更新：git rebase --abort
```

## 自动化

### CI（`.github/workflows/ci.yml`）

| Job | 内容 |
|---|---|
| `lint` | `shellcheck install.sh`、`bash -n install.sh`、prettier 检查 `package.json` 与 `*.yml` |
| `test-dsh` | 以 `DSH_HOME=/tmp/dsh-home` 用 `install.sh` 做 worktree 安装（分支 `ci-web`）、`--dump-config` 校验组合结果、启动 web 并等待 boot token URL 出现、检查启动日志无错误 |
| `e2e` | worktree 安装（分支 `ci-e2e`）+ Playwright/Chromium 跑 `tests/e2e/smoke.spec.js`：断言页面标题、可打开「设置」、本 profile 插件的设置分区已挂载，且无插件致命错误 |

### 本地复现 e2e

CI 的 `e2e` job 等价于下面两步（profile 已安装且依赖已装好）。本地跑用**本机已安装的浏览器**，不下载 Playwright 自带 Chromium：

```bash
# 1. 启动 dsh web，boot 日志会被测试用来解析 token URL
dsh --profile web --host 127.0.0.1 --port 3099 --no-open > /tmp/dsh-e2e.log 2>&1 &

# 2. 安装 Playwright 依赖并运行冒烟测试（用本机 Edge）
cd tests/e2e
pnpm install
DSH_BOOT_LOG=/tmp/dsh-e2e.log pnpm test:edge
```

- `pnpm test:edge` 用本机 Microsoft Edge；本机是 Google Chrome 时改用 `PLAYWRIGHT_CHANNEL=chrome pnpm exec playwright test`。
- 本机确实没有 Chrome / Edge 时，才需要 `pnpm exec playwright install chromium` 使用 Playwright 自带内核。
- 测试从 `DSH_BOOT_LOG`（默认 `/tmp/dsh-e2e.log`）解析带 token 的连接 URL，也可直接用 `DSH_TOKEN_URL` 传入；端口不是 3099 时加 `DSH_PORT=<port>`。

### 依赖更新（`.github/workflows/update-deps.yml`）

- **触发**：`main` 有推送、每 6 小时定时、手动 `workflow_dispatch`。自动提交合并进 `main` 时会跳过，避免自我循环。
- **动作**：在仓库根目录与 `tests/e2e` 各执行 `pnpm update --latest`；有变化则提交到 `bot/dependency-updates-<时间戳>` 分支并开 PR。
- **收敛**：同一时间只保留一个自动化 PR，旧的自动关闭并删除分支；提交信息在只有一条升级时为 `chore(deps): bump <pkg> from <old> to <new>`，多条时为 `chore(deps): update dependencies`。

### Dependabot（`.github/dependabot.yml`）

每日 03:00（Asia/Shanghai）更新根目录与 `tests/e2e` 的 npm 依赖，每周更新 GitHub Actions。

## 排障与恢复

| 现象 | 处理 |
|---|---|
| `--dir` / `--branch` 不生效或报错 | `--branch` 仅 worktree 模式；`--dir` 仅远程 worktree 生效（本地忽略）；`--mode clone` 下指定会报错 |
| 分支已被其他 worktree 占用 | `git worktree list` 定位后 `git worktree remove <path>` |
| `dsh` 不在 PATH | 脚本自动回退到 `pnpm dlx` 或 `npx --yes @deepseek-ai/dsh@next` |
| 安装后想回滚 | 删除 profile 目录，把备份目录改回原名 |

恢复备份：

```bash
rm -rf ~/.dsh/profiles/<name>
mv ~/.dsh/profiles/<name>.bak.<YYYYMMDD-HHMMSS> ~/.dsh/profiles/<name>
```

## 设计说明：为什么用 git worktree

此前尝试过两种方案，都无法正常工作：

- **整个目录软链接**：Node 按真实路径解析依赖，软链接后找不到 profile 里的 `@deepseek-ai/*`。
- **配置文件软链接**：pnpm 拒绝写入符号链接形式的 `pnpm-lock.yaml`。

改用 git worktree 后：profile 目录是真实 git 检出，`pnpm-lock.yaml` 是可写真实文件，`node_modules/` 由 `.gitignore` 忽略，配置改动既能在 profile 里提交，也能回到主仓库统一管理。

## Git 管理建议

`.gitignore` 已忽略：

```gitignore
node_modules/
cordis.patch.yml
.dsh-market/
.env
.env.*
*.local
.DS_Store
thinking-effort-loaded.json
tests/e2e/test-results/
tests/e2e/playwright-report/
.npmrc
```

以上内容都不要提交：依赖目录、本机生成的 `cordis.patch.yml`、运行期数据、任何包含凭据的本地文件。

## License

[MIT](LICENSE) © 2026 Yiklek
