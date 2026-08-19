# dsh-web-profile

使用 Git 管理 dsh `web` profile 配置的仓库，并提供一键安装脚本。

## 为什么用这个仓库

dsh 的 profile 位于 `~/.dsh/profiles/<name>`，其中既包含需要版本管理的配置文件，也包含不应提交的 `node_modules`、生成的 `cordis.yml` 等。

本仓库只保存需要管理的配置文件：

```text
package.json
pnpm-lock.yaml
cordis.patch.yml
pnpm-workspace.yaml
```

并通过 `install.sh` 安装到 dsh profile 目录，支持 **clone** 或 **git worktree** 两种方式。

## 目录结构

```text
dsh-web-profile/
├── README.md
├── install.sh
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── cordis.patch.yml
└── pnpm-workspace.yaml
```

## 安装

### 本地 worktree 安装

在本地主仓库目录执行：

```bash
# 安装为默认 profile：web
./install.sh

# 安装为自定义 profile
./install.sh web2

# 跳过确认（覆盖前仍会备份）
./install.sh --force web2
```

本地主仓库目录只支持 **worktree** 安装；显式指定 `--mode clone` 会报错。

### 远程一键安装（curl）

不需要先 clone 本仓库，直接远程执行安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web
```

默认以 **clone** 方式安装到 `~/.dsh/profiles/web`。

也可以指定其他 profile 或安装模式：

```bash
# 安装为 web2
curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web2

# 直接 clone 到 profile
curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web --mode clone

# 以 worktree 安装
curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web --mode worktree

# worktree 安装时指定 source 仓库位置
curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web --mode worktree --dir ~/repos/dsh-web-profile

# 如果目标 profile 已存在且想覆盖，必须加 --force
curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web --force
```

非交互执行（`curl | bash`）时，如果目标 profile 已存在，**必须显式加 `--force`** 才会覆盖。

### 参数说明

| 参数 | 作用 | 默认值 | 适用模式 |
|---|---|---|---|
| `[profile-name]` | 目标 profile 名称 | `web` | 所有 |
| `--force` / `-f` | 跳过覆盖确认（覆盖前仍会备份） | 关闭 | 所有 |
| `--branch <branch>` | worktree 分支名 | `profile-<name>` | 仅 worktree |
| `--mode <clone\|worktree>` | 安装方式 | 本地 worktree；远程 clone | 远程安装 |
| `--dir <path>` | clone 后 source 仓库目录路径/名称 | `<cwd>/<仓库名>` | 仅远程 worktree |

> `--dir` 和 `--branch` 只适用于 worktree 模式；`--mode clone` 下指定它们会报错。

### clone vs worktree

| 方式 | 适合场景 |
|---|---|
| **clone** | 远程一键安装、不打算在 profile 里直接改配置提交 |
| **worktree** | 本地主仓库开发、需要把 profile 修改合并回 `main` |

### 脚本做了什么

- **在本地主仓库目录执行时，只允许 worktree 安装**
- **通过 `curl | bash` 远程执行时**：
  - 未指定 `--mode`：默认 clone 到 profile 目录
  - `--mode clone`：直接 `git clone` 到 profile 目录
  - `--mode worktree`：默认把 source 仓库 clone 到当前目录（`<cwd>/<repo>`），也可用 `--dir` 指定 clone 后的仓库目录路径/名称，再创建 git worktree

worktree 模式默认分支：`profile-<name>`，例如 `web` 对应 `profile-web`。

如果目标 profile 已存在：

- 交互终端会询问是否覆盖
- 非交互（`curl | bash`）必须使用 `--force`
- 覆盖前把原目录移动到带时间戳的备份：

  ```text
  ~/.dsh/profiles/<name>.bak.<YYYYMMDD-HHMMSS>
  ```

安装完成后执行：

```bash
dsh plugin --profile <name> install
```

如果 `dsh` 不在 PATH，会回退到：

```bash
npx --yes @deepseek-ai/dsh plugin --profile <name> install
```

### 为什么用 git worktree

之前尝试过“整个目录软链接”和“配置文件软链接”，都有问题：

- 整个目录软链接：Node 沿真实路径找不到 `~/.dsh/profiles/node_modules` 里的 `@deepseek-ai/*`
- 配置文件软链接：pnpm 拒绝写入符号链接形式的 `pnpm-lock.yaml`

使用 git worktree 后：

- profile 目录是**真实 git 检出**
- `pnpm-lock.yaml` 是真实文件，pnpm 可以正常写入
- `node_modules/` 被 `.gitignore` 忽略
- 配置修改可以直接在 profile 里提交，也可以回到主仓库统一管理

## 使用

安装完成后直接启动：

```bash
npx @deepseek-ai/dsh web
```

或：

```bash
npx @deepseek-ai/dsh --profile <name>
```

## 更新 worktree 安装

> 以下更新方式仅适用于 **worktree 安装**。
> `<source-repo>` 指安装时的 source 仓库目录：
> - 本地主仓库安装时，就是本仓库目录
> - 远程 worktree 安装时，是 `--dir` 指定的目录，或默认的 `<cwd>/<仓库名>`

### 1. 更新 source 仓库

```bash
cd <source-repo>
git fetch origin main
git pull --ff-only origin main
```

### 2. 更新 profile worktree

```bash
cd ~/.dsh/profiles/<name>
git rebase main
```

如果 profile 分支没有本地提交，也可以直接快进到最新 `main`：

```bash
git merge --ff-only main
```

### 3. 处理冲突

如果 rebase 或 merge 出现冲突：

```bash
git status
# 手动解决冲突后
git add -A
git rebase --continue
```

如果想放弃本次更新：

```bash
git rebase --abort
```

### 4. 重新安装依赖

如果 `package.json` 或 `pnpm-lock.yaml` 有变化，更新后执行：

```bash
dsh plugin --profile <name> install
```

## 修改配置后的同步方式

> 以下同步方式仅适用于 **worktree 安装**。
> 如果使用 clone 模式安装，直接在 profile 目录里修改并提交即可。

profile 目录是本仓库的一个 git worktree，所以修改后可以直接在 profile 里提交：

```bash
cd ~/.dsh/profiles/<name>
git add -A
git commit -m "update profile config"
```

如果想把 profile 分支合并回主仓库的 `main`，在仓库根目录执行：

```bash
git merge --ff-only profile-<name>
```

如果 `--ff-only` 失败，说明 `main` 和 `profile-<name>` 已经分叉（例如 `main` 上有新的提交）。此时不要直接创建合并提交，先让 profile 分支基于最新的 `main`：

```bash
cd ~/.dsh/profiles/<name>
git fetch origin main
git rebase origin/main
```

如果有冲突，解决后继续：

```bash
git add -A
git rebase --continue
```

然后再回到主仓库执行：

```bash
git merge --ff-only profile-<name>
```

也可以直接推送 profile 分支：

```bash
cd ~/.dsh/profiles/<name>
git push origin profile-<name>
```

## 恢复备份

脚本在覆盖前会保留备份，例如：

```text
~/.dsh/profiles/<name>.bak.<YYYYMMDD-HHMMSS>
```

如果需要恢复：

```bash
rm -rf ~/.dsh/profiles/<name>
mv ~/.dsh/profiles/<name>.bak.<YYYYMMDD-HHMMSS> ~/.dsh/profiles/<name>
```

## Git 管理建议

`.gitignore` 已忽略：

# dsh-web-profile

使用 Git 管理 dsh `web` profile 配置的仓库，并提供一键安装脚本。

## 为什么用这个仓库

dsh 的 profile 位于 `~/.dsh/profiles/<name>`，其中既包含需要版本管理的配置文件，也包含不应提交的 `node_modules`、生成的 `cordis.yml` 等。

本仓库只保存需要管理的配置文件：

```text
package.json
pnpm-lock.yaml
cordis.patch.yml
pnpm-workspace.yaml
```

并通过 `install.sh` 安装到 dsh profile 目录，支持 **clone** 或 **git worktree** 两种方式。

## 目录结构

```text
dsh-web-profile/
├── README.md
├── install.sh
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── cordis.patch.yml
└── pnpm-workspace.yaml
```

## 安装

### 本地 worktree 安装

在本地主仓库目录执行：

```bash
# 安装为默认 profile：web
./install.sh

# 安装为自定义 profile
./install.sh web2

# 跳过确认（覆盖前仍会备份）
./install.sh --force web2
```

本地主仓库目录只支持 **worktree** 安装；显式指定 `--mode clone` 会报错。

### 远程一键安装（curl）

不需要先 clone 本仓库，直接远程执行安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web
```

默认以 **clone** 方式安装到 `~/.dsh/profiles/web`。

也可以指定其他 profile 或安装模式：

```bash
# 安装为 web2
curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web2

# 直接 clone 到 profile
curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web --mode clone

# 以 worktree 安装
curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web --mode worktree

# worktree 安装时指定 source 仓库位置
curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web --mode worktree --dir ~/repos/dsh-web-profile

# 如果目标 profile 已存在且想覆盖，必须加 --force
curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web --force
```

非交互执行（`curl | bash`）时，如果目标 profile 已存在，**必须显式加 `--force`** 才会覆盖。

### 参数说明

| 参数 | 作用 | 默认值 | 适用模式 |
|---|---|---|---|
| `[profile-name]` | 目标 profile 名称 | `web` | 所有 |
| `--force` / `-f` | 跳过覆盖确认（覆盖前仍会备份） | 关闭 | 所有 |
| `--branch <branch>` | worktree 分支名 | `profile-<name>` | 仅 worktree |
| `--mode <clone\|worktree>` | 安装方式 | 本地 worktree；远程 clone | 远程安装 |
| `--dir <path>` | clone 后 source 仓库目录路径/名称 | `<cwd>/<仓库名>` | 仅远程 worktree |

> `--dir` 和 `--branch` 只适用于 worktree 模式；`--mode clone` 下指定它们会报错。

### clone vs worktree

| 方式 | 适合场景 |
|---|---|
| **clone** | 远程一键安装、不打算在 profile 里直接改配置提交 |
| **worktree** | 本地主仓库开发、需要把 profile 修改合并回 `main` |

### 脚本做了什么

- **在本地主仓库目录执行时，只允许 worktree 安装**
- **通过 `curl | bash` 远程执行时**：
  - 未指定 `--mode`：默认 clone 到 profile 目录
  - `--mode clone`：直接 `git clone` 到 profile 目录
  - `--mode worktree`：默认把 source 仓库 clone 到当前目录（`<cwd>/<repo>`），也可用 `--dir` 指定 clone 后的仓库目录路径/名称，再创建 git worktree

worktree 模式默认分支：`profile-<name>`，例如 `web` 对应 `profile-web`。

如果目标 profile 已存在：

- 交互终端会询问是否覆盖
- 非交互（`curl | bash`）必须使用 `--force`
- 覆盖前把原目录移动到带时间戳的备份：

  ```text
  ~/.dsh/profiles/<name>.bak.<YYYYMMDD-HHMMSS>
  ```

安装完成后执行：

```bash
dsh plugin --profile <name> install
```

如果 `dsh` 不在 PATH，会回退到：

```bash
npx --yes @deepseek-ai/dsh plugin --profile <name> install
```

### 为什么用 git worktree

之前尝试过“整个目录软链接”和“配置文件软链接”，都有问题：

- 整个目录软链接：Node 沿真实路径找不到 `~/.dsh/profiles/node_modules` 里的 `@deepseek-ai/*`
- 配置文件软链接：pnpm 拒绝写入符号链接形式的 `pnpm-lock.yaml`

使用 git worktree 后：

- profile 目录是**真实 git 检出**
- `pnpm-lock.yaml` 是真实文件，pnpm 可以正常写入
- `node_modules/` 被 `.gitignore` 忽略
- 配置修改可以直接在 profile 里提交，也可以回到主仓库统一管理

## 使用

安装完成后直接启动：

```bash
npx @deepseek-ai/dsh web
```

或：

```bash
npx @deepseek-ai/dsh --profile <name>
```

## 更新 worktree 安装

> 以下更新方式仅适用于 **worktree 安装**。
> `<source-repo>` 指安装时的 source 仓库目录：
> - 本地主仓库安装时，就是本仓库目录
> - 远程 worktree 安装时，是 `--dir` 指定的目录，或默认的 `<cwd>/<仓库名>`

### 1. 更新 source 仓库

```bash
cd <source-repo>
git fetch origin main
git pull --ff-only origin main
```

### 2. 更新 profile worktree

```bash
cd ~/.dsh/profiles/<name>
git rebase main
```

如果 profile 分支没有本地提交，也可以直接快进到最新 `main`：

```bash
git merge --ff-only main
```

### 3. 处理冲突

如果 rebase 或 merge 出现冲突：

```bash
git status
# 手动解决冲突后
git add -A
git rebase --continue
```

如果想放弃本次更新：

```bash
git rebase --abort
```

### 4. 重新安装依赖

如果 `package.json` 或 `pnpm-lock.yaml` 有变化，更新后执行：

```bash
dsh plugin --profile <name> install
```

## 修改配置后的同步方式

> 以下同步方式仅适用于 **worktree 安装**。
> 如果使用 clone 模式安装，直接在 profile 目录里修改并提交即可。

profile 目录是本仓库的一个 git worktree，所以修改后可以直接在 profile 里提交：

```bash
cd ~/.dsh/profiles/<name>
git add -A
git commit -m "update profile config"
```

如果想把 profile 分支合并回主仓库的 `main`，在仓库根目录执行：

```bash
git merge --ff-only profile-<name>
```

如果 `--ff-only` 失败，说明 `main` 和 `profile-<name>` 已经分叉（例如 `main` 上有新的提交）。此时不要直接创建合并提交，先让 profile 分支基于最新的 `main`：

```bash
cd ~/.dsh/profiles/<name>
git fetch origin main
git rebase origin/main
```

如果有冲突，解决后继续：

```bash
git add -A
git rebase --continue
```

然后再回到主仓库执行：

```bash
git merge --ff-only profile-<name>
```

也可以直接推送 profile 分支：

```bash
cd ~/.dsh/profiles/<name>
git push origin profile-<name>
```

## 恢复备份

脚本在覆盖前会保留备份，例如：

```text
~/.dsh/profiles/<name>.bak.<YYYYMMDD-HHMMSS>
```

如果需要恢复：

```bash
rm -rf ~/.dsh/profiles/<name>
mv ~/.dsh/profiles/<name>.bak.<YYYYMMDD-HHMMSS> ~/.dsh/profiles/<name>
```

## Git 管理建议

`.gitignore` 已忽略：

```gitignore
node_modules/
cordis.yml
.dsh-market/
.env
.env.*
*.local
.DS_Store
```

请勿提交：

- `node_modules/`
- 生成的 `cordis.yml`
- `.dsh-market/`
- 任何包含凭据的 `.env` / 本地文件
```gitignore
node_modules/
cordis.yml
.dsh-market/
.env
.env.*
*.local
.DS_Store
```

请勿提交：

- `node_modules/`
- 生成的 `cordis.yml`
- `.dsh-market/`
- 任何包含凭据的 `.env` / 本地文件
