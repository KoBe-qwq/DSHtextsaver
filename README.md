# DSHtextsaver（dsh-context-pack）

给 DSH（DeepSeek Harness）用的会话打包插件：把某个会话完整导出成一个 `.dshpack` 文件，在另一台装了同一插件的 DSH 上导入，接着原来的对话和文件继续干活。

- 导出：左侧会话行右键 → **打包为上下文包**
- 导入：左侧工作区行右键 → **导入上下文包…**

## 安装

1. 从 [Releases](https://github.com/KoBe-qwq/DSHtextsaver/releases) 下载 `dsh-context-pack-1.0.0.zip`
2. 解压到 DSH profile 的 `node_modules` 下，目录名保持 `dsh-context-pack`，例如：
   `C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-context-pack`
3. 编辑同目录的 `package.json`，把包名加进 bundle 列表：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-context-pack"]
    }
  }
}
```

4. 重启 DSH。左侧会话行右键出现“打包为上下文包”即为加载成功。

> 桌面端 profile 由 Electron 独占管理，`dsh --profile desktop` 会被拒绝，所以这里是手动安装。

## 用法

**导出**：右键会话 → 打包为上下文包 → 选择保存位置。文件名形如
`context-pack-<会话标题>-<时间戳>.dshpack`。

**导入**：右键目标工作区 → 导入上下文包… → 选择 `.dshpack`。导入完成后按提示刷新页面，新会话出现在侧栏。

## 包里有什么

| 内容 | 说明 |
| --- | --- |
| 会话事件日志 | 完整用户/助手消息、工具调用与结果、推理内容、标题、模型路由 |
| 子会话 | 递归收集 subagent 会话，保留父子关系 |
| 用量 | 按事件汇总 input/output/cache token |
| 环境快照 | 平台、Node/Electron 版本、locale、cwd、最后的 provider/model 配置（**已脱敏**）、权限/沙箱设置 |
| 附件 | 图片与文件，走 DSH attachments API 保存为内容寻址对象 |
| 产物文件 | 从工具参数中提取的路径，单文件 ≤ 8MB、总量 ≤ 64MB |
| 保真度报告 | `fidelity` 字段标注每一项是 included / partial / excluded |

包格式：`DSHCP1\n` + 元数据 JSON 行（字节数 + SHA-256）+ gzip(JSON)。导入时校验摘要、`format` 与 `schemaVersion`。

## 已知限制

- **不含密钥**：`.credentials`、`.env`、私钥类文件被排除，配置中的 api key/token 被脱敏。目标机器需要自己配好 provider。
- **不含系统提示词、运行时内存、进行中的工具状态**；导入的是历史记录，不是进程快照。
- **产物只按路径记录**：超过体积上限的文件不入包，只留路径；cwd 之外的文件不会复制。
- **导入是复制，不是移动**：所有会话都会分配新的 session id；产物只在目标不存在时写入，绝对路径产物落到 `.dsh-context-pack/import-<时间戳>/`。
- **附件链路**尚未在含真实附件的会话上做过端到端验证。
- 跨 DSH 大版本升级可能需要适配 `schemaVersion`；不兼容时导入会直接报错而不是静默丢数据。

## 目录结构

```
package.json          # 插件包声明（host + client + bundle patch）
cordis.patch.yml      # 把插件插入 profile 的 patch
lib/index.js          # Host 端：导出/导入路由、日志读写、收集与还原
lib/client.js         # 浏览器端：两个右键菜单入口
```

## 开发

插件只使用 DSH 的公开 API：

- `ctx.get('sessionPersistence')` — `flush/list/open/create` 读写会话日志
- `ctx.get('attachments')` — 读写附件对象
- `ctx.get('workspaceRegistry')` — 查找工作区、`attachSession`
- `ctx.get('profileContext')` — 读取 profile 配置（脱敏后入包）
- `ctx.connection.fetch.register` — 注册 `/api/context-pack.export` 与 `/api/context-pack.import`
- 客户端 `ctx.contextMenus.register` — 注册 `session` / `workspace` 两类右键项

不修改 `app.asar`，不依赖私有接口。
