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

并通过 `install-profile.sh` 以 **git worktree** 方式安装到 dsh profile 目录。

## 目录结构

```text
dsh-web-profile/
├── README.md
├── install-profile.sh
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── cordis.patch.yml
└── pnpm-workspace.yaml
```

## 安装脚本

```bash
# 安装为默认 profile：web
./install-profile.sh

# 安装为自定义 profile
./install-profile.sh web2

# 跳过确认（覆盖前仍会备份）
./install-profile.sh --force web2
```

### 脚本做了什么

1. 在 `~/.dsh/profiles/<name>` 创建 **git worktree**
   - 默认分支：`profile-<name>`
   - 例如 `web` 对应分支 `profile-web`
2. worktree 从本仓库检出真实的配置文件：
   - `package.json`
   - `pnpm-lock.yaml`
   - `cordis.patch.yml`
   - `pnpm-workspace.yaml`
3. 如果目标 profile 已存在：
   - 询问是否覆盖
   - 覆盖前把原目录移动到带时间戳的备份：

     ```text
     ~/.dsh/profiles/<name>.bak.<YYYYMMDD-HHMMSS>
     ```

4. 执行依赖安装：

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

## 修改配置后的同步方式

`~/.dsh/profiles/web` 是本仓库的一个 git worktree，所以修改后可以直接在 profile 里提交：

```bash
cd ~/.dsh/profiles/web
git add -A
git commit -m "update web profile config"
```

如果想把 profile 分支合并回主仓库的 `main`：

```bash
cd ~/projects/dsh-web-profile
git merge profile-web
```

也可以直接推送 profile 分支：

```bash
cd ~/.dsh/profiles/web
git push origin profile-web
```

## 恢复备份

脚本在覆盖前会保留备份，例如：

```text
~/.dsh/profiles/web.bak.20260819-212328
```

如果需要恢复：

```bash
rm -rf ~/.dsh/profiles/web
mv ~/.dsh/profiles/web.bak.20260819-212328 ~/.dsh/profiles/web
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
