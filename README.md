# 微信 AI 桥接

这个项目会登录 ClawBot 的微信通道，持续拉取微信消息，把文本或图片发送给兼容 OpenAI 接口的模型，再把回复发回微信。对最终用户来说，体验上就像是在和一个普通微信联系人聊天。

## 功能概览

- 支持微信扫码登录
- 支持文本聊天
- 支持图片消息输入，并把图片内容交给支持视觉输入的模型理解
- 支持文件、视频、语音消息的下载与解密
- 支持长期记忆，会按微信用户分别保存
- 支持通过 `MEDIA:/绝对路径/文件` 指令把本地文件上传回微信

## 运行要求

- Node.js 22 或更高版本
- 可用的 OpenAI 兼容接口
- 对应模型的 API Key

## 环境变量

你可以在项目根目录创建 `.env` 文件，或者在 shell 里手动导出变量。

最少需要：

```bash
export OPENAI_API_KEY="你的 API Key"
export OPENAI_MODEL="你的文本模型"
export OPENAI_BASE_URL="你的 OpenAI 兼容接口地址"
```

当前这套项目已经验证过的豆包配置示例：

```bash
export OPENAI_API_KEY="ark-..."
export OPENAI_MODEL="doubao-seed-2-0-pro-260215"
export OPENAI_VISION_MODEL="doubao-seed-2-0-pro-260215"
export OPENAI_BASE_URL="https://ark.cn-beijing.volces.com/api/v3"
```

可选变量：

```bash
export OPENAI_VISION_MODEL="支持视觉输入的模型名"
export OPENAI_IMAGE_MODEL="支持出图的模型名"
export OPENAI_TRANSCRIPTION_MODEL="whisper-1"
export OPENAI_SYSTEM_PROMPT="自定义系统提示词"
export WEIXIN_BASE_URL="https://ilinkai.weixin.qq.com"
export WEIXIN_LOGIN_BASE_URL="https://ilinkai.weixin.qq.com"
export WEIXIN_APP_ID="bot"
export WEIXIN_APP_VERSION="0.1.0"
export STATE_DIR="./state"
export WEIXIN_POLL_TIMEOUT_MS="35000"
export OPENAI_TIMEOUT_MS="120000"
export ENABLE_VISION_INPUT="true"
export ENABLE_IMAGE_GENERATION="true"
export ENABLE_VOICE_TRANSCRIPTION="true"
```

## 启动方式

首次登录：

```bash
npm run login
```

启动桥接：

```bash
npm start
```

如果当前没有保存过微信账号，`npm start` 会自动进入扫码登录流程。

## 当前能力说明

### 1. 文本聊天

支持，已经可用。

### 2. 图片理解

支持，已经可用。

当前项目会先从微信 CDN 下载图片并做 AES 解密，再把图片内容发给支持视觉输入的模型。

### 3. 语音消息

当前会：

- 下载微信语音文件
- 解密语音内容
- 尝试把 `silk` 解码成 `wav`

如果你使用的模型后端提供 OpenAI 兼容的语音转写接口 `/audio/transcriptions`，项目会自动尝试转写。

注意：
当前你这条豆包 Ark 配置没有开放这个兼容转写端点，所以“自动语音转文字”这部分代码已经接好，但实际还不能完全跑通。

### 4. 图片生成并回微信

代码已经支持通过 OpenAI 兼容的 `images/generations` 接口出图，然后自动上传回微信。

注意：
这需要你配置一个真正支持出图的模型到 `OPENAI_IMAGE_MODEL`。如果当前模型不支持出图，项目会友好降级提示，而不会把底层接口报错直接发给微信用户。

### 5. 文件和视频

支持下载、解密和进一步理解。

当前策略：

- 文本类文件会优先提取正文文本
- PDF 会优先走原生 PDF 文本抽取
- 常见文档会尝试生成预览图
- 视频会尝试提取多张关键帧预览图
- 然后把这些内容一起交给支持视觉输入的模型理解

也就是说，现在已经不是“只把文件路径丢给模型”了，而是尽量做真正的文件/视频内容理解。

### 6. 长期记忆

支持，已经可用。

项目会自动从对话中提炼适合长期保存的信息，例如：

- 用户称呼
- 风格偏好
- 长期目标
- 正在做的项目
- 稳定要求

记忆会按微信用户分别保存，并在后续回复前自动检索注入。

记忆文件位置：

```bash
./state/memory
```

## 本地状态目录

所有本地状态默认保存在：

```bash
./state
```

这里面通常会包含：

- 微信账号状态
- 会话同步信息
- 上下文 token
- 长期记忆
- 下载下来的媒体文件

## 媒体回发格式

如果你希望模型把本地文件直接发回微信，需要让模型输出一行单独的：

```text
MEDIA:/绝对路径/到/文件.png
```

例如：

```text
给你做好啦，快接住～
MEDIA:/Users/yourname/output.png
```

注意：

- `MEDIA:` 必须单独占一行
- 必须使用绝对路径

## 已知限制

- 项目必须运行着，微信机器人才能在线回复
- 电脑断网时，既收不到新微信消息，也调不到模型接口
- 是否支持图片理解、语音转写、图片生成，最终取决于你接的模型后端和模型能力
- 当前豆包配置下，图片理解可用，但语音转写兼容端点和出图模型还需要额外开通或替换

## 后续可扩展方向

- 增加“查看记忆 / 删除记忆”命令
- 增加后台常驻或开机自启
- 增加更完善的语音转写链路
- 增加稳定的出图模型配置
