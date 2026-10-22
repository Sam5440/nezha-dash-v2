> [!CAUTION]
> 有关项目问题与意见请移步https://github.com/hamster1963/nezha-dash
> 交流

> [!NOTE]
> 此项目为 nezha-dash 的官方实现，作为哪吒监控的默认前端，功能上可能与 nezha-dash 有所不同。
> https://github.com/hamster1963/nezha-dash

## 本地调整 UI

使用 Node.js >= 22、pnpm >= 11，在项目目录运行：

```bash
pnpm install
MOCK_NEZHA_COUNT=6 pnpm dev:mock
```

该命令同时启动本地 mock API（8008 端口）和 Vite，使用仓库 `.cert` 下的 HTTPS 证书。打开终端显示的地址（通常为 `https://localhost:5173`）；若浏览器提示本地证书不受信任，允许访问本地开发地址。

进入 `/server/1`，点击「在线 / Online」标签。在线历史支持 1／7／30 天切换、时间轴提示、在线／离线时段和「展开更多」。数据按当前时间生成，使用 `Asia/Shanghai` 时区；查询窗口是最近 N × 24 小时，因此每日列表通常会包含首尾两个不完整日期。

| 详情页 | 预览场景 |
| --- | --- |
| `/server/1`、`/server/6` | 正常在线，包含短暂掉线和跨日会话 |
| `/server/2` | 持续在线，在线率 100% |
| `/server/3` | 当前离线，包含进行中的离线时段 |
| `/server/4` | 无在线历史，在线率 0%，最后活跃显示 N/A |
| `/server/5` | 频繁掉线，用于查看密集时段标签和换行 |

主要样式位于 `src/components/ServerDetailOnlineHistory.tsx` 的 `className`，保存后自动热更新；桌面与手机布局的切换点是 768px。修改 mock 脚本后需重启 `pnpm dev:mock`，按 `Ctrl+C` 可停止前端和 mock 服务。

在线历史 mock 允许查询最多 30 天数据，无需真实后端或登录。不要同时运行占用 8008 端口的后端；省略 `MOCK_NEZHA_COUNT` 时仍使用原有的 3000 节点规模。
