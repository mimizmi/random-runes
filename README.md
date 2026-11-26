# Random Runes · 随机符文

英雄联盟主播直播用的随机符文 / 装备抽取与 B 站弹幕互动工具，基于 Electron。

[![Release](https://img.shields.io/github/v/release/mimizmi/random-runes?label=latest)](https://github.com/mimizmi/random-runes/releases/latest)
[![Build](https://github.com/mimizmi/random-runes/actions/workflows/release.yml/badge.svg)](https://github.com/mimizmi/random-runes/actions/workflows/release.yml)

- 下载最新版：<https://github.com/mimizmi/random-runes/releases/latest>
- 问题反馈：<https://github.com/mimizmi/random-runes/issues>

## 功能

- 官方符文 / 随机装备生成，一键应用到英雄联盟客户端
- B 站直播间弹幕连接、弹幕投票、抽奖联动
- B 站扫码登录（确认后自动写入 Cookie）
- 房间号锁定、投票时长、Cookie 本地保存

## 下载与安装

1. 打开 [Releases](https://github.com/mimizmi/random-runes/releases/latest)。
2. 下载最新的 `random-runes-*-win.zip`。
3. **解压到普通文件夹后再运行**（不要在压缩包预览窗口里直接双击）。
4. 双击 `random-runes.exe`，在 UAC 提示中允许管理员权限。

> 程序目前没有代码签名。Windows SmartScreen 提示“已保护你的电脑”时，点“更多信息 → 仍要运行”。

## 使用

1. 先启动英雄联盟客户端并登录。
2. 在“官方符文生成 / 随机装备生成”页生成方案，点“一键应用”。
3. 在“弹幕互动”页填写直播间房间号，点击“连接”。
4. 需要登录态时点击“扫码登录”，用 B 站 App 扫码并在手机上确认；二维码过期可点弹窗里的“刷新二维码”。

## 更新版本

- 打开 Releases 下载新版 zip，解压后覆盖旧目录即可；本地配置保存在系统用户目录，不随覆盖丢失。
- 每次发布由 GitHub Actions 自动构建，版本号与 `package.json`、Git tag 保持一致。

### 自动更新

从 `v7.1.0` 开始，打包版内置自动更新：

- 启动约 5 秒后自动检查一次 GitHub Releases，之后每 6 小时检查一次。
- 侧边栏版本号旁出现小圆点、右下角出现“发现新版本”提示。
- 点“一键更新”后：下载 zip → 校验 SHA256 → 关闭应用 → 自动替换安装目录文件 → 重启。
- 用户数据（Cookie、房间号、配置）在 `%APPDATA%\random-runes`，更新不会清除。
- 更新失败会弹窗提示；详细日志在 `%TEMP%\random-runes-update.log`，也可以到 Releases 手动下载。

> `v7.0.0` 还没有内置更新器，需要先手动下载一次 `v7.1.0`（或更新版本），之后才能使用一键更新。
>
> 自动更新会替换安装目录里的程序文件，请把程序放在当前用户有写权限的目录中（不要放在只读目录）。

## 开发

```powershell
npm install
npm start
```

只检查主进程语法：

```powershell
npm run check
```

## 打包

```powershell
.\pack.ps1
```

产物在 `dist\win-unpacked\`。

> `pack.ps1` 会在打包后把产物复制到同盘的普通目录再移回，用来清除 Codex/沙箱工作区可能带上的“低完整性级别（Low）”标签。带有该标签的 exe 在启动时会被 Electron 沙箱判定为低完整性而闪退（`0x80000003`）。

如果只需要目录形式：

```powershell
npm run pack
```

生成用于分发的 zip（zip 用于发给别人；本地直接运行仍建议用 `pack.ps1` 产出的目录）：

```powershell
npm run dist
```

## 发布新版本

```powershell
# 1. 升级版本号（会自动提交并打 tag）
npm version patch   # 或 minor / major

# 2. 推送提交和 tag
git push origin main --follow-tags
```

推送 `v*` tag 后，[release.yml](.github/workflows/release.yml) 会在 `windows-latest` 上自动：

1. `npm ci`
2. `electron-builder --win zip`
3. 创建 GitHub Release 并上传 zip

也可以在 Actions 页面手动触发一次构建（只上传 artifact，不创建 Release）。

## 目录结构

```text
main.js                 Electron 主进程（窗口、LCU、B 站弹幕、扫码登录）
updater.js              自动检查更新、下载校验与安装助手
preload.js              contextBridge 暴露给渲染进程的 API
index.html              界面与渲染进程逻辑
build/icon.ico          应用图标
pack.ps1                Windows 打包脚本（含完整性标签修复）
.github/workflows/      GitHub Actions 自动发布
```

## 免责声明

本项目仅用于个人直播娱乐，与 Riot Games、哔哩哔哩无关联。使用本工具产生的任何后果由使用者自行承担。
