# PUBG Hotdrop Auto Dodge

VFoch Network 为 PUBG Hot Summer Drop 活动小游戏编写的三套独立脚本：MPC 自动躲避、Phaser 运行时控制与任务专用版。

## 脚本区别

| 文件 | 用途 | 默认行为 |
| --- | --- | --- |
| [`pubg-hotdrop-auto-dodge.user.js`](./outputs/pubg-hotdrop-auto-dodge.user.js) | MPC 自动躲避 | 预测 NPC、跳跃轨迹和红区，自动移动；不修改碰撞、速度或生成参数 |
| [`pubg-paradrop-runtime-control.user.js`](./outputs/pubg-paradrop-runtime-control.user.js) | Phaser 运行时控制 | 关闭碰撞、`1x` 速度、`19500` 分自动结算；可修改空投/敌人落点和敌人方向 |
| [`pubg-paradrop-task-runner.user.js`](./outputs/pubg-paradrop-task-runner.user.js) | 任务专用 | 当前版；固定 `1x`，开局自动承受一次 NPC 伤害后关闭碰撞；`300` 分后以正常走路速度追踪空投；按手动输入的分数结算 |
| [`pubg-paradrop-task-runner-accelerated-1.0.3.user.js`](./outputs/pubg-paradrop-task-runner-accelerated-1.0.3.user.js) | 任务专用备用 | `1.0.3`；空投拾取随运行倍率加速，仅在需要快速拾取时使用 |

这是三个独立方案，不是整合脚本。根据需要选择其中一种，不要同时启用多个版本。

## 安装

1. Chrome 或 Edge 安装 Tampermonkey。
2. 在 Tampermonkey 中新建脚本。
3. 选择上述一个 `.user.js` 文件，粘贴并保存。
4. 打开 <https://pubg.com/zh-cn/events/hotsummerdrop>，登录并进入小游戏。

也可在 Chrome DevTools 的 `Sources -> Snippets` 中直接运行脚本内容。

## MPC 自动躲避

- 同时模拟保持、左右移动、移动后停止和移动后反向等控制序列。
- 每 `80ms` 重规划一次，空投不参与路线选择，生存优先。
- 预判下落 NPC、落地行走方向、角色一段跳和独立二段跳。
- 红区撤离拥有最高优先级，撤离时禁止跳跃并保留水平速度。
- `F8`：开启或暂停自动躲避。
- `F9`：重新捕获 Phaser 场景。

## 运行时控制

- 正式成绩使用 `1x`；加速可能导致成绩不上报。
- 分数超过 `20000` 也可能不上报，因此默认在 `19500` 分自动结算。
- 碰撞：通过游戏内置的 NPC/红区忽略标志关闭或恢复伤害。
- 速度：`0.5x`、`1x`、`2x`、`3x`、`5x`。
- 自动结算：关闭、`18000`、`19000`、`19500` 分。
- 空投落点：原始、角色位置、远离角色、左侧、中央、右侧。
- 敌人落点：原始、角色两侧 `150px`、角色位置、远离角色、左侧、中央、右侧。
- 敌人方向：原始、朝向角色、背离角色、固定向左、固定向右。
- 空投在原游戏中没有水平移动方向，因此只提供落点控制。
- 位置和方向修改前会保存原值，切回“原始”时恢复。
- 设置通过 Tampermonkey 存储或 `localStorage` 持久化。
- 场景捕获同时监控物品生成和游戏 SDK，场景重建后会自动重新捕获。
- 控制面板使用 Shadow DOM，不受活动页面样式影响。

## 任务专用

- 面板只提供碰撞开关、运行速度和自动结算设置。
- 每局开始时自动开启 NPC 碰撞，并把首个 NPC 引导到角色位置。
- 生命从 `3` 降至 `2` 后立即关闭 NPC 与红区碰撞。
- 开局等待 NPC 伤害期间单独屏蔽红区致命伤，避免尚未扣血就直接结束。
- 分数达到 `300` 后，角色自动移动到当前最近的空投位置，拾取 `+100` 分空投。
- 自动结算分数使用数字输入框，默认 `19500`，可手动输入任意正整数。
- 达到结算分数后只恢复 NPC 与红区碰撞，不直接调用死亡或结算。
- 恢复碰撞后继续正常运行，等待 NPC 或轰炸区真实触碰造成死亡，再由游戏自然结算。
- 正式任务建议保持 `1x`；加速仍可能导致成绩不上报。

## 本地实验

本地实验版不消耗活动次数，也不提交官方成绩：

```cmd
python -m http.server 8765
```

- 普通模式：<http://127.0.0.1:8765/outputs/vfoch-paradrop-lab.html>
- 对抗模式：<http://127.0.0.1:8765/outputs/vfoch-paradrop-lab.html?mode=adversarial>
- 无碰撞 `1x`：<http://127.0.0.1:8765/outputs/vfoch-paradrop-lab.html?mode=invincible&speed=1>
- 任务专用版：<http://127.0.0.1:8765/outputs/vfoch-paradrop-lab.html?controller=task&mode=normal&speed=1&finish=off>

本地修改版引擎为 [`paradrop-game.lab.js`](./outputs/paradrop-game.lab.js)。

## 文件

```text
outputs/
  pubg-hotdrop-auto-dodge.user.js
  pubg-paradrop-runtime-control.user.js
  pubg-paradrop-task-runner.user.js
  vfoch-paradrop-lab.html
  paradrop-game.lab.js
  使用说明.txt
```
