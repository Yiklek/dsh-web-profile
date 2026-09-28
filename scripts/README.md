# Profile 本地记忆服务

本 profile（`~/.dsh/profiles/web`，分支 `profile-web`）是权威副本。项目工作树
`~/projects/dsh-web-profile`（分支 `main`）是另一个独立工作树——在那里改动
**不会**影响正在运行的 profile。

## 目录结构

```text
~/.dsh/profiles/web/
├── package.json                      # 依赖 + dsh.profile.bundles
├── pnpm-workspace.yaml               # workspaces: "." 与 "packages/*"
├── cordis.patch.yml                  # 用户补丁层（已 gitignore）
├── packages/
│   └── openviking-service/           # profile 生命周期插件（真实包）
│       ├── package.json              # name + version → 正常包标识
│       ├── index.mjs
│       └── README.md
├── scripts/
│   └── install-services.mjs          # 把 cliPath 与 autostart 写进补丁
└── .services/                        # 已 gitignore，profile 本地数据
    ├── mnemon/                       # Mnemon 运行时 + documents
    └── openviking/                   # ov.conf、data/、logs/、pending/、state/
```

`pnpm install` 会执行 `postinstall` → `install-services.mjs`，由它改写
`cordis.patch.yml` 里的两行：

- `id: mnemon` —— 补上/更新 `cliPath`、按需调整 `storageScope` 与 `dataDir`
- `id: openviking-memory` —— 仅在 OpenViking 处于启用状态时存在；不带 `--openviking`
  的一次运行会删除该行，并把 `@openviking/dsh-memory-plugin` 从
  `dsh.profile.bundles` 中摘掉

整个文件按 YAML 解析后重新序列化，与 `@deepseek-ai/dsh-config-editor`（设置界面写这个
文件的实现）走同一套代码路径，因此两边轮流写入不会互相破坏。脚本**只**改自己管理的字段
（`cliPath` / `storageScope` / `dataDir`），其它字段一律原样保留——包括 Mnemon 设置界面
写进同一行的字段。

关于 `!!js`：解析时按 `@deepseek-ai/dsh-config-editor` 的方式声明该标签，取值即**原始
源文本**，脚本**从不执行**它。落在受管字段上的表达式会被跳过并报告——脚本管理的是这些
字段的**值**，不是恰好写在这里的表达式；落在其它字段上的表达式原样保留、标签不丢。

注释：行上的注释会保留（脚本在其中一行上方留了一条归属说明）。但 `config:` **内部**的
注释不保证——设置界面写入时会整节点替换 `config`，这一点在脚本改造前就已如此。

## 命令

```bash
pnpm run install-services                             # 重新接线路径与配置
pnpm run install-services -- --check                  # 只报告，不写文件
pnpm run install-services -- --openviking             # 启用 OpenViking 记忆
pnpm run install-services -- --no-warmup              # 跳过 uvx 预热（离线/快速）
pnpm run install-services -- --mnemon-data            # Mnemon 数据：profile 本地
pnpm run install-services -- --mnemon-data profile    # 与裸参数等价
pnpm run install-services -- --mnemon-data workspace  # Mnemon 数据：按工作区
pnpm run install-services -- --mnemon-data workspaces # Mnemon 数据：单一根目录、按工作区分目录

pnpm test                                             # 跑本脚本的测试套件
```

## 预热与版本钉住

启用 OpenViking 时，`--openviking` 会跑一次

```bash
uvx --from "openviking[local-embed]==0.4.22" openviking-server --version
```

把运行时提前装进 uv 的缓存（首次要编译 llama-cpp-python，约十几分钟）。

**版本是钉住的**，这很重要：不带 `==` 的 `--from` 每次都会重新解析传递依赖，而 uv 按**解析出的环境**做缓存键 —— 任何依赖漂移都会多留一份完整环境（含 `local-embed` 时约 800 MB）。实测未钉时缓存里堆了 4 份 0.4.20 的环境（其中两份包列表完全一致）。升级请显式改 `OPENVIKING_RUNTIME_VERSION`。

## 测试

```bash
pnpm test          # node --test "scripts/*.test.mjs"
```

`install-services.test.mjs` 有 34 项，**每一项都把真实脚本当子进程跑在一个临时 profile 上**（靠 `DSH_PROFILE_ROOT` 指过去），断言的是脚本留下的**文件内容**，而不是内部函数。因此它同时覆盖了 argv 处理、退出码和文件写入，也不需要改动你正在用的 profile。

临时 profile 里会造一个假 mnemon CLI，两条路径都给：POSIX 的可执行 shim，以及 Windows 会解析到的 `@mnemon-dev/mnemon/bin/mnemon.js`。

CI 在 **ubuntu / windows / macos** 三个平台上跑这套测试 —— 脚本的 `cliPath` 取值和 CLI 探测方式都随平台变化，只在 Linux 上跑代表不了另外两个。

## 退出码

| 情况 | 结果 |
| --- | --- |
| `--mnemon-data` 值非法 | `exit 2`（立即） |
| 整个 `cordis.patch.yml` 不是合法 YAML、或不是序列 | `exit 1`——这种文件 DSH 自己也加载不了，不该假装安装成功 |
| mnemon 行的 `config` 不是映射 | 未传 `--mnemon-data`：警告，该行不动，`exit 0`<br>传了：报错，该行不动，`exit 1` |
| 受管字段上是 `!!js` 表达式 | 未传 `--mnemon-data`：警告，该字段不动，`exit 0`<br>传了：报错，该字段不动，`exit 1` |
| 数据目录建不出来 | **警告**，继续，`exit 0`——`postinstall` 不该因此让 `pnpm install` 失败，而插件会按需自建存储目录 |

`config` 不是映射、或字段是表达式这两种情况会 `exit 1` 时，都要求显式传 `--mnemon-data`
（`postinstall` 从不传），所以安装过程不会被它们阻断。整个文件不可解析是例外——那是
profile 本身坏掉了。

## 服务

**Mnemon**——本地 CLI 位于 `node_modules/.bin/mnemon`，无常驻进程。

它的存储作用域从现有的 `id: mnemon` 行中读取并**原样保留**，因此在 Mnemon 设置界面里
选定的作用域能够扛过 `pnpm install`。只有从未配置过的 profile 才会回落到 profile 本地
根目录。要强制指定作用域，传 `--mnemon-data`：

| `--mnemon-data` | `storageScope` | 数据根 |
| --- | --- | --- |
| 裸参数，或 `profile` | `custom` | `.services/mnemon` |
| `workspace` | `workspace` | `<工作区>/.mnemon`——该作用域会忽略 `dataDir`，因此该行会被删除 |
| `workspaces` | `workspaces` | `.services/mnemon/workspaces/<工作区路径的 sha256>` |

`profile` 与 `workspaces` 会预建 `.services/mnemon`（`~/` 前缀会先展开成家目录）；
预建是尽力而为：失败只打印警告，不会中断 `pnpm install`，因为插件运行时会按需创建
自己的存储目录。`workspace` 不建任何目录。三种作用域是彼此独立的存储：切换**不会**
迁移数据，工作区改名或移动会算出新的哈希目录。

**OpenViking**——`dsh-openviking-service` 包按需启动服务，并在 profile 销毁时停止
它。它从不阻塞插件加载：冷启动在后台进行，而运行时在端点不可达时会把写入排入
`.services/openviking/pending/` 队列。

它以**裸包名**挂载，而不是 `file://` 路径。每个活动条目在每个 DeepSeek 请求前都会
被解析到其所属 npm 包（`dsh-plugin-package-inventory-deepseek`）；松散模块路径则要
靠向上查找最近的 `package.json` 来解析——当初缺 `version` 字段引发的
`DeepSeek request extension preparation failed` 正是这条路径。使用真实包标识可以
完全避开它。

> OpenViking 的本地嵌入后端需要 `llama-cpp-python`，而纯 `uvx --from openviking`
> 安装并不包含它。守护进程已用 `openviking[local-embed]` 额外项启动；它会构建
> 一次，之后由 uv 缓存。想完全避免构建，可在 `ov.conf` 里配置远程
> `embedding.dense.provider`。

**Hindsight**——已彻底移除。插件、bundle 条目、服务插件、`.services/hindsight/`
与 `~/.hindsight/` 均已不存在。

## 环境隔离

OpenViking 插件会把 `OPENVIKING_*` 变量（config、state、pending、URL）导出到 DSH
进程中，使运行时插件解析到 profile 本地路径。该写入按命名空间隔离、进程级生效，
这是有意为之；除此之外不改动任何东西。
