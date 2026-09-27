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

`pnpm install` 会执行 `postinstall` → `install-services.mjs`，由它重写
`cordis.patch.yml` 里的两个受管块：

- `# LOCAL_MNEMON_CLI_START` … `# LOCAL_MNEMON_CLI_END`
- `# OPENVIKING_AUTOSTART_START` … `# OPENVIKING_AUTOSTART_END`——仅在 OpenViking
  处于启用状态时存在；不带 `--openviking` 的一次运行会删除该块，并把
  `@openviking/dsh-memory-plugin` 从 `dsh.profile.bundles` 中摘掉

标记块之外的内容逐字节保留；块内**只**改脚本自己管理的那几行
（`cliPath` / `storageScope` / `dataDir`），其它字段与注释一律原样保留。值没变的行不
重写，所以受管块内即使出现 `!!js` 表达式也会原样保留（脚本**不执行**它）；显式传
`--mnemon-data` 时它按普通值被覆盖或删除。

## 命令

```bash
pnpm run install-services                             # 重新接线路径与配置
pnpm run install-services -- --check                  # 只报告，不写文件
pnpm run install-services -- --openviking             # 启用 OpenViking 记忆
pnpm run install-services -- --mnemon-data            # Mnemon 数据：profile 本地
pnpm run install-services -- --mnemon-data profile    # 与裸参数等价
pnpm run install-services -- --mnemon-data workspace  # Mnemon 数据：按工作区
pnpm run install-services -- --mnemon-data workspaces # Mnemon 数据：单一根目录、按工作区分目录
```

## 退出码

| 情况 | 结果 |
| --- | --- |
| `--mnemon-data` 值非法 | `exit 2`（立即） |
| 受管块不是合法 YAML，未传 `--mnemon-data` | 警告，整块不动，`exit 0` |
| 受管块不是合法 YAML，且传了 `--mnemon-data` | 报错，整块不动，`exit 1` |
| 某受管字段在块内找不到对应缩进的行（被手工改过），未传 `--mnemon-data` | 警告，该字段不动，`exit 0` |
| 同上，但该字段本应被 `--mnemon-data` 改写 | 报错，该字段不动，`exit 1` |
| 数据目录建不出来 | **警告**，继续，`exit 0`——`postinstall` 不该因此让 `pnpm install` 失败，而插件会按需自建存储目录 |

需要 `exit 1` 的两种情况都要求显式传 `--mnemon-data`（`postinstall` 从不传），所以安装
过程不会被它们阻断。

## 服务

**Mnemon**——本地 CLI 位于 `node_modules/.bin/mnemon`，无常驻进程。

它的存储作用域从现有的受管块中读取并**原样保留**，因此在 Mnemon 设置界面里选定
的作用域能够扛过 `pnpm install`。只有从未配置过的 profile 才会回落到 profile 本地
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
