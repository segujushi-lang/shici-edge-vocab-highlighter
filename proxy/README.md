# Google 网页翻译个人反代

这是一个可选的自建服务。它调用 Google 网页翻译使用的未公开接口，不需要 Google API 密钥，但可用性和限流可能变化。服务不包含在插件运行过程中自动启动的内容，也未提供公共托管地址。用户自行承担网络、服务器和部署费用。

## 本地运行

需要 Node.js 20 或更新版本，无需安装依赖。在项目根目录运行：

```powershell
node proxy/server.mjs
```

插件的 Google 反代地址填写：`http://127.0.0.1:8787/translate`。浏览器和本地服务应在同一台电脑运行；关闭终端会停止服务。仅监听 `127.0.0.1`，不开放局域网或公网访问。

上游不可达时需要用户自己的网络代理；使用支持 `--use-env-proxy` 的 Node.js（本项目实测为 24.13.0），例如：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7897" # 改为你实际使用的代理地址
node --use-env-proxy proxy/server.mjs
```

这里的 `HTTPS_PROXY` 控制服务器如何访问 Google，不是插件设置中的反代地址；不要在两处填同一个含义不同的地址。

如果默认端口被占用，可通过 `SHICI_PROXY_PORT` 修改端口：

```powershell
$env:SHICI_PROXY_PORT = "8788"
node proxy/server.mjs
```

插件地址对应改为 `http://127.0.0.1:8788/translate`。需要网络代理时保留 `HTTPS_PROXY`，使用 `node --use-env-proxy proxy/server.mjs`。环境变量只影响当前终端；按 `Ctrl+C` 停止服务。

## 验收与插件设置

1. 打开 `http://127.0.0.1:8787/translate?q=run`；JSON 中 `sentences` 有中文 `trans` 即表明通路正常，有可用义项时还会有 `dict`。端口按自己的配置修改。
2. 更新扩展源码后，在 `edge://extensions/` 对“拾词”点击“重新加载”，再刷新网页。
3. 插件弹窗中填写 `http://127.0.0.1:8787/translate`，不要带测试查询参数 `?q=run`；点击“保存”并允许浏览器访问权限。
4. 开启“Google（实验）”，保存无手工释义的新词或主动刷新已有词条，查看 Google 来源标签。

来源默认关闭，保存和开启不会立即上传词库。关闭服务会阻止新的 Google 查询，插件已经保存的译文仍可查看。`502`／`504` 表示上游访问、响应或超时问题，先检查自己的网络和 JSON 错误信息；`429` 表示实例请求额度或并发已满，稍后重试。更完整的排查见[项目 README](../README.md#google-网页翻译反代可选)。

## Worker 自托管

`worker.mjs` 是标准 Worker 的 `fetch` 入口，`wrangler.toml` 提供部署配置。使用你自己的 Cloudflare 账号部署后，将插件地址设为 `https://你的服务域名/translate`。本项目不会自动创建账号、部署服务或开通付费项目。

自行决定使用这种方式后，在项目根目录运行以下命令（需要 Node.js、npm 与自己的 Cloudflare 账号）：

```powershell
npx wrangler login
npx wrangler deploy --config proxy/wrangler.toml
```

`npx` 首次可能请求下载 Wrangler。登录命令会打开账号授权流程，部署命令会将代码发布到你的账号；依据[官方登录说明](https://developers.cloudflare.com/workers/wrangler/commands/general/#login)和[部署说明](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)。部署完成后复制输出的 HTTPS 域名，补上 `/translate`，在插件中保存、授权并开启 Google；此方式不需要常驻本地服务。

当前仅实测本机 Node 反代与 Edge 查词链路，未替用户运行 Worker 部署。部署与网络、流量费用由用户承担。

示例没有用户 Token。公网部署时请自行添加平台层访问控制；CORS 不是鉴权。插件不发送 Cookie／Authorization、不跟随登录跳转，访问控制需兼容该方式。不要把无鉴权公共地址分享给不受信任的用户。免费托管额度是否够用取决于你选择的平台及实际请求量。

## 请求与限制

仅接受 `GET /translate?q=run` 和对应的 `OPTIONS` 预检；每次只允许一个不超过 64 字符的英文单词，可含词内连字符或英文撇号。固定查询英语到简体中文，返回 Google 原始 JSON，包含可用的句子译文和词典候选。

- 固定上游 `translate.googleapis.com`，不接受自定义上游、目标语言或任意 URL。
- 不转发客户的 Cookie、Authorization、网页地址或其他请求头。
- 上游 10 秒超时，JSON 响应最大 128 KiB，拒绝 HTML、无效 JSON 和上游重定向。
- 单个进程／Worker 实例最多同时 2 个上游请求、每分钟 30 个新查询。
- 同词请求合并，成功结果只在内存缓存 10 分钟，最多 256 个词；不落盘。HTTP 响应使用 `no-store`。

Worker 的内存缓存与限流按实例生效，不是全账号的持久化配额或公网防滥用方案。服务只接收待翻译单词，查询会发送给 Google；未添加服务器查询日志。插件自己的生词本存储行为仍按插件隐私说明执行。

## 验证

```powershell
node --test tests/google-proxy.test.js
```

测试使用模拟上游，不访问 Google，也不产生部署费用。
