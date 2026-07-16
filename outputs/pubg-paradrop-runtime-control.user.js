// ==UserScript==
// @name         PUBG Paradrop 运行时控制（VFoch）
// @namespace    VFoch Network
// @version      1.0.0
// @description  Phaser 运行时调试：碰撞、速度、空投/敌人落点和敌人方向
// @author       VFoch Network
// @match        https://pubg.com/*/events/hotsummerdrop*
// @match        https://www.pubg.com/*/events/hotsummerdrop*
// @grant        none
// @sandbox      raw
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  if (window.VFochParadropControl) return;

  const control = window.__VFOCH_GAME_LAB__ || {};
  control.collisionDisabled ??= true;
  control.speedMultiplier ??= 1;
  control.autoFinishScore ??= 19500;
  control.autoFinishEnabled ??= true;
  control.autoFinishTriggered ??= false;
  control.airdropPlacement ??= 'original';
  control.enemyPlacement ??= 'original';
  control.enemyDirection ??= 'original';
  control.enemyIndex ??= 0;
  window.__VFOCH_PARADROP_CONTROL__ = control;

  const runtime = {
    scene: null,
    panel: null,
    telemetry: null,
    summary: null,
    originalPush: null,
    pushWrapper: null,
    pushHooked: false,
    lastTelemetryAt: 0,
  };

  function isGameScene(scene) {
    return Boolean(
      scene
      && scene.player?.sprite
      && scene.fallingItems?.getItems
      && scene.redZones
      && scene.hud?.getScore,
    );
  }

  function resolveX(placement, defaultX, width, playerX) {
    const clamp = (value) => Math.max(50, Math.min(width - 50, value));
    switch (placement) {
      case 'player': return clamp(playerX);
      case 'left': return 70;
      case 'center': return width / 2;
      case 'right': return width - 70;
      case 'far': return playerX < width / 2 ? width - 70 : 70;
      case 'near': {
        const side = control.enemyIndex++ % 2 === 0 ? -1 : 1;
        return clamp(playerX + side * 150);
      }
      default: return defaultX;
    }
  }

  function resolveDirection(x, playerX) {
    const toward = playerX >= x ? 1 : -1;
    switch (control.enemyDirection) {
      case 'toward': return toward;
      case 'away': return -toward;
      case 'left': return -1;
      case 'right': return 1;
      default: return null;
    }
  }

  function patchScene(scene) {
    if (!isGameScene(scene) || scene.__vfochRuntimeControlPatched) return;
    scene.__vfochRuntimeControlPatched = true;

    // 本地实验引擎已经在 game.js 内处理这些参数。
    if (control.enginePatched) return;

    const player = scene.player;
    const redZones = scene.redZones;
    const fallingItems = scene.fallingItems;

    if (typeof player.takeNpcHit === 'function') {
      const original = player.takeNpcHit;
      player.takeNpcHit = function (...args) {
        return control.collisionDisabled ? true : original.apply(this, args);
      };
    }

    if (typeof redZones.canPlayerTakeZoneHit === 'function') {
      const original = redZones.canPlayerTakeZoneHit;
      redZones.canPlayerTakeZoneHit = function (...args) {
        return control.collisionDisabled ? false : original.apply(this, args);
      };
    }

    if (typeof fallingItems.spawnEnemy === 'function') {
      const original = fallingItems.spawnEnemy;
      fallingItems.spawnEnemy = function (defaultX, ...args) {
        const playerX = player.getX();
        const x = resolveX(control.enemyPlacement, defaultX, scene.scale.width, playerX);
        const before = this.getItems().length;
        const result = original.call(this, x, ...args);
        const item = this.getItems()[before];
        const direction = resolveDirection(x, playerX);
        if (item?.kind === 'hazard' && direction !== null) {
          item.walkDirection = direction;
          this.applyEnemyWalkFacing(item.go, direction);
          item.hitboxes = this.createFallingEnemyHitboxes(direction);
        }
        return result;
      };
    }

    if (typeof fallingItems.spawnAirdrop === 'function') {
      const original = fallingItems.spawnAirdrop;
      fallingItems.spawnAirdrop = function (defaultX, ...args) {
        const x = resolveX(
          control.airdropPlacement,
          defaultX,
          scene.scale.width,
          player.getX(),
        );
        return original.call(this, x, ...args);
      };
    }

    const originalSceneUpdate = scene.sys.sceneUpdate;
    scene.sys.sceneUpdate = function (time, delta) {
      const speed = Number.isFinite(control.speedMultiplier)
        ? Math.max(0.25, Math.min(5, control.speedMultiplier))
        : 1;
      scene.anims.globalTimeScale = speed;
      if (scene.time) scene.time.timeScale = speed;
      if (scene.tweens) scene.tweens.timeScale = speed;
      return originalSceneUpdate.call(this, time, delta * speed);
    };
  }

  function restoreArrayPush() {
    if (!runtime.pushHooked || !runtime.originalPush) return;
    const wrapper = runtime.pushWrapper;
    const original = runtime.originalPush;
    const restore = () => {
      if (Array.prototype.push === wrapper) Array.prototype.push = original;
    };
    restore();
    queueMicrotask(restore);
    runtime.pushHooked = false;
  }

  function captureScene(scene) {
    if (!isGameScene(scene)) return false;
    runtime.scene = scene;
    patchScene(scene);
    restoreArrayPush();
    console.info('[VFoch Paradrop Control] 已捕获游戏场景：', scene);
    return true;
  }

  function installArrayPushHook() {
    if (runtime.pushHooked || runtime.scene) return;
    runtime.originalPush = Array.prototype.push;
    runtime.pushWrapper = function (...args) {
      const result = runtime.originalPush.apply(this, args);
      if (!runtime.scene) {
        for (const value of args) {
          if (value?.kind === 'hazard' && value.go?.scene && captureScene(value.go.scene)) break;
        }
      }
      return result;
    };
    Array.prototype.push = runtime.pushWrapper;
    runtime.pushHooked = true;
  }

  function resetCapture() {
    runtime.scene = null;
    control.scene = null;
    control.autoFinishTriggered = false;
    installArrayPushHook();
    updateTelemetry(true);
  }

  function makePanel() {
    if (runtime.panel || !document.documentElement) return;
    const panel = document.createElement('section');
    panel.dataset.vfochRuntimeControl = '';
    panel.innerHTML = `
      <div style="font-weight:800;font-size:17px;color:#f5f5f5">Paradrop 运行时控制</div>
      <div class="vf-summary" style="margin-top:8px;color:#ffe7a3">正在捕获游戏场景…</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:11px">
        <button type="button" data-collision="off">关闭碰撞</button>
        <button type="button" data-collision="on">开启碰撞</button>
        <button type="button" data-recapture>重新捕获</button>
      </div>
      <label class="vf-row"><span>运行速度</span><select data-speed>
        <option value="0.5">0.5x</option><option value="1">1x</option>
        <option value="2">2x</option><option value="3">3x</option><option value="5">5x</option>
      </select></label>
      <div style="margin-top:5px;color:#fca5a5">加速可能不上报分数，正式成绩建议使用 1x。</div>
      <label class="vf-row"><span>自动结算</span><select data-finish>
        <option value="off">关闭</option><option value="18000">18000 分</option>
        <option value="19000">19000 分</option><option value="19500">19500 分</option>
      </select></label>
      <label class="vf-row"><span>空投落点</span><select data-airdrop>
        <option value="original">原始位置</option><option value="player">角色位置</option>
        <option value="far">远离角色</option><option value="left">左侧</option>
        <option value="center">中央</option><option value="right">右侧</option>
      </select></label>
      <label class="vf-row"><span>敌人落点</span><select data-enemy>
        <option value="original">原始位置</option><option value="near">角色两侧 150px</option>
        <option value="player">角色位置</option><option value="far">远离角色</option>
        <option value="left">左侧</option><option value="center">中央</option><option value="right">右侧</option>
      </select></label>
      <label class="vf-row"><span>敌人方向</span><select data-direction>
        <option value="original">原始方向</option><option value="toward">朝向角色</option>
        <option value="away">背离角色</option><option value="left">固定向左</option>
        <option value="right">固定向右</option>
      </select></label>
      <div class="vf-telemetry" style="margin-top:10px;color:#86efac;font-family:Consolas,monospace">等待游戏场景…</div>
    `;
    Object.assign(panel.style, {
      position: 'fixed', top: '12px', right: '12px', zIndex: '2147483647',
      width: 'min(500px, calc(100vw - 24px))', padding: '14px',
      border: '1px solid #4b5563', borderRadius: '9px',
      background: 'rgba(17,20,24,.96)', boxShadow: '0 8px 28px rgba(0,0,0,.52)',
      color: '#f5f5f5', font: '14px/1.45 "Microsoft YaHei", sans-serif', userSelect: 'none',
    });
    const style = document.createElement('style');
    style.textContent = `
      [data-vfoch-runtime-control] button,[data-vfoch-runtime-control] select{min-height:42px;border:1px solid #4b5563;border-radius:6px;background:#252c37;color:#f5f5f5;font:inherit}
      [data-vfoch-runtime-control] button{cursor:pointer;padding:0 8px}
      [data-vfoch-runtime-control] button.vf-active{border-color:#36d780;background:#14532d}
      [data-vfoch-runtime-control] .vf-row{display:grid;grid-template-columns:86px minmax(0,1fr);align-items:center;gap:8px;margin-top:8px;color:#d1d5db}
      [data-vfoch-runtime-control] select{width:100%;padding:0 12px}
    `;
    document.documentElement.append(style, panel);
    runtime.panel = panel;
    runtime.telemetry = panel.querySelector('.vf-telemetry');
    runtime.summary = panel.querySelector('.vf-summary');

    const speed = panel.querySelector('[data-speed]');
    const finish = panel.querySelector('[data-finish]');
    const airdrop = panel.querySelector('[data-airdrop]');
    const enemy = panel.querySelector('[data-enemy]');
    const direction = panel.querySelector('[data-direction]');
    speed.value = String(control.speedMultiplier);
    finish.value = control.autoFinishEnabled ? String(control.autoFinishScore) : 'off';
    airdrop.value = control.airdropPlacement;
    enemy.value = control.enemyPlacement;
    direction.value = control.enemyDirection;

    const syncCollision = () => {
      for (const button of panel.querySelectorAll('[data-collision]')) {
        button.classList.toggle(
          'vf-active',
          (button.dataset.collision === 'off') === control.collisionDisabled,
        );
      }
    };
    for (const button of panel.querySelectorAll('[data-collision]')) {
      button.addEventListener('click', () => {
        control.collisionDisabled = button.dataset.collision === 'off';
        syncCollision();
        updateTelemetry(true);
      });
    }
    speed.addEventListener('change', () => { control.speedMultiplier = Number(speed.value); });
    finish.addEventListener('change', () => {
      control.autoFinishEnabled = finish.value !== 'off';
      if (control.autoFinishEnabled) control.autoFinishScore = Number(finish.value);
      control.autoFinishTriggered = false;
    });
    airdrop.addEventListener('change', () => { control.airdropPlacement = airdrop.value; });
    enemy.addEventListener('change', () => { control.enemyPlacement = enemy.value; });
    direction.addEventListener('change', () => { control.enemyDirection = direction.value; });
    panel.querySelector('[data-recapture]').addEventListener('click', resetCapture);
    syncCollision();
  }

  function updateTelemetry(force = false) {
    if (!runtime.telemetry) return;
    const now = performance.now();
    if (!force && now - runtime.lastTelemetryAt < 250) return;
    runtime.lastTelemetryAt = now;
    const scene = runtime.scene;
    if (!isGameScene(scene)) {
      runtime.summary.textContent = '正在捕获游戏场景…';
      runtime.telemetry.textContent = '等待游戏场景…';
      return;
    }
    const score = Number(scene.hud.getScore?.() ?? 0);
    const health = Number(scene.player.getHealth?.() ?? scene.player.playerHealth ?? 0);
    const enemies = Number(scene.fallingItems.getActiveEnemyCount?.() ?? 0);
    runtime.summary.textContent = `碰撞${control.collisionDisabled ? '已关闭' : '已开启'}；速度 ${control.speedMultiplier}x；已捕获场景`;
    runtime.telemetry.textContent = `分数 ${score} | 生命 ${health} | 敌人 ${enemies}`;
    if (
      control.autoFinishEnabled
      && !control.autoFinishTriggered
      && score >= control.autoFinishScore
      && !scene.isGameOver
      && typeof scene.handleGameOver === 'function'
    ) {
      control.autoFinishTriggered = true;
      scene.handleGameOver('LEVEL6_TIME_UP');
    }
  }

  function update() {
    requestAnimationFrame(update);
    makePanel();
    if (!runtime.scene && isGameScene(control.scene)) captureScene(control.scene);
    updateTelemetry();
  }

  window.addEventListener('pagehide', restoreArrayPush);

  window.VFochParadropControl = {
    control,
    runtime,
    reset: resetCapture,
    setCollisionDisabled(value) { control.collisionDisabled = Boolean(value); },
    setSpeed(value) { control.speedMultiplier = Number(value); },
    setAutoFinishScore(value) {
      control.autoFinishScore = Number(value);
      control.autoFinishEnabled = Number.isFinite(control.autoFinishScore);
      control.autoFinishTriggered = false;
    },
  };

  installArrayPushHook();
  requestAnimationFrame(update);
})();
