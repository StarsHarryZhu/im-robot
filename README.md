# im-robot（IM 机器人）

DeepSeek Harness 插件，纯宿主端：把一个微信账号接到你指定的会话上。支持 DSH 0.2.1-rc.5 及以上（低于 0.3）。

- 扫码者本人发来的文字、语音（用 iLink 附带的转写）、图片、文件、视频和引用的内容，会交给绑定的会话。文件存在这个绑定的媒体文件夹里，消息里写明路径。宿主支持时，图片直接放进消息（对话里能看到，模型也直接看到），其他 20 MB 以内的文件先上传给这个会话，在对话里显示成文件卡片；宿主不支持或会话拒收（比如模型不能看图）时，只发文字。
- 由微信消息触发的那一轮结束后，把这一轮最终的回答去掉 Markdown，按每条 100 字切成几条短消息，以纯文字发回微信。
- 会话最近一次输入来自微信时，不是微信消息触发的几种回合也会推送到微信：后台子代理交回结果、别的代理或团队成员发来消息、宿主插件自己发的通知（来源 `host-note`，如每日简报），以及定时提醒。见下面的「后台结果和宿主消息」。
- 断线自动重连；回复先落盘再发，重启或重连后补发；`status` 能看出连没连上、最近出了什么问题。
- 每个绑定可以单独设置：会话正在回答时，新消息是排队还是插话；`/` 开头的消息要不要当命令执行（如 `/ddl`、`/compact`）。另有「重新连接」和「诊断」，供总包的微信设置页使用。

它是「助理」总包 `@starsharryzhu/dsh-assistant` 的子插件，总包这样挂载它：

```yaml
- id: dsh-assisstant-im-robot
  name: '@starsharryzhu/im-robot'
  config:
    presets: [dsh-assisstant]
```

单独安装时，`cordis.patch.yml` 会加一行顶层 row（id `im-robot`）。

插件**不注册工具、不加提示词、不加命令**，没有绑定的会话完全不受影响。

## 配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `presets` | `[]` | 只允许绑定到这些 preset 的会话；空表示不限 |
| `autoPush` | `true` | 没有微信消息开启的回合（后台结果、宿主通知、提醒）是否自动发到微信。调用方自己用 `send` 决定发什么时设成 `false` |
| `silentReply` | `''` | 回复整条（去掉首尾空白）正好是这段文字时，什么都不发，也不发「没有得到回复」。给用固定标记表示「这次没话说」的调用方用；空表示每条回复都发 |
| `replyMaxChars` | `100` | 每条消息最多多少字（按字符数算，一个表情算一个），超过就切成几条发（最少 10） |

## `imRobot` 服务

```ts
login(bindingId: string, channel: 'wechat', signal?: AbortSignal): AsyncIterable<LoginState>
bind(bindingId: string, { sessionId }): Promise<void>
unbind(bindingId: string): Promise<void>
status(bindingId: string): BindingStatus
setOptions({ replyMaxChars?: number, enabled?: boolean }): void
setBindingOptions(bindingId: string, { sendMode?: 'queue' | 'steer', commands?: boolean, enabled?: boolean, replyMaxChars?: number }): BindingStatus
reconnect(bindingId: string): Promise<BindingStatus>
diagnose(bindingId: string): Promise<{ ok: boolean, checks: { label: string, ok: boolean, detail?: string }[] }>

interface BindingStatus {
  bound: boolean
  user?: string
  sessionId?: string
  connected: boolean
  lastError?: string
  sendMode: 'queue' | 'steer'
  commands: boolean
  enabled: boolean         // 这个绑定自己的开关；只关了全局开关时仍是 true，看 connected 判断有没有在收
  replyMaxChars: number    // 生效的上限：绑定自己的，没设过就是全局的
  lastInboundAt?: number   // 最近一次收到用户消息，epoch 毫秒
  lastOutboundAt?: number  // 最近一次发到微信，epoch 毫秒
}
```

类型 `BindingStatus`、`BindingOptions`、`SendMode`、`Diagnosis`、`DiagnosisCheck` 都从包入口导出。

`LoginState` 依次是：

1. `{ status: 'qr', qr, expiresAt }`：`qr` 是要编码成二维码的内容。二维码过期会自动换新的，一共最多三张，每换一张就再给一个 `qr`。
2. `{ status: 'scanned' }`：已扫码，等手机上确认。
3. `{ status: 'bound', user }`：`user` 是打码后的微信用户 id。

中途结束时给 `{ status: 'expired' | 'failed', reason }`，`reason` 是给用户看的中文白话。同一个 `bindingId` 再次调用 `login` 会取消上一次。

- `bindingId`：1–64 个字母、数字、`_` 或 `-`，以字母或数字开头。总包用用户的 id。只差大小写的两个 id 在 macOS 上会共用一个状态文件，请统一用小写。
- `bind`：要先登录过。配置了 `presets` 时，会话的 preset 不在列表里就抛错。新版宿主用 `agentPresets.presetForSession` 读 preset，0.2.1-rc.5 这样没有该方法的宿主读 `sessionProjections.stateOf(session, 'agentPreset')`；读不到按没有 preset 处理。
- `unbind`：停止收消息，删掉凭据和状态文件。
- `status`：`connected` 表示正在正常收消息；`lastError` 是最近一个还没解决的问题，用中文白话写，例如「微信登录已失效，请重新绑定」「连不上微信服务器，正在自动重连」「回复没能发到微信，会自动重试」「微信暂时不让助理先发消息（多半是超过一天没在微信里说话），在微信里回一句，没发出去的就会补发」。问题解决后会清掉。`windowClosesAt` 是微信不再收 bot 消息的时间：用户最后一条微信消息之后 24 小时，用户还没发过消息时没有。
- `setOptions({ enabled: false })`：停掉所有连接，设回 `true` 再接上。全局和绑定的开关都开着，绑定才算开，所以这里设回 `true` 不会接上绑定自己关掉的那些。`replyMaxChars` 立即生效，只影响没有设过自己上限的绑定。
- `setBindingOptions`、`reconnect`、`diagnose`：见下面的「微信设置页用的接口」。

事件（cordis）：

- `im-robot/inbound(sessionId, channel)`：每条消息交给会话**之前**发出（不论是 prompt 还是命令），插件会等所有监听者执行完再继续。总包借这个时机提示 AI 用纯文字回复。
- `im-robot/status(bindingId, state)`：`status()` 的结果有变化时发出（登录、绑定、解绑、连上、断开、出错、恢复、改了绑定选项），`state` 和 `status()` 的返回值一样。只有 `lastInboundAt` / `lastOutboundAt` 变了**不**发，免得每条消息都触发一次；设置页打开时直接调 `status()` 读就行（同步、很便宜）。

## 微信设置页用的接口

总包给每个用户画一个微信设置页，下面这些都由它调用。

**绑定选项** `setBindingOptions(bindingId, { sendMode?, commands?, enabled?, replyMaxChars?, mediaDir? })`：写进这个用户的状态文件，立即生效，返回新的 `status()`。没扫码登录过的用户会抛错；值不对会抛 `RangeError` / `TypeError`。重新扫码登录时保留，`unbind` 后回到默认。没有变化时直接返回，不写文件，也不发 `im-robot/status`，所以收到 status 后再调一次不会循环。

| 选项 | 默认 | 含义 |
| --- | --- | --- |
| `sendMode` | `'queue'` | `'queue'`（排队）：会话正在回答时，新消息等这一轮结束再处理。`'steer'`（插话）：会话正在回答时，新消息插进正在进行的这一轮（宿主的 `prompt({ mode: 'steer' })`），这一轮的回答照常发回微信。会话空闲时两者一样。 |
| `commands` | `true` | 用户发来的消息以 `/` 开头、而且宿主有这个命令（比如总包的 `/ddl`、宿主的 `/compact`）时，像网页输入框那样直接执行命令，不交给 AI；命令的结果文字切段后发回微信，没有文字时回「已执行」，失败时回原因。宿主没有这个命令时（比如技能 `/某个技能`），照常当文字交给会话。设成 `false` 时，所有消息都当文字。 |
| `enabled` | `true` | 设成 `false` 时只有这个绑定停止收发，和全局关闭的效果一样：不轮询、不把消息交给会话、不发微信。关闭期间产生的回复留在发件箱，重新打开后补发 24 小时内的；提醒和提示语不保留。设回 `true` 就恢复接收。 |
| `replyMaxChars` | 不存，用全局值 | 这个绑定每条回复的上限，是不小于 10 的整数，回复、命令结果和后台结果都按它切段。设过之后不再跟随全局值，也没有办法清回去，`unbind` 后才回到全局值。 |
| `mediaDir` | 不存，用 `plugin-data/im-robot/media/<绑定id>` | 这个绑定收到的图片、文件、语音和视频存到哪个文件夹，必须是绝对路径。总包传助理工作区的 `IM/WeChat` |

**主动发送** `send(bindingId, text, { notBefore? })`：任何时候把文字发到这个账号，不管最近一次输入来自哪里。和回复一样去掉 Markdown、按上限切段、保留 `<keep>` 块，走发件箱。给了 `notBefore`（毫秒时间戳，最多 24 小时后）就留在发件箱里，到时候再发，不挡后面的消息。没登录、没绑定、已关闭或文字为空时抛错。调用时绑定的会话如果正在跑一轮，这一轮结束时不再自动发回复，也不发「没有得到回复」。

**决定这一轮的回复发到哪** `route(bindingId, { chat, notBefore? })`：对绑定会话正在跑的那一轮生效，覆盖上面的默认规则。`chat: true` 时这一轮的最终回复走发件箱发到微信，不管这一轮是谁开启的（微信消息、心跳、宿主通知都行），可以带 `notBefore` 推迟；`chat: false` 时这一轮的回复不发到微信，即使是在回答微信消息（「正在输入」照样清掉）。同一轮里后一次调用覆盖前一次。没有正在跑的一轮时返回 `false`，什么也不做；不能发送时和 `send` 一样抛错。路由了但这一轮没有文字时什么也不发，也不发「没有得到回复」。

**重新连接** `reconnect(bindingId)`：丢掉当前的长轮询，退避计时清零，马上重新轮询，等第一次轮询有结果（成功或失败）后返回 `status()`。每个轮询循环的第一次轮询只等几秒（5 秒），所以通常几秒内就返回；最多等 15 秒。不会重新扫码：登录已失效的仍然是失效，`lastError` 还是「微信登录已失效，请重新绑定」。还没绑定会话、或者全局或这个绑定的 `enabled` 是 `false` 时，直接返回当前状态。

**诊断** `diagnose(bindingId)`：快速检查，只读，返回 `{ ok, checks }`，`label` 和 `detail` 都是中文白话：

| `label` | 检查什么 | 不通过时的 `detail` 举例 |
| --- | --- | --- |
| 微信登录信息 | 凭据还在 | 没有找到微信登录信息，请重新扫码 |
| 连接微信服务器 | 调一次 iLink 的 `getconfig`（5 秒超时）能得到回答 | 连不上微信服务器 / 微信服务器没有及时回应 / 微信服务器出错（HTTP 502） |
| 微信登录状态 | 服务器接受 token（`getconfig` 说不清时，看最近一次轮询是否成功） | 微信登录已失效，请重新绑定 |
| 绑定的会话 | 会话存在，而且是允许的 preset | 还没有绑定会话 / 找不到会话 … / 会话 … 的类型是「…」… |
| 待发的回复 | 发件箱里没有发送失败过、也没有在等用户说话的回复 | 还有 2 条回复没发出去，其中 1 条发送失败过，会在连上后自动补发（上次失败：…，…）/ 还有 1 条消息在等你在微信里说话：微信暂时不让助理先发，你回一句就会补发（上次失败：…，sendmessage ret=-2 …） |

诊断不改任何东西，唯一的例外是：全部通过时清掉 `lastError`（并发出 `im-robot/status`）。没扫码登录过的用户只返回一项「微信登录信息」不通过。

## 后台结果和宿主消息

助理的对话只负责说话和派活，真正的结果往往在后面的回合里：用户在微信上说「周四下午两点看牙医」，对话先回「好，我这就记下来」，等后台子代理做完，它的汇报进入会话、开了新的一轮，这一轮的回答「记好了，周四 14:00 看牙医」才是结果。

所以，只要会话**最近一次人的输入来自微信**，下面这些回合结束时，最终回答也会发到微信：

| 这一轮由什么开始 | 怎么发 |
| --- | --- |
| 子代理交回结果（`subagent-settled`） | 和普通回复一样：去掉 Markdown、切段、进发件箱，失败会补发 |
| 别的代理或团队成员的消息（`agent-message`、`team-message`） | 同上 |
| 宿主插件自己发的通知（`host-note`） | 同上 |
| 定时提醒（`schedule`） | 只推一次，失败不重试 |

- 这一轮没有文字（对话有意不出声）时什么都不发，也不发「这次没有得到回复」。
- 这一轮里如果也有微信消息，就按普通回复只发一次。
- 有人在网页上打字（来源是 `user`，请求 id 不是本插件的）之后，「最近一次输入」就不再算微信，这些回合都不推，直到用户再从微信发消息。

**宿主插件自己发的通知**（每日简报、看门狗提示等）要用 `agent.followup(message)` 发，来源写成 `{ kind: 'host-note', plugin: '插件名' }`。这样它不算网页输入，不会把「最近一次输入来自微信」清掉，它这一轮的回答也会推到微信：

```ts
agent.followup(createUserMessage({
  content: [{ type: 'text', text: '[助理·系统] 今天的简报……' }],
  source: { kind: 'host-note', plugin: 'dsh-assisstant' },
}))
```

用 `sessionController.prompt` 发的消息来源是 `user`，仍然算网页输入。

## 切段规则

回复超过 `replyMaxChars` 时切成几条，每条尽量在自然的地方断开，优先级从高到低：

1. 段落之间的空行；
2. 换行；
3. 句末：中日文的 `。！？`、省略号、阿拉伯文 `؟`、印地文 `।`，以及英文后面跟空格的 `. ! ?`；
4. 逗号一级：`，、；：`、阿拉伯文 `،`，以及英文后面跟空格的 `, ; :`；
5. 空格。

断点只在这一条的后半段里找，免得切出很短的一条；后半段找不到时，宁可在前面的空格处断，也不切断单词或链接，实在没有才硬切。`3.14`、`1,000`、`10:30` 和网址里的标点不算断点。收尾的引号、括号跟着前面的句子走。

### 整块不切：`<keep>…</keep>`

列表、表格、步骤这类带结构的内容，可以让 AI 用 `<keep>` 和 `</keep>` 包起来，这一块就会放在同一条消息里发，不会被切开：

- 前后的文字放得下就和它合成一条，放不下就让它单独成一条；
- 单独成一条时可以超过 `replyMaxChars`，最多 2000 字（`KEEP_MAX_CHARS`）。超过 2000 字的仍按上面的规则切，换行优先；
- 标记本身不会发出去；大小写、尖括号里多余的空格都能认；忘了写结尾标记，就一直保留到结尾。

插件自己不加提示词，**要 AI 用这个标记，得由总包的提示词告诉它**。可以从包里导入 `KEEP_OPEN`、`KEEP_CLOSE` 写进提示词，例如：「带结构的内容（列表、表格、步骤）请用 <keep> 和 </keep> 包起来，这样它会整块发到微信。」有了自动切段，提示词里就不必要求 AI 每条控制在 100 字以内。

## 可靠性

- **断线重连**：长轮询出错或网络断开时自动重连，间隔从 2 秒开始翻倍，最长 5 分钟，循环不会自己退出。
- **登录失效**：服务器说 token 失效（-14），或凭据被删了，就把 `connected` 设为 false、`lastError` 设为「微信登录已失效，请重新绑定」，并发出 `im-robot/status`。之后每小时再试一次（照腾讯插件的做法），用户重新扫码就立刻恢复。
- **发件箱**：每条最终回复切段后，先写进状态文件的 `outbox`，发成功再删掉。没发出去的，在下一次长轮询成功时补发，所以重连或重启后都会补发。补发时用这条回复当时的 `context_token`。超过 24 小时的直接丢弃；失败超过 3 次（第 4 次还失败）也丢弃。丢弃只记日志。
- 后台结果、别的代理的消息、宿主通知的回答和 `send` 也进发件箱。提醒推送和提示语不进，只发一次。
- 账号还没发过消息时没有 `context_token`。这时服务器拒收的话不算失败，发件箱会等他发来第一条消息再发（24 小时内）。
- **一天不说话就不让先发**：用户最后一条微信消息之后大约 24 小时，iLink 不再收 bot 先发的消息。腾讯没有写明这个规则，第三方桥接项目都这么说；在用户的 Desktop 上，隔 5 小时发的能收到，隔 33、38 小时发的都没到。另有第三方说法称，用户每发一条消息，bot 最多能发 10 条左右，这条没验证过。所以发送失败时，如果 iLink 回的是 `-2`（去掉 `context_token` 重发后仍然是 `-2`），或者离用户最后一条消息已超过 24 小时，就不算失败、也不重试，发件箱等用户下一条消息；之后来的回复也排在后面。用户一发消息，发件箱就用这条消息的 `context_token` 按顺序补发（超过 24 小时的照常丢弃）。等待期间 `lastError` 会说明，诊断也会写出来。
- 最近一次发送失败（时间和 iLink 的回答，不含任何凭据）记在状态文件的 `lastSendFailure` 里，重启后也能查。
- **会话过期**：用户一段时间没说话后，iLink 对带旧 `context_token` 的消息会回 `-2`（`prepare failed` 或 `unknown error`）。这时去掉 `context_token`、换一个 client id 再发一次（照 dsh-weixin-ilink 0.10.3 的做法）。以前这种消息会算发送失败，重试几次后被丢掉，用户收不到主动发的消息。

## 数据放在哪里

- 微信的 `bot_token` 存在 `ctx.credentials`，引用名是 `IM_ROBOT_WECHAT_<bindingId>`。引用名只能用字母、数字和 `_`，所以 id 里的 `_` 写成 `_5F`，`-` 写成 `_2D`。
- 其余的放在 `$DSH_HOME/plugin-data/im-robot/<bindingId>.json`（`DSH_HOME` 默认 `~/.dsh`），权限 0600。里面有：会话 id、打码后的用户名、`ilink_user_id`、iLink 分配的 API 地址、`getupdates` 的 sync buf、最新的 `context_token`、最近一次输入是否来自微信、绑定选项（`options`）、最近收发消息的时间、最近一次发送失败，以及还没发出去的回复（`outbox`）。

## 第一版不做

发送图片和文件、群聊、把语音转成别的格式（语音文件是原始 SILK）。不认识的消息类型会回一句提示。

媒体文件不会被自动删除。

## 开发

```bash
node scripts/link-dev.mjs
```

```bash
npm test
```

`link-dev` 从旁边的 harness checkout 链接 TypeScript、vitest 和宿主包；`npm test` 先构建 `lib/`（要提交），再跑测试。测试起一个本地的假 iLink 服务，不连真实的微信。

## 许可证和来源

MIT。协议层改写自腾讯官方的 `@tencent-weixin/openclaw-weixin` 2.4.10（MIT），接入 DSH 的思路参考 `dsh-weixin-ilink` 0.9.1（MIT）。每个改写过的文件开头都写了来源和改动，版权行和许可证全文见 `THIRD_PARTY_NOTICES.md`。没有使用 Apache-2.0 的 `@michengai/dsh-im-connect` 的任何代码。
