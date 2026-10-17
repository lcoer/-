# 管理员离线激活码工具

此工具与用户软件分开，不需要服务器。客户端不需要 Node.js。激活码只用于离线授权，首次成功输入后默认 7 天有效，不绑定机器，无法阻止跨机器复用或通过清空、篡改本地记录重新计时。

## 首次初始化（管理员 / 开发者）

在项目根目录运行 `node offline-license-tool/setup.cjs`（Node.js 24）。它创建 `offline-license-tool/private/private-key.pem`、`public-key.pem`，只把公钥写入 `electron/license-config.json`。命令只输出文件路径，不输出密钥。然后重新构建客户端安装包，让安装包包含这把公钥。

再次运行不会替换已有密钥。若私钥遗失，请从备份恢复；工具会拒绝用新私钥替换客户端既有公钥。旧私钥丢失后无法给旧客户端生成新码；换新公钥必须重新发布客户端。请妥善离线备份私钥，Windows 上限制 private 目录的访问权限。不要把私钥、private 目录、生成器或包含私钥的备份交给普通用户。private 目录和 codes 文本均已忽略 Git。

## 浏览器生成（不需要 Node.js）

用新版 Edge 或 Chrome 打开 `generator.html`。点击选择 `private-key.pem`，设定激活后有效天数（默认 7，允许 1–3650）和数量（1–100），点击“生成激活码”。复制结果或下载 `codes.txt`，将单个完整激活码交给用户。不要修改、截断或换行拆分一个码。

网页不联网、不使用 localStorage，私钥仅作为当前页面签名的输入保存在内存。可以点击“清空私钥和结果”，或关闭页面清除页面状态。若浏览器不支持本地 WebCrypto Ed25519，请更新浏览器或使用下面的 CLI。私钥保密依赖管理员电脑和浏览器环境安全。

## 命令行生成（仅管理员需要 Node.js）

`node offline-license-tool/generate.cjs --days 7 --count 10 --out offline-license-tool/codes.txt`

可用 `--key 私钥路径` 选择备份私钥。不指定 `--out` 时直接输出激活码；文件输出拒绝覆盖已有文件，避免误删历史发码记录。

格式：`SYBL1.<base64url UTF8 JSON>.<Ed25519 signature>`。JSON 为 `{version:1,productId:"shuangyu-assistant",id:UUID,durationDays:7,issuedAt:Unix毫秒}`；签名针对原始 JSON UTF8 字节。`issuedAt` 是生成时间，有效期从客户端首次接受此码开始计算。
