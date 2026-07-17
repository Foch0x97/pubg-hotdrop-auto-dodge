// ==UserScript==
// @name         PUBG Paradrop 任务专用（VFoch）
// @namespace    VFoch Network
// @version      1.0.2
// @description  任务流程控制：开局受伤一次、关闭碰撞、自动拾取空投并按自定义分数结算
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
  if (pageWindow.VFochParadropTask) return;

  const STORAGE_PREFIX = 'vfoch-paradrop-task:';
  const SPEEDS = [0.5, 1, 2, 3, 5];
  const DEFAULT_FINISH_SCORE = 19500;
  const AUTO_PICKUP_SCORE = 300;
  const NORMAL_WALK_SPEED = 384;
  const PLAYER_TARGET_SMOOTHING = 0.2;

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
      if (typeof GM_setValue === 'function') GM_setValue(STORAGE_PREFIX + key, value);
      else pageWindow.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch {
      // Storage failure does not affect the active round.
    }
  }

  function validSpeed(value) {
    const speed = Number(value);
    return SPEEDS.includes(speed) ? speed : 1;
  }

  function validFinishScore(value) {
    const score = Math.round(Number(value));
    return Number.isFinite(score) && score >= 1 ? score : DEFAULT_FINISH_SCORE;
  }

  const labControl = pageWindow.__VFOCH_GAME_LAB__;
  const control = {
    collisionDisabled: true,
    speedMultiplier: validSpeed(labControl?.speedMultiplier ?? readSetting('speedMultiplier', 1)),
    autoFinishEnabled: Boolean(labControl?.autoFinishEnabled ?? readSetting('autoFinishEnabled', true)),
    autoFinishScore: validFinishScore(labControl?.autoFinishScore ?? readSetting('autoFinishScore', DEFAULT_FINISH_SCORE)),
    enginePatched: Boolean(labControl?.enginePatched),
  };

  const runtime = {
    scene: null,
    roundScene: null,
    phase: 'waiting',
    openingHealth: null,
    forcedHazard: null,
    pickupTarget: null,
    autoPickupAnnounced: false,
    autoFinishTriggered: false,
    panel: null,
    shadow: null,
    elements: null,
    originalPush: null,
    pushWrapper: null,
    originalSceneUpdate: null,
    wrappedSceneUpdate: null,
    sdkWrapped: false,
    lastTelemetryAt: 0,
  };

  function saveSettings() {
    writeSetting('speedMultiplier', control.speedMultiplier);
    writeSetting('autoFinishEnabled', control.autoFinishEnabled);
    writeSetting('autoFinishScore', control.autoFinishScore);
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

  function getItems(scene = runtime.scene) {
    const items = scene?.fallingItems?.getItems?.() ?? scene?.fallingItems?.items;
    return Array.isArray(items) ? items : [];
  }

  function getScore(scene = runtime.scene) {
    return Number(scene?.hud?.getScore?.() ?? 0);
  }

  function getHealth(scene = runtime.scene) {
    return Number(scene?.player?.getHealth?.() ?? scene?.player?.playerHealth ?? 0);
  }

  function getPlayerX(scene = runtime.scene) {
    return Number(scene?.player?.getX?.() ?? scene?.player?.sprite?.x ?? 0);
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
      // The opening hit must come from an NPC; a red-zone hit would end the round immediately.
      zoneDeps.ignorePlayerZoneHits = control.collisionDisabled || runtime.phase === 'opening-hit';
    }
  }

  function setCollisionDisabled(value, source = 'manual') {
    control.collisionDisabled = Boolean(value);
    if (source === 'manual') {
      runtime.phase = control.collisionDisabled ? 'protected' : 'manual-collision';
      runtime.forcedHazard = null;
    }
    applyCollisionMode();
    syncPanel();
  }

  function prepareRound(scene) {
    if (runtime.roundScene === scene && runtime.phase !== 'waiting') return;
    runtime.roundScene = scene;
    runtime.phase = 'opening-hit';
    runtime.openingHealth = getHealth(scene) || 3;
    runtime.forcedHazard = null;
    runtime.pickupTarget = null;
    runtime.autoPickupAnnounced = false;
    runtime.autoFinishTriggered = false;
    control.collisionDisabled = false;
    applyCollisionMode();
    console.info('[VFoch Paradrop Task] 回合开始：已开启 NPC 碰撞，等待损失 1 点生命');
    syncPanel();
  }

  function findOpeningHazard(scene) {
    const playerX = getPlayerX(scene);
    const hazards = getItems(scene).filter((item) => (
      item
      && item.kind === 'hazard'
      && item.go
      && (item.state === 'falling' || item.state === 'landing' || item.state === 'grounded')
    ));
    hazards.sort((a, b) => Math.abs(Number(a.go.x) - playerX) - Math.abs(Number(b.go.x) - playerX));
    return hazards[0] || null;
  }

  function updateOpeningHit(scene) {
    if (runtime.phase !== 'opening-hit') return;
    const health = getHealth(scene);
    if (health > 0 && health < runtime.openingHealth) {
      runtime.phase = 'protected';
      runtime.forcedHazard = null;
      control.collisionDisabled = true;
      applyCollisionMode();
      console.info(`[VFoch Paradrop Task] 已损失 1 点生命，碰撞已关闭；当前生命 ${health}`);
      syncPanel();
      return;
    }

    control.collisionDisabled = false;
    applyCollisionMode();
    const hazard = findOpeningHazard(scene);
    if (!hazard) return;
    runtime.forcedHazard = hazard;
    hazard.go.x = getPlayerX(scene);
  }

  function findPickupTarget(scene) {
    const playerX = getPlayerX(scene);
    const pickups = getItems(scene).filter((item) => (
      item
      && item.kind === 'collectible'
      && item.go
      && (item.state === 'falling' || item.state === 'landing' || item.state === 'grounded')
    ));
    pickups.sort((a, b) => Math.abs(Number(a.go.x) - playerX) - Math.abs(Number(b.go.x) - playerX));
    return pickups[0] || null;
  }

  function isActivePickup(scene, item) {
    return Boolean(
      item
      && item.kind === 'collectible'
      && item.go
      && (item.state === 'falling' || item.state === 'landing' || item.state === 'grounded')
      && getItems(scene).includes(item),
    );
  }

  function stopPickupWalk(scene) {
    if (scene?.player && Number.isFinite(getPlayerX(scene))) {
      scene.player.targetX = getPlayerX(scene);
    }
  }

  function updateAutoPickup(scene, rawDelta = 0) {
    const score = getScore(scene);
    if (score < AUTO_PICKUP_SCORE || scene.isGameOver || runtime.autoFinishTriggered) {
      runtime.pickupTarget = null;
      stopPickupWalk(scene);
      return;
    }
    if (!runtime.autoPickupAnnounced) {
      runtime.autoPickupAnnounced = true;
      console.info('[VFoch Paradrop Task] 分数达到 300，已启用角色自动拾取空投');
    }

    const target = isActivePickup(scene, runtime.pickupTarget)
      ? runtime.pickupTarget
      : findPickupTarget(scene);
    runtime.pickupTarget = target;
    if (!target) {
      stopPickupWalk(scene);
      return;
    }
    const width = Number(scene.scale?.width) || 1600;
    const targetX = Math.max(48, Math.min(width - 48, Number(target.go.x) || width / 2));
    const playerX = getPlayerX(scene);
    const distance = targetX - playerX;
    const delta = Math.max(0, Math.min(100, Number(rawDelta) || 0));

    // The game eases 20% toward targetX every update.  Keep only a small lead
    // based on the unscaled frame time, so pickup walking remains 1x even when
    // the round speed is set higher.
    if (delta <= 0 || Math.abs(distance) <= 1) {
      if (Math.abs(distance) <= 1) scene.player.targetX = targetX;
      return;
    }
    const normalStep = NORMAL_WALK_SPEED * (delta / 1000);
    const lead = Math.min(Math.abs(distance), normalStep / PLAYER_TARGET_SMOOTHING);
    scene.player.targetX = Math.max(48, Math.min(width - 48, playerX + Math.sign(distance) * lead));
  }

  function triggerAutoFinish(scene) {
    if (
      !control.autoFinishEnabled
      || runtime.autoFinishTriggered
      || scene.isGameOver
      || getScore(scene) < control.autoFinishScore
    ) return;

    runtime.autoFinishTriggered = true;
    runtime.phase = 'finishing';
    runtime.pickupTarget = null;
    control.collisionDisabled = false;
    applyCollisionMode();
    console.info(`[VFoch Paradrop Task] 达到 ${control.autoFinishScore} 分，已开启碰撞，等待自然触碰死亡`);
    syncPanel();
  }

  function runTaskCycle(rawDelta = 0) {
    const scene = runtime.scene;
    if (!isGameScene(scene)) return;
    prepareRound(scene);
    updateOpeningHit(scene);
    updateAutoPickup(scene, rawDelta);
    triggerAutoFinish(scene);
    applyCollisionMode();
  }

  function installSceneUpdate(scene) {
    const systems = scene?.sys;
    if (!systems || typeof systems.sceneUpdate !== 'function') return false;
    const current = systems.sceneUpdate;
    if (current.__vfochTaskWrapped) return true;

    runtime.originalSceneUpdate = current;
    runtime.wrappedSceneUpdate = function vfochTaskSceneUpdate(time, delta) {
      runTaskCycle(delta);
      const adjustedDelta = runtime.scene === scene && !control.enginePatched
        ? delta * control.speedMultiplier
        : delta;
      const result = Reflect.apply(current, this, [time, adjustedDelta]);
      runTaskCycle(0);
      return result;
    };
    Object.defineProperty(runtime.wrappedSceneUpdate, '__vfochTaskWrapped', { value: true });
    systems.sceneUpdate = runtime.wrappedSceneUpdate;
    return systems.sceneUpdate === runtime.wrappedSceneUpdate;
  }

  function applyGameSpeed() {
    const scene = runtime.scene;
    if (!isGameScene(scene)) return;
    installSceneUpdate(scene);
    if (control.enginePatched) return;
    if (scene.time) scene.time.timeScale = control.speedMultiplier;
    if (scene.tweens) scene.tweens.timeScale = control.speedMultiplier;
    if (scene.anims) scene.anims.globalTimeScale = control.speedMultiplier;
  }

  function restoreArrayPush() {
    const pageArray = pageWindow.Array;
    if (pageArray && runtime.pushWrapper && pageArray.prototype.push === runtime.pushWrapper) {
      pageArray.prototype.push = runtime.originalPush;
    }
    runtime.originalPush = null;
    runtime.pushWrapper = null;
  }

  function captureScene(scene) {
    if (!isGameScene(scene)) return false;
    runtime.scene = scene;
    restoreArrayPush();
    installSceneUpdate(scene);
    applyGameSpeed();
    prepareRound(scene);
    pageWindow.setTimeout(runTaskCycle, 0);
    pageWindow.setTimeout(runTaskCycle, 100);
    console.info('[VFoch Paradrop Task] 已捕获游戏场景', scene);
    return true;
  }

  function inspectPushedValue(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    try {
      return [
        value.go?.scene,
        value.scene,
        value.gameObject?.scene,
        value.parent?.scene,
      ].some((candidate) => captureScene(candidate));
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
    runtime.pushWrapper = function vfochTaskPushHook(...values) {
      const result = Reflect.apply(runtime.originalPush, this, values);
      if (!runtime.scene) values.some(inspectPushedValue);
      return result;
    };
    pageArray.prototype.push = runtime.pushWrapper;
    return true;
  }

  function clearSceneCapture() {
    runtime.scene = null;
    runtime.roundScene = null;
    runtime.phase = 'waiting';
    runtime.openingHealth = null;
    runtime.forcedHazard = null;
    runtime.pickupTarget = null;
    runtime.autoPickupAnnounced = false;
    runtime.autoFinishTriggered = false;
    installArrayPushHook();
    syncPanel();
  }

  function wrapSdkMethod(api, methodName) {
    const original = api?.[methodName];
    if (typeof original !== 'function' || original.__vfochTaskSdkWrapped) return Boolean(original);
    const wrapped = function vfochTaskSdkWrapper(...args) {
      clearSceneCapture();
      return Reflect.apply(original, this, args);
    };
    Object.defineProperty(wrapped, '__vfochTaskSdkWrapped', { value: true });
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
    const initWrapped = wrapSdkMethod(api, 'init');
    const roundWrapped = wrapSdkMethod(api, 'beginRound');
    runtime.sdkWrapped = initWrapped || roundWrapped;
    return runtime.sdkWrapped;
  }

  function phaseText() {
    switch (runtime.phase) {
      case 'opening-hit': return '等待开局受伤';
      case 'protected': return '碰撞保护中';
      case 'manual-collision': return '手动开启碰撞';
      case 'finishing': return '等待自然触碰死亡';
      default: return '等待游戏场景';
    }
  }

  function updateTelemetry(force = false) {
    if (!runtime.elements?.status) return;
    const now = Date.now();
    if (!force && now - runtime.lastTelemetryAt < 250) return;
    runtime.lastTelemetryAt = now;
    const scene = runtime.scene;
    if (!isGameScene(scene)) {
      runtime.elements.status.textContent = '等待游戏场景...';
      return;
    }
    const pickup = runtime.pickupTarget ? ' | 追踪空投' : '';
    runtime.elements.status.textContent = `分数 ${getScore(scene)} | 生命 ${getHealth(scene)} | ${phaseText()}${pickup}`;
  }

  function syncPanel() {
    const elements = runtime.elements;
    if (!elements) return;
    elements.collisionOff.dataset.active = String(control.collisionDisabled);
    elements.collisionOn.dataset.active = String(!control.collisionDisabled);
    elements.speed.value = String(control.speedMultiplier);
    elements.autoFinish.checked = control.autoFinishEnabled;
    if (document.activeElement !== elements.finishScore) {
      elements.finishScore.value = String(control.autoFinishScore);
    }
    updateTelemetry(true);
  }

  function makePanel() {
    if (runtime.panel || !document.documentElement) return;
    const host = document.createElement('div');
    host.id = 'vfoch-paradrop-task-panel';
    host.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;font-family:Arial,"Microsoft YaHei",sans-serif;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box;letter-spacing:0}
        .panel{width:min(430px,calc(100vw - 24px));padding:14px;border:1px solid #4b5563;border-radius:8px;background:rgba(17,20,24,.96);box-shadow:0 8px 28px rgba(0,0,0,.52);color:#f5f5f5;font-size:14px}
        h2{margin:0 0 10px;font-size:17px;line-height:1.25}
        .buttons{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
        .row{display:grid;grid-template-columns:86px 1fr;align-items:center;gap:10px;margin-top:9px}
        button,select,input[type="number"]{min-height:40px;border:1px solid #4b5563;border-radius:6px;background:#252c37;color:#f5f5f5;font:inherit}
        button{cursor:pointer;padding:0 8px}button[data-active="true"]{border-color:#36d780;background:#14532d}
        select,input[type="number"]{width:100%;padding:0 12px}
        .finish{display:grid;grid-template-columns:1fr auto;align-items:center;gap:10px}
        .toggle{display:flex;align-items:center;gap:6px;white-space:nowrap}
        .status{margin-top:11px;color:#86efac;line-height:1.4}
      </style>
      <section class="panel">
        <h2>PUBG 任务专用控制</h2>
        <div class="buttons">
          <button type="button" data-collision-off>关闭碰撞</button>
          <button type="button" data-collision-on>开启碰撞</button>
        </div>
        <label class="row"><span>运行速度</span><select data-speed>${SPEEDS.map((speed) => `<option value="${speed}">${speed}x</option>`).join('')}</select></label>
        <label class="row"><span>自动结算</span><span class="finish"><input type="number" min="1" max="1000000" step="100" inputmode="numeric" data-finish-score><span class="toggle"><input type="checkbox" data-auto-finish>启用</span></span></label>
        <div class="status" data-status>等待游戏场景...</div>
      </section>`;
    document.documentElement.appendChild(host);

    runtime.panel = host;
    runtime.shadow = shadow;
    runtime.elements = {
      collisionOff: shadow.querySelector('[data-collision-off]'),
      collisionOn: shadow.querySelector('[data-collision-on]'),
      speed: shadow.querySelector('[data-speed]'),
      finishScore: shadow.querySelector('[data-finish-score]'),
      autoFinish: shadow.querySelector('[data-auto-finish]'),
      status: shadow.querySelector('[data-status]'),
    };

    runtime.elements.collisionOff.addEventListener('click', () => setCollisionDisabled(true));
    runtime.elements.collisionOn.addEventListener('click', () => setCollisionDisabled(false));
    runtime.elements.speed.addEventListener('change', (event) => {
      control.speedMultiplier = validSpeed(event.target.value);
      saveSettings();
      applyGameSpeed();
      syncPanel();
    });
    runtime.elements.finishScore.addEventListener('change', (event) => {
      control.autoFinishScore = validFinishScore(event.target.value);
      runtime.autoFinishTriggered = false;
      saveSettings();
      syncPanel();
      runTaskCycle();
    });
    runtime.elements.autoFinish.addEventListener('change', (event) => {
      control.autoFinishEnabled = event.target.checked;
      runtime.autoFinishTriggered = false;
      saveSettings();
      syncPanel();
      runTaskCycle();
    });
    syncPanel();
  }

  pageWindow.VFochParadropTask = {
    control,
    runtime,
    apply: runTaskCycle,
    reset: clearSceneCapture,
    setCollisionDisabled,
    setSpeed(value) {
      control.speedMultiplier = validSpeed(value);
      saveSettings();
      applyGameSpeed();
      syncPanel();
    },
    setAutoFinishScore(value) {
      control.autoFinishScore = validFinishScore(value);
      runtime.autoFinishTriggered = false;
      saveSettings();
      syncPanel();
      runTaskCycle();
    },
  };

  installArrayPushHook();
  const monitorId = pageWindow.setInterval(() => {
    wrapParadropSdk();
    if (!isGameScene(runtime.scene)) {
      runtime.scene = null;
      if (!runtime.pushWrapper || pageWindow.Array?.prototype?.push !== runtime.pushWrapper) installArrayPushHook();
    } else {
      applyGameSpeed();
      runTaskCycle();
    }
    updateTelemetry();
  }, 250);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', makePanel, { once: true });
  else makePanel();

  pageWindow.addEventListener('pagehide', () => {
    pageWindow.clearInterval(monitorId);
    restoreArrayPush();
  }, { once: true });
})();
