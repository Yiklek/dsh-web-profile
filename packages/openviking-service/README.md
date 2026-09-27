# dsh-openviking-service

一个 DSH profile 生命周期插件：按需启动本地 OpenViking 服务，并在 profile 销毁时
停止它。

它**只是进程守护**——记忆、召回、捕获以及 `mcp__openviking__*` 工具全部属于
`@openviking/dsh-memory-plugin`，本条目有意排在它**之前**加载。

## 挂载方式

`scripts/install-services.mjs` 会把受管块写入 profile 的 `cordis.patch.yml`：

```yaml
- id: openviking-memory
  config:
    - id: openviking-service-autostart
      name: dsh-openviking-service          # 裸包名
      config:
        serviceRoot: "<profile>/.services/openviking"
    - id: openviking-memory-runtime
      name: '@openviking/dsh-memory-plugin'
```

条目名使用真实包名而非 `file://` 路径是有意的：DSH 的 DeepSeek 请求扩展清单会在
每个请求前把每个活动条目解析到其所属 npm 包，而松散模块路径必须靠向上查找某个
`package.json` 来解析。使用规范的包标识可以完全避开这条脆弱路径。

## 行为

| 条件 | 结果 |
|---|---|
| `/health` 已有响应 | 直接接管；不重启，退出时也不停止它 |
| PATH 中没有 `uvx` | 静默跳过——OpenViking 是可选组件 |
| 缺少 `ov.conf` | 打印警告并跳过 |
| 其他情况 | 启动 `uvx --from openviking[local-embed] openviking-server` |

启动是**非阻塞**的：就绪状态在后台等待，因此冷启动不会拖住 DSH 启动。这样做是
安全的，因为运行时在端点不可达期间会把写入排入 `.services/openviking/pending/`，
待其就绪后再重放。

导出给进程其余部分的变量：

```text
OPENVIKING_HOME · OPENVIKING_CONFIG_FILE · OPENVIKING_CLI_CONFIG_FILE
OPENVIKING_STATE_DIR · OPENVIKING_PENDING_DIR · OPENVIKING_URL
```

清理通过 `ctx.effect` 注册，因此 profile 会停止它自己启动的服务（先 SIGTERM，
5 秒后 SIGKILL）。
