# DSH OpenAI 账号 Connector

`dsh-openai-account-connector` 把 OpenAI 官方账号登录、动态 GPT 模型和图片生成接入 DeepSeek Harness 的唯一模型目录。用户只在 OpenAI 官方浏览器页面登录；插件没有 Token 输入框，也不读取、复制、记录或返回 OAuth Token。

登录成功后，Connector 在 `ctx.llm` 注册 `openai-codex` 路线。DSH 原生对话框的模型选择器直接列出 app-server 返回的模型；文本回答和生成图片都通过这条路线进入当前 Harness 会话。图片先由官方运行时生成，再经过路径、符号链接、文件类型和大小检查写入 Harness 附件库。

## 安装

该 alpha 版本需要包含 Harness `732a504` 之后授权目标契约、并支持 `llm-pi-ai.delegatedProviders` 的 DSH 构建。它与 Provider-neutral 的 [`dsh-account-authorization`](https://github.com/lxy271713/dsh-account-authorization) UI 配合使用：UI 只展示 Flow，本插件拥有 OpenAI 协议和模型 Adapter。

```sh
dsh plugin --profile desktop add dsh-account-authorization
dsh plugin --profile desktop add dsh-openai-account-connector
```

安装 bundle 会让专用 Connector 单独接管 `openai-codex`，避免通用 pi-ai Adapter 和专用 Adapter 同时成为同一路线的所有者。Provider 名称只存在于本专用 Connector 和 bundle 配置中；账号 UI、Bridge 和 Harness 核心没有 OpenAI 分支。

## 行为

- “连接账号”调用官方 app-server 浏览器登录；若 Codex 已登录，只验证账号并建立 DSH 连接标记。
- Connector 不读取 Token。Token 的持久化与刷新完全由官方 app-server 管理。
- “断开连接”删除 DSH 的连接标记并撤下模型路线，不会替用户退出其他 Codex 客户端。
- 每次模型调用使用独立临时工作目录，不获得项目目录的隐式写权限。
- DSH 原生工具会映射为 app-server 动态工具；工具调用返回 Harness Agent 循环，并继续受 DSH 当前权限策略约束。
- app-server 未声明图片能力、返回越界路径、符号链接、空文件、超限文件或未知格式时，整次图片输出失败且不发布图片消息。

## 开发验证

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

单元测试不能替代正式 DSH Desktop 验收。发布前必须在真实 2.0.3 窗口完成：账号连接、模型刷新、文本短推理、图片生成预览、重启回放和断开后路线消失。

## 当前限制

- app-server 图片完成事件和动态工具目前属于实验协议；Connector 读取 live 图片能力，并对字段变化 fail-closed。
- app-server 协议不提供 DSH 的 `temperature`、`maxTokens`、`stop` 控制；设置这些参数的请求会明确失败。
- Harness 附件服务没有事务 staging。图片保存成功后若调用随即取消，可能留下一个未被会话引用的内容寻址对象，由附件保留策略后续处理。
- 当前包只实现 OpenAI 专用 Connector。豆包、千问、Kimi、GLM、xAI 必须各自提供独立 Connector；不得在账号 UI 中加入 Provider 名称分支。
