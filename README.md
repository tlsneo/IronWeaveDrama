# IronWeaveDrama

AI 短剧制作系统。

## 当前进度

剧集库与短剧项目创建。

- 中文主页与空状态，支持窄屏布局。
- 默认跟随系统浅色／暗黑模式；右上角按钮可手动切换，浏览器会记住选择。
- 一个项目代表一整部短剧，不是单独一集。
- 点击“创建短剧”填写名称、画面风格（40 个预设，也可自由填写）和画面比例（9:16、16:9、21:9、4:3、3:4、1:1）。
- 画风预设涵盖写实影视、动漫卡通、中国风、国漫现言、绘画艺术、幻想科幻及数字现代风格。
- 创建后显示项目卡片，数据保存在 `data/drama.sqlite`，刷新或重启后仍保留。
- 尚未接入项目详情、角色管理或 AI 服务。

## 本地运行

需要 Node.js 22.13 或更新版本（使用内置 SQLite）。当前没有第三方依赖，无需 `npm install`。

```bash
npm start
```

远程开发时打开 `http://服务器IP:3000`；在服务器本机也可以打开 <http://127.0.0.1:3000>。按 `Ctrl+C` 停止。

端口被占用时：

```bash
PORT=3001 npm start
```

服务默认监听 `0.0.0.0`，允许远程访问。需要在防火墙或云服务器安全组中放行对应端口；当前没有登录鉴权，可访问服务的人都能查看和创建项目；开发时请仅允许可信 IP 访问，不要直接向所有公网用户开放。

## 开发与检查

```bash
npm run dev
npm test
```

开发模式自动重启修改后的 JavaScript；修改 HTML、CSS 或浏览器脚本后，需要重启服务。

## 目录

```text
src/
  server.js       启动本地服务
  app.js          页面、静态资源与项目创建路由
  database.js     SQLite 项目存储
views/
  index.html      剧集库主页与创建弹窗
  library-empty.html  空状态
public/
  styles.css      页面样式
  theme.js        主题切换与偏好保存
  projects.js     项目创建交互
test/
  app.test.js     HTTP 与主页冒烟测试
  theme.test.js   主题切换逻辑测试
  projects.test.js  项目校验与持久保存测试
  projects-ui.test.js  弹窗提交交互测试
  database.test.js  数据库升级与回滚测试
```

`data/` 不纳入 Git。请保留并备份该目录，删除它会丢失已保存的项目。

下一步：项目资源库与基础角色管理。
