// ==UserScript==
// @name         PUBG Paradrop 运行时控制（VFoch）
// @namespace    VFoch Network
// @version      1.1.0
// @description  Phaser 运行时调试：碰撞、速度、自动结算、空投/敌人落点和敌人方向
// @author       VFoch Network
// @match        https://pubg.com/*/events/hotsummerdrop*
// @match        https://www.pubg.com/*/events/hotsummerdrop*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (pageWindow.VFochParadropControl) return;

  const STORAGE_PREFIX = 'vfoch-paradrop-control:';
  const SPEEDS = [0.5, 1, 2, 3, 5];
  const FINISH_SCORES = [18000, 19000, 19500];
  const AIRDROP_PLACEMENTS = ['original', 'player', 'far', 'left', 'center', 'right'];
  const ENEMY_PLACEMENTS = ['original', 'near', 'player', 'far', 'left', 'center', 'right'];
  const ENEMY_DIRECTIONS = ['original', 'toward', 'away', 'left', 'right'];

  function readSetting(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(STORAGE_PREFIX + key, fallback);
      const value = pageWindow.localStorage.getItem(STORAGE_PREFIX + key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function writeSetting(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(STORAGE_PREFIX + key, value);
      } else {
        pageWindow.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
      }
    } catch {
      // Cross-origin frames may reject storage without affecting the current session.
    }
  }

  function validOption(value, options, fallback) {
    return options.includes(value) ? value : fallback;
  }

  const labControl = pageWindow.__VFOCH_GAME_LAB__;
  const control = labControl || {
    collisionDisabled: Boolean(readSetting('collisionDisabled', true)),
    speedMultiplier: validOption(Number(readSetting('speedMultiplier', 1)), SPEEDS, 1),
    autoFinishScore: validOption(Number(readSetting('autoFinishScore', 19500)), FINISH_SCORES, 19500),
    autoFinishEnabled: Boolean(readSetting('autoFinishEnabled', true)),
    airdropPlacement: validOption(readSetting('airdropPlacement', 'original'), AIRDROP_PLACEMENTS, 'original'),
    enemyPlacement: validOption(readSetting('enemyPlacement', 'original'), ENEMY_PLACEMENTS, 'original'),
    enemyDirection: validOption(readSetting('enemyDirection', 'original'), ENEMY_DIRECTIONS, 'original'),
    enemyIndex: 0,
    autoFinishTriggered: false,
  };
  control.collisionDisabled ??= true;
  control.speedMultiplier ??= 1;
  control.autoFinishScore ??= 19500;
  control.autoFinishEnabled ??= true;
  control.autoFinishTriggered ??= false;
  control.airdropPlacement ??= 'original';
  control.enemyPlacement ??= 'original';
  control.enemyDirection ??= 'original';
  control.enemyIndex ??= 0;
  pageWindow.__VFOCH_PARADROP_CONTROL__ = control;

  const runtime = {
    scene: null,
    panel: null,
    shadow: null,
    elements: null,
    originalPush: null,
    pushWrapper: null,
    pushHooked: false,
    sdkWrapped: false,
    lastTelemetryAt: 0,
  };

  const airdropOriginalX = new WeakMap();
  const airdropControlledX = new WeakMap();
  const enemyOriginalX = new WeakMap();
  const enemyControlledX = new WeakMap();
  const enemyOriginalDirection = new WeakMap();
  const enemyControlledDirection = new WeakMap();
  const enemyPreviousState = new WeakMap();

  function saveSettings() {
    writeSetting('collisionDisabled', control.collisionDisabled);
    writeSetting('speedMultiplier', control.speedMultiplier);
    writeSetting('autoFinishScore', control.autoFinishScore);
    writeSetting('autoFinishEnabled', control.autoFinishEnabled);
    writeSetting('airdropPlacement', control.airdropPlacement);
    writeSetting('enemyPlacement', control.enemyPlacement);
    writeSetting('enemyDirection', control.enemyDirection);
  }

  function isGameScene(scene) {
    try {
      return Boolean(
        scene
        && scene.player?.sprite
        && scene.fallingItems
        && (scene.fallingItems.getItems || Array.isArray(scene.fallingItems.items))
        && scene.redZones
        && scene.hud?.getScore,
      );
    } catch {
      return false;
    }
  }

  function getItems(scene) {
    const items = scene?.fallingItems?.getItems?.() ?? scene?.fallingItems?.items;
    return Array.isArray(items) ? items : [];
  }

  function sceneWidth() {
    return Number(runtime.scene?.scale?.width) || 1600;
  }

  function playerX() {
    return Number(runtime.scene?.player?.getX?.() ?? runtime.scene?.player?.sprite?.x) || sceneWidth() / 2;
  }

  function clampX(value, gameObject) {
    const width = sceneWidth();
    const halfWidth = Number(gameObject?.displayWidth) / 2 || 40;
    const margin = Math.min(width / 2, Math.max(50, halfWidth + 12));
    return Math.max(margin, Math.min(width - margin, value));
  }

  function targetXForPlacement(placement, gameObject, isEnemy) {
    const width = sceneWidth();
    const x = playerX();
    const margin = clampX(0, gameObject);
    switch (placement) {
      case 'player': return clampX(x, gameObject);
      case 'far': return x < width / 2 ? width - margin : margin;
      case 'left': return margin;
      case 'center': return width / 2;
      case 'right': return width - margin;
      case 'near': {
        const side = control.enemyIndex++ % 2 === 0 ? -1 : 1;
        return clampX(x + side * 150, gameObject);
      }
      default: return Number(gameObject?.x) || width / 2;
    }
  }

  function resolveEnemyDirection(item) {
    const toward = playerX() >= Number(item.go.x) ? 1 : -1;
    switch (control.enemyDirection) {
      case 'toward': return toward;
      case 'away': return -toward;
      case 'left': return -1;
      case 'right': return 1;
      default: return Number(item.walkDirection) === -1 ? -1 : 1;
    }
  }

  function applyCollisionMode() {
    const scene = runtime.scene;
    if (!isGameScene(scene)) return;
    const itemDeps = scene.fallingItems?.deps;
    const zoneDeps = scene.redZones?.deps;
    if (itemDeps && 'ignorePlayerItemCollisions' in itemDeps) {
      itemDeps.ignorePlayerItemCollisions = control.collisionDisabled;
    }
    if (zoneDeps && 'ignorePlayerZoneHits' in zoneDeps) {
      zoneDeps.ignorePlayerZoneHits = control.collisionDisabled;
    }
  }

  function applyAirdropPositions() {
    const scene = runtime.scene;
    if (!isGameScene(scene)) return;
    for (const item of getItems(scene)) {
      if (!item || item.kind !== 'collectible' || !item.go) continue;
      const active = item.state === 'falling' || item.state === 'landing';
      if (control.airdropPlacement === 'original') {
        if (airdropOriginalX.has(item) && active) item.go.x = airdropOriginalX.get(item);
        airdropOriginalX.delete(item);
        airdropControlledX.delete(item);
        continue;
      }
      if (!active) continue;
      if (!airdropOriginalX.has(item)) airdropOriginalX.set(item, item.go.x);
      const cached = airdropControlledX.get(item);
      if (!cached || cached.mode !== control.airdropPlacement) {
        airdropControlledX.set(item, {
          mode: control.airdropPlacement,
          x: targetXForPlacement(control.airdropPlacement, item.go, false),
        });
      }
      item.go.x = airdropControlledX.get(item).x;
    }
  }

  function applyEnemyDirection(item) {
    if (control.enemyDirection === 'original') {
      if (enemyOriginalDirection.has(item)) item.walkDirection = enemyOriginalDirection.get(item);
      enemyOriginalDirection.delete(item);
      enemyControlledDirection.delete(item);
    } else {
      if (!enemyOriginalDirection.has(item)) enemyOriginalDirection.set(item, item.walkDirection);
      const cached = enemyControlledDirection.get(item);
      if (!cached || cached.mode !== control.enemyDirection) {
        enemyControlledDirection.set(item, {
          mode: control.enemyDirection,
          value: resolveEnemyDirection(item),
        });
      }
      item.walkDirection = enemyControlledDirection.get(item).value;
    }

    if (typeof item.go.setFlipX === 'function') item.go.setFlipX(item.walkDirection === -1);
    else item.go.flipX = item.walkDirection === -1;

    const manager = runtime.scene?.fallingItems;
    if (
      item.state !== 'grounded'
      && typeof manager?.createFallingEnemyHitboxes === 'function'
    ) {
      item.hitboxes = manager.createFallingEnemyHitboxes(item.walkDirection);
    }
  }

  function applyEnemyControls(phase = 'instant') {
    const scene = runtime.scene;
    if (!isGameScene(scene)) return;
    for (const item of getItems(scene)) {
      if (!item || item.kind !== 'hazard' || !item.go) continue;
      applyEnemyDirection(item);

      const previousState = enemyPreviousState.get(item);
      const airborne = item.state === 'falling' || item.state === 'landing';
      const justLanded = item.state === 'grounded' && (previousState === 'falling' || previousState === 'landing');
      const lockDropX = airborne || justLanded;

      if (control.enemyPlacement === 'original') {
        if (enemyOriginalX.has(item) && lockDropX) item.go.x = enemyOriginalX.get(item);
        enemyOriginalX.delete(item);
        enemyControlledX.delete(item);
      } else if (lockDropX) {
        if (!enemyOriginalX.has(item)) enemyOriginalX.set(item, item.go.x);
        const cached = enemyControlledX.get(item);
        if (!cached || cached.mode !== control.enemyPlacement) {
          enemyControlledX.set(item, {
            mode: control.enemyPlacement,
            x: targetXForPlacement(control.enemyPlacement, item.go, true),
          });
        }
        item.go.x = enemyControlledX.get(item).x;
      }

      if (phase === 'after') enemyPreviousState.set(item, item.state);
    }
  }

  function installSceneUpdateSpeed(scene) {
    if (control.enginePatched) return true;
    const systems = scene?.sys;
    if (!systems || typeof systems.sceneUpdate !== 'function') return false;
    const current = systems.sceneUpdate;
    if (current.__vfochRuntimeWrapped) return true;

    const wrapped = function vfochRuntimeSceneUpdate(time, delta) {
      applyAirdropPositions();
      applyEnemyControls('before');
      const result = Reflect.apply(current, this, [time, delta * control.speedMultiplier]);
      applyAirdropPositions();
      applyEnemyControls('after');
      return result;
    };
    Object.defineProperty(wrapped, '__vfochRuntimeWrapped', { value: true });
    systems.sceneUpdate = wrapped;
    return systems.sceneUpdate === wrapped;
  }

  function applyGameSpeed() {
    const scene = runtime.scene;
    if (!isGameScene(scene) || control.enginePatched) return;
    installSceneUpdateSpeed(scene);
    if (scene.time) scene.time.timeScale = control.speedMultiplier;
    if (scene.tweens) scene.tweens.timeScale = control.speedMultiplier;
    if (scene.anims) scene.anims.globalTimeScale = control.speedMultiplier;
  }

  function maybeAutoFinish() {
    const scene = runtime.scene;
    if (!isGameScene(scene) || scene.isGameOver) return;
    const score = Number(scene.hud.getScore?.() ?? 0);
    if (
      control.autoFinishEnabled
      && !control.autoFinishTriggered
      && score >= control.autoFinishScore
      && typeof scene.handleGameOver === 'function'
    ) {
      control.autoFinishTriggered = true;
      scene.handleGameOver('LEVEL6_TIME_UP');
    }
  }

  function applyAllSettings(announce = false) {
    const scene = runtime.scene;
    if (!isGameScene(scene)) return false;
    try {
      applyCollisionMode();
      applyGameSpeed();
      applyAirdropPositions();
      applyEnemyControls('instant');
      maybeAutoFinish();
      if (announce) updateTelemetry(true);
      return true;
    } catch (error) {
      console.error('[VFoch Paradrop Control] 应用设置失败', error);
      return false;
    }
  }

  function restoreArrayPush() {
    const pageArray = pageWindow.Array;
    if (
      pageArray
      && runtime.pushWrapper
      && pageArray.prototype.push === runtime.pushWrapper
    ) {
      pageArray.prototype.push = runtime.originalPush;
    }
    runtime.originalPush = null;
    runtime.pushWrapper = null;
    runtime.pushHooked = false;
  }

  function captureScene(scene) {
    if (!isGameScene(scene)) return false;
    runtime.scene = scene;
    control.scene = scene;
    restoreArrayPush();
    applyAllSettings(true);
    pageWindow.setTimeout(() => applyAllSettings(false), 0);
    pageWindow.setTimeout(() => applyAllSettings(false), 100);
    console.info('[VFoch Paradrop Control] 已捕获游戏场景：', scene);
    return true;
  }

  function inspectPushedValue(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    try {
      const candidates = [
        value.go?.scene,
        value.scene,
        value.gameObject?.scene,
        value.parent?.scene,
      ];
      return candidates.some((candidate) => captureScene(candidate));
    } catch {
      return false;
    }
  }

  function installArrayPushHook() {
    if (isGameScene(runtime.scene)) return true;
    const pageArray = pageWindow.Array;
    if (!pageArray?.prototype?.push) return false;
    if (runtime.pushWrapper && pageArray.prototype.push === runtime.pushWrapper) return true;
    restoreArrayPush();
    runtime.originalPush = pageArray.prototype.push;
    runtime.pushWrapper = function vfochPushHook(...values) {
      const result = Reflect.apply(runtime.originalPush, this, values);
      if (!runtime.scene) values.some(inspectPushedValue);
      return result;
    };
    pageArray.prototype.push = runtime.pushWrapper;
    runtime.pushHooked = true;
    return true;
  }

  function wrapSdkMethod(api, methodName, clearSceneFirst) {
    const original = api?.[methodName];
    if (typeof original !== 'function' || original.__vfochRuntimeSdkWrapped) return Boolean(original);
    const wrapped = function vfochRuntimeSdkWrapper(...args) {
      if (clearSceneFirst) {
        runtime.scene = null;
        control.scene = null;
        control.autoFinishTriggered = false;
      }
      installArrayPushHook();
      return Reflect.apply(original, this, args);
    };
    Object.defineProperty(wrapped, '__vfochRuntimeSdkWrapped', { value: true });
    try {
      api[methodName] = wrapped;
      return api[methodName] === wrapped;
    } catch {
      return false;
    }
  }

  function wrapParadropSdk() {
    if (runtime.sdkWrapped) return true;
    const api = pageWindow.ParadropGame;
    if (!api || (typeof api !== 'object' && typeof api !== 'function')) return false;
    const wrapped = wrapSdkMethod(api, 'init', true);
    wrapSdkMethod(api, 'beginRound', false);
    runtime.sdkWrapped = wrapped;
    return wrapped;
  }

  function resetCapture() {
    runtime.scene = null;
    control.scene = null;
    control.autoFinishTriggered = false;
    runtime.sdkWrapped = false;
    installArrayPushHook();
    updateTelemetry(true);
  }

  function updateControl(key, value) {
    control[key] = value;
    if (key === 'autoFinishScore' || key === 'autoFinishEnabled') {
      control.autoFinishTriggered = false;
    }
    saveSettings();
    syncPanel();
    applyAllSettings(true);
  }

  function makePanel() {
    if (runtime.panel || !document.documentElement) return;
    const host = document.createElement('div');
    host.id = 'vfoch-paradrop-control-host';
    Object.assign(host.style, {
      position: 'fixed', top: '12px', right: '12px', zIndex: '2147483647',
    });
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{color-scheme:dark;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
        .panel{width:min(430px,calc(100vw - 24px));padding:14px;border:1px solid #4b5563;border-radius:8px;background:rgba(17,20,24,.96);box-shadow:0 8px 28px rgba(0,0,0,.52);color:#f5f5f5}
        h2{margin:0 0 8px;font-size:17px;letter-spacing:0}.summary{color:#ffe7a3;font-size:13px}.warning{margin-top:5px;color:#fca5a5;font-size:12px}
        .actions{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:11px}.row{display:grid;grid-template-columns:86px minmax(0,1fr);align-items:center;gap:8px;margin-top:8px;color:#d1d5db;font-size:13px}
        button,select{min-height:40px;border:1px solid #4b5563;border-radius:6px;background:#252c37;color:#f5f5f5;font:inherit}button{cursor:pointer;padding:0 8px}select{width:100%;padding:0 12px}button[data-active="true"]{border-color:#36d780;background:#14532d}
        .telemetry{margin-top:10px;color:#86efac;font:12px/1.4 Consolas,monospace}
      </style>
      <section class="panel">
        <h2>Paradrop 运行时控制</h2>
        <div class="summary">正在捕获游戏场景…</div>
        <div class="actions">
          <button type="button" data-collision="off">关闭碰撞</button>
          <button type="button" data-collision="on">开启碰撞</button>
          <button type="button" data-recapture>重新捕获</button>
        </div>
        <label class="row"><span>运行速度</span><select data-speed>
          <option value="0.5">0.5x</option><option value="1">1x</option><option value="2">2x</option><option value="3">3x</option><option value="5">5x</option>
        </select></label>
        <div class="warning">加速可能不上报分数，正式成绩建议使用 1x。</div>
        <label class="row"><span>自动结算</span><select data-finish>
          <option value="off">关闭</option><option value="18000">18000 分</option><option value="19000">19000 分</option><option value="19500">19500 分</option>
        </select></label>
        <label class="row"><span>空投落点</span><select data-airdrop>
          <option value="original">原始位置</option><option value="player">角色位置</option><option value="far">远离角色</option><option value="left">左侧</option><option value="center">中央</option><option value="right">右侧</option>
        </select></label>
        <label class="row"><span>敌人落点</span><select data-enemy>
          <option value="original">原始位置</option><option value="near">角色两侧 150px</option><option value="player">角色位置</option><option value="far">远离角色</option><option value="left">左侧</option><option value="center">中央</option><option value="right">右侧</option>
        </select></label>
        <label class="row"><span>敌人方向</span><select data-direction>
          <option value="original">原始方向</option><option value="toward">朝向角色</option><option value="away">背离角色</option><option value="left">固定向左</option><option value="right">固定向右</option>
        </select></label>
        <div class="telemetry">等待游戏场景…</div>
      </section>
    `;
    document.documentElement.appendChild(host);
    runtime.panel = host;
    runtime.shadow = shadow;
    runtime.elements = {
      summary: shadow.querySelector('.summary'), telemetry: shadow.querySelector('.telemetry'),
      speed: shadow.querySelector('[data-speed]'), finish: shadow.querySelector('[data-finish]'),
      airdrop: shadow.querySelector('[data-airdrop]'), enemy: shadow.querySelector('[data-enemy]'),
      direction: shadow.querySelector('[data-direction]'),
      collisionButtons: [...shadow.querySelectorAll('[data-collision]')],
    };

    for (const button of runtime.elements.collisionButtons) {
      button.addEventListener('click', () => updateControl('collisionDisabled', button.dataset.collision === 'off'));
    }
    shadow.querySelector('[data-recapture]').addEventListener('click', resetCapture);
    runtime.elements.speed.addEventListener('change', (event) => updateControl('speedMultiplier', Number(event.currentTarget.value)));
    runtime.elements.finish.addEventListener('change', (event) => {
      const value = event.currentTarget.value;
      control.autoFinishEnabled = value !== 'off';
      if (control.autoFinishEnabled) control.autoFinishScore = Number(value);
      control.autoFinishTriggered = false;
      saveSettings(); syncPanel(); applyAllSettings(true);
    });
    runtime.elements.airdrop.addEventListener('change', (event) => updateControl('airdropPlacement', event.currentTarget.value));
    runtime.elements.enemy.addEventListener('change', (event) => updateControl('enemyPlacement', event.currentTarget.value));
    runtime.elements.direction.addEventListener('change', (event) => updateControl('enemyDirection', event.currentTarget.value));
    syncPanel();
  }

  function syncPanel() {
    const elements = runtime.elements;
    if (!elements) return;
    elements.speed.value = String(control.speedMultiplier);
    if (
      control.autoFinishEnabled
      && ![...elements.finish.options].some((option) => option.value === String(control.autoFinishScore))
    ) {
      const option = document.createElement('option');
      option.value = String(control.autoFinishScore);
      option.textContent = `${control.autoFinishScore} 分`;
      elements.finish.appendChild(option);
    }
    elements.finish.value = control.autoFinishEnabled ? String(control.autoFinishScore) : 'off';
    elements.airdrop.value = control.airdropPlacement;
    elements.enemy.value = control.enemyPlacement;
    elements.direction.value = control.enemyDirection;
    for (const button of elements.collisionButtons) {
      button.dataset.active = String((button.dataset.collision === 'off') === control.collisionDisabled);
    }
  }

  function updateTelemetry(force = false) {
    if (!runtime.elements) return;
    const now = performance.now();
    if (!force && now - runtime.lastTelemetryAt < 250) return;
    runtime.lastTelemetryAt = now;
    const scene = runtime.scene;
    if (!isGameScene(scene)) {
      runtime.elements.summary.textContent = '正在捕获游戏场景…';
      runtime.elements.telemetry.textContent = '等待游戏场景…';
      return;
    }
    const score = Number(scene.hud.getScore?.() ?? 0);
    const health = Number(scene.player.getHealth?.() ?? scene.player.playerHealth ?? 0);
    const enemies = Number(scene.fallingItems.getActiveEnemyCount?.() ?? 0);
    runtime.elements.summary.textContent = `碰撞${control.collisionDisabled ? '已关闭' : '已开启'}；速度 ${control.speedMultiplier}x；已捕获场景`;
    runtime.elements.telemetry.textContent = `分数 ${score} | 生命 ${health} | 敌人 ${enemies}`;
    maybeAutoFinish();
  }

  pageWindow.VFochParadropControl = {
    control,
    runtime,
    reset: resetCapture,
    apply: applyAllSettings,
    setCollisionDisabled(value) { updateControl('collisionDisabled', Boolean(value)); },
    setSpeed(value) { updateControl('speedMultiplier', validOption(Number(value), SPEEDS, 1)); },
    setAutoFinishScore(value) {
      const score = Number(value);
      control.autoFinishEnabled = FINISH_SCORES.includes(score);
      if (control.autoFinishEnabled) control.autoFinishScore = score;
      control.autoFinishTriggered = false;
      saveSettings(); syncPanel();
    },
    setAirdropPlacement(value) { updateControl('airdropPlacement', validOption(value, AIRDROP_PLACEMENTS, 'original')); },
    setEnemyPlacement(value) { updateControl('enemyPlacement', validOption(value, ENEMY_PLACEMENTS, 'original')); },
    setEnemyDirection(value) { updateControl('enemyDirection', validOption(value, ENEMY_DIRECTIONS, 'original')); },
  };

  installArrayPushHook();
  const monitorId = pageWindow.setInterval(() => {
    wrapParadropSdk();
    if (!runtime.scene && isGameScene(control.scene)) captureScene(control.scene);
    if (!isGameScene(runtime.scene)) {
      runtime.scene = null;
      if (!runtime.pushWrapper || pageWindow.Array?.prototype?.push !== runtime.pushWrapper) installArrayPushHook();
    } else {
      applyAllSettings(false);
    }
    updateTelemetry();
  }, 500);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', makePanel, { once: true });
  else makePanel();

  pageWindow.addEventListener('pagehide', () => {
    pageWindow.clearInterval(monitorId);
    restoreArrayPush();
  }, { once: true });
})();
