// ==UserScript==
// @name         PUBG 热点空投小游戏 - 自动躲避（VFoch）
// @namespace    VFoch Network
// @version      4.0.1
// @description  纯生存模式：读取 Phaser 游戏对象，预测 NPC 和红区，自动移动与跳跃
// @author       VFoch Network
// @match        https://pubg.com/*/events/hotsummerdrop*
// @match        https://www.pubg.com/*/events/hotsummerdrop*
// @grant        none
// @sandbox      raw
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    enabled: true,
    debugOverlay: false,
    candidateStep: 40,
    edgeMargin: 52,
    directionDeadZone: 6,
    targetReplanMs: 80,
    targetHoldMs: 120,
    targetSwitchPenalty: 650,
    jumpCooldownMs: 150,
    jumpPredictionSeconds: 1.48,
    jumpPredictionStepSeconds: 1 / 60,
    predictionSeconds: 1.7,
    redZoneSafetyMargin: 38,
    collisionMargin: 4,
    closePassDistance: 46,
    preferredEdgeBuffer: 230,
    edgeMobilityPenalty: 0.28,
  };

  const PHYSICS = {
    playerHalfWidth: 40,
    playerGroundSpeed: 384,
    playerAirSpeedScale: 0.8,
    playerFollowPerFrame: 0.2,
    enemyWalkSpeed: 120,
    enemyLandingSeconds: 0.75,
    groundJumpVelocity: -860,
    airJumpVelocity: -720,
    risingGravity: 2600,
    fallingGravity: 4000,
  };

  const CONTROL_PLANS = [
    { label: 'hold', first: 0, second: 0, switchAt: Infinity },
    { label: 'left', first: -1, second: -1, switchAt: Infinity },
    { label: 'right', first: 1, second: 1, switchAt: Infinity },
  ];
  for (const direction of [-1, 1]) {
    for (const switchAt of [0.2, 0.35, 0.5, 0.7]) {
      CONTROL_PLANS.push({
        label: `${direction < 0 ? 'left' : 'right'}-stop-${switchAt}`,
        first: direction,
        second: 0,
        switchAt,
      });
    }
    for (const switchAt of [0.25, 0.45, 0.65]) {
      CONTROL_PLANS.push({
        label: `${direction < 0 ? 'left' : 'right'}-reverse-${switchAt}`,
        first: direction,
        second: -direction,
        switchAt,
      });
    }
  }

  const runtime = {
    scene: null,
    enabled: CONFIG.enabled,
    originalPush: null,
    pushWrapper: null,
    pushHooked: false,
    targetX: 800,
    targetRisk: 0,
    currentRisk: 0,
    lastPlanAt: 0,
    lastTargetAt: 0,
    cachedTarget: null,
    currentDirection: 0,
    lastJumpAt: 0,
    lastJumpLabel: '',
    lastJumpLabelUntil: 0,
    lastGameOverSummary: '',
    evacuatingRedZone: false,
    redZoneTarget: null,
    redZoneSignature: '',
    panel: null,
    status: null,
    overlay: null,
    overlayCtx: null,
  };

  const LEVELS = [
    { min: 0, max: 300, speed: 1 },
    { min: 301, max: 1500, speed: 1.2 },
    { min: 1501, max: 5000, speed: 1.6 },
    { min: 5001, max: 9000, speed: 2 },
    { min: 9001, max: 20000, speed: 2.4 },
    { min: 20001, max: Infinity, speed: 2.4 },
  ];

  function makePanel() {
    if (runtime.panel || !document.documentElement) return;
    const panel = document.createElement('div');
    panel.innerHTML = `
      <div style="font-weight:800;color:#ffd138">VFoch Auto Dodge 4.0 MPC 生存模式</div>
      <div class="vf-status" style="margin-top:4px;color:#80d8ff">等待小游戏运行时…</div>
      <div style="margin-top:5px;color:#aaa">F8 开关　F9 重新捕获</div>
    `;
    Object.assign(panel.style, {
      position: 'fixed',
      top: '12px',
      left: '12px',
      zIndex: '2147483647',
      padding: '9px 11px',
      border: '1px solid rgba(255,209,56,.75)',
      borderRadius: '7px',
      background: 'rgba(8,8,8,.86)',
      boxShadow: '0 3px 18px rgba(0,0,0,.5)',
      font: '12px/1.4 Consolas, "Microsoft YaHei", sans-serif',
      pointerEvents: 'none',
      userSelect: 'none',
    });
    document.documentElement.appendChild(panel);
    runtime.panel = panel;
    runtime.status = panel.querySelector('.vf-status');
  }

  function setStatus(text, color = '#e8e8e8') {
    if (!runtime.status) return;
    runtime.status.textContent = text;
    runtime.status.style.color = color;
  }

  function isGameScene(scene) {
    return Boolean(
      scene
      && scene.player?.sprite
      && scene.fallingItems?.getItems
      && scene.redZones
      && scene.hud?.getScore,
    );
  }

  function captureSceneFromItem(item) {
    const scene = item?.go?.scene;
    if (!isGameScene(scene)) return false;
    runtime.scene = scene;
    runtime.targetX = scene.player.sprite.x;
    restoreArrayPush();
    setStatus('已捕获 Phaser 游戏对象', '#7CFC98');
    console.info('[VFoch Auto Dodge] 已捕获游戏场景：', scene);
    return true;
  }

  function installArrayPushHook() {
    if (runtime.pushHooked) return;
    runtime.originalPush = Array.prototype.push;
    runtime.pushWrapper = function (...args) {
      const result = runtime.originalPush.apply(this, args);
      if (!runtime.scene) {
        for (const value of args) {
          if (
            value
            && value.kind === 'hazard'
            && value.go
            && captureSceneFromItem(value)
          ) {
            break;
          }
        }
      }
      return result;
    };
    Array.prototype.push = runtime.pushWrapper;
    runtime.pushHooked = true;
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

  function getCanvas() {
    const sceneCanvas = runtime.scene?.game?.canvas;
    if (sceneCanvas?.isConnected) return sceneCanvas;
    let best = null;
    let bestArea = 0;
    for (const canvas of document.querySelectorAll('.paradrop-game-root canvas, #game-container canvas')) {
      const rect = canvas.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        best = canvas;
        bestArea = area;
      }
    }
    return best;
  }

  function createOrUpdateOverlay() {
    if (!CONFIG.debugOverlay) return null;
    const canvas = getCanvas();
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();

    if (!runtime.overlay) {
      runtime.overlay = document.createElement('canvas');
      Object.assign(runtime.overlay.style, {
        position: 'fixed',
        zIndex: '2147483645',
        pointerEvents: 'none',
      });
      document.documentElement.appendChild(runtime.overlay);
      runtime.overlayCtx = runtime.overlay.getContext('2d');
    }

    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * pixelRatio));
    const height = Math.max(1, Math.round(rect.height * pixelRatio));
    if (runtime.overlay.width !== width) runtime.overlay.width = width;
    if (runtime.overlay.height !== height) runtime.overlay.height = height;
    Object.assign(runtime.overlay.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    return runtime.overlayCtx;
  }

  function clearOverlay() {
    runtime.overlayCtx?.clearRect(0, 0, runtime.overlay.width, runtime.overlay.height);
  }

  function getScore(scene) {
    return Number(scene.hud?.getScore?.() ?? 0);
  }

  function getSpeedMultiplier(score) {
    const index = LEVELS.findIndex((level) => score >= level.min && score <= level.max);
    const current = LEVELS[index < 0 ? LEVELS.length - 1 : index];
    const next = LEVELS[Math.min(LEVELS.length - 1, (index < 0 ? LEVELS.length - 1 : index) + 1)];
    if (current === next || !Number.isFinite(current.max)) return current.speed;
    const range = Math.max(1, next.min - current.min);
    const progress = Math.max(0, Math.min(1, (score - current.min) / range));
    return current.speed + (next.speed - current.speed) * progress;
  }

  function rectFromHitbox(item, hitbox) {
    const bounds = item.go.getBounds();
    const centerX = bounds.centerX + hitbox.offsetX;
    const centerY = bounds.centerY + hitbox.offsetY;
    return {
      x: centerX - hitbox.width / 2,
      y: centerY - hitbox.height / 2,
      width: hitbox.width,
      height: hitbox.height,
      left: centerX - hitbox.width / 2,
      right: centerX + hitbox.width / 2,
      top: centerY - hitbox.height / 2,
      bottom: centerY + hitbox.height / 2,
      centerX,
      centerY,
    };
  }

  function getItemRects(item) {
    return (item.hitboxes || []).map((hitbox) => rectFromHitbox(item, hitbox));
  }

  function distanceToSegment(x, a, b) {
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    if (x < min) return min - x;
    if (x > max) return x - max;
    return 0;
  }

  function gaussian(distance, radius) {
    return Math.exp(-(distance * distance) / (2 * radius * radius));
  }

  function hazardRiskAt(x, scene, item, playerY, speedMultiplier) {
    if (item.kind !== 'hazard' || !item.go?.active) return 0;
    const rects = getItemRects(item);
    if (!rects.length) return 0;
    const bounds = item.go.getBounds();
    let risk = 0;

    if (item.state === 'falling') {
      const verticalSpeed = Math.max(1, item.speed * speedMultiplier);
      const timeToPlayer = (playerY - Math.max(...rects.map((r) => r.bottom))) / verticalSpeed;
      if (timeToPlayer < -0.35 || timeToPlayer > 3.2) return 0;
      const urgency = Math.exp(-Math.max(0, timeToPlayer) / 0.78);
      const radius = timeToPlayer < 0.65 ? 112 : 82;
      risk += gaussian(Math.abs(x - bounds.centerX), radius) * urgency * 165;
    } else if (item.state === 'landing') {
      risk += gaussian(Math.abs(x - bounds.centerX), 88) * 115;
    } else if (item.state === 'grounded') {
      const futureX = bounds.centerX
        + PHYSICS.enemyWalkSpeed
          * (item.walkDirection || 1)
          * speedMultiplier
          * CONFIG.predictionSeconds;
      const distance = distanceToSegment(x, bounds.centerX, futureX);
      risk += gaussian(distance, 72) * 135;
    }
    return risk;
  }

  function redZoneRiskAt(x, scene) {
    const redZones = scene.redZones;
    if (!redZones) return 0;
    let risk = 0;

    for (const zone of redZones.zones || []) {
      const left = zone.x - zone.width / 2 + 24 - CONFIG.redZoneSafetyMargin;
      const right = zone.x + zone.width / 2 - 24 + CONFIG.redZoneSafetyMargin;
      const remaining = Math.max(0, 1500 - zone.elapsed);
      if (x >= left && x <= right) {
        // 红区为一击致命，任何普通障碍物风险都不能覆盖此惩罚。
        risk += 1_000_000_000 + (1500 - remaining) * 100_000;
      } else {
        const distance = Math.min(Math.abs(x - left), Math.abs(x - right));
        risk += gaussian(distance, 72) * (800 + (1 - remaining / 1500) * 2400);
      }
    }
    return risk;
  }

  function getRedZoneIntervals(scene) {
    return (scene.redZones?.zones || [])
      .map((zone) => ({
        left: Math.max(
          CONFIG.edgeMargin,
          zone.x - zone.width / 2 + 24 - CONFIG.redZoneSafetyMargin,
        ),
        right: Math.min(
          scene.scale.width - CONFIG.edgeMargin,
          zone.x + zone.width / 2 - 24 + CONFIG.redZoneSafetyMargin,
        ),
        remaining: Math.max(0, 1500 - zone.elapsed),
        zone,
      }))
      .sort((a, b) => a.left - b.left);
  }

  function isInsideRedZone(x, intervals) {
    return intervals.some((interval) => x >= interval.left && x <= interval.right);
  }

  function redZoneSignature(intervals) {
    return intervals
      .map((interval) => `${Math.round(interval.left)}:${Math.round(interval.right)}`)
      .join('|');
  }

  function chooseRedZoneEvacuationTarget(scene, items, intervals, speedMultiplier) {
    const playerX = scene.player.sprite.x;
    const playerY = scene.player.sprite.y;
    const width = scene.scale.width;
    const points = new Set([CONFIG.edgeMargin, width - CONFIG.edgeMargin]);
    for (const interval of intervals) {
      points.add(Math.max(CONFIG.edgeMargin, interval.left - 2));
      points.add(Math.min(width - CONFIG.edgeMargin, interval.right + 2));
    }

    const snapshots = buildHazardSnapshots(items);
    const timeline = buildHazardTimeline(
      snapshots,
      speedMultiplier,
      scene.getGroundY(),
    );
    const candidates = [...points]
      .filter((x) => !isInsideRedZone(x, intervals))
      .map((x) => {
        const trajectory = simulateCollisionRisk(
          scene,
          items,
          speedMultiplier,
          false,
          x,
          timeline,
        );
        let npcRisk = 0;
        for (const item of items) {
          npcRisk += hazardRiskAt(x, scene, item, playerY, speedMultiplier);
        }
        return {
          x,
          // 轨迹中的红区风险以十亿计，确保先选能最快离开红区的出口；
          // 同等撤离时间下再选择 NPC 更少的一侧。
          risk: trajectory.risk + Math.abs(x - playerX) * 4 + npcRisk * 0.1,
        };
      });

    if (!candidates.length) {
      // 极端情况下红区覆盖全场，选择离所有红区中心综合距离最远的位置。
      for (let x = CONFIG.edgeMargin; x <= width - CONFIG.edgeMargin; x += 12) {
        const overlapCount = intervals.filter(
          (interval) => x >= interval.left && x <= interval.right,
        ).length;
        const centerDistance = intervals.reduce(
          (sum, interval) => sum + Math.abs(x - (interval.left + interval.right) / 2),
          0,
        );
        candidates.push({
          x,
          risk: overlapCount * 1_000_000 - centerDistance,
        });
      }
    }

    candidates.sort((a, b) => a.risk - b.risk);
    return candidates[0];
  }

  function riskAt(x, scene, items, playerY, speedMultiplier) {
    let risk = redZoneRiskAt(x, scene);
    for (const item of items) {
      risk += hazardRiskAt(x, scene, item, playerY, speedMultiplier);
    }
    const width = scene.scale.width;
    const edgeDistance = Math.min(x, width - x);
    if (edgeDistance < CONFIG.edgeMargin) {
      risk += (CONFIG.edgeMargin - edgeDistance) * 2.5;
    }
    return risk;
  }

  function getAdaptiveEscapeBuffer(speedMultiplier) {
    return CONFIG.preferredEdgeBuffer
      + Math.max(0, speedMultiplier - 1.6) * 120;
  }

  function mobilityRiskAt(x, width, speedMultiplier) {
    const edgeDistance = Math.min(x, width - x);
    const adaptiveBuffer = getAdaptiveEscapeBuffer(speedMultiplier);
    const missingEscapeRoom = Math.max(0, adaptiveBuffer - edgeDistance);
    return missingEscapeRoom * missingEscapeRoom * CONFIG.edgeMobilityPenalty;
  }

  function compareSurvivalCandidates(a, b) {
    const criticalWindow = 0.6;
    const aCritical = (a.trajectory?.firstCollision ?? Infinity) <= criticalWindow;
    const bCritical = (b.trajectory?.firstCollision ?? Infinity) <= criticalWindow;
    if (aCritical !== bCritical) return aCritical ? 1 : -1;
    if (aCritical && bCritical) {
      const collisionTimeDifference = b.trajectory.firstCollision
        - a.trajectory.firstCollision;
      if (Math.abs(collisionTimeDifference) > 0.02) {
        return collisionTimeDifference;
      }
    }
    return a.risk - b.risk;
  }

  function chooseTarget(scene, items) {
    const player = scene.player;
    const playerX = player.sprite.x;
    const playerY = player.sprite.y;
    const width = scene.scale.width;
    const speedMultiplier = getSpeedMultiplier(getScore(scene));
    const now = performance.now();
    const intervals = getRedZoneIntervals(scene);
    const signature = redZoneSignature(intervals);
    const playerInRedZone = isInsideRedZone(playerX, intervals);
    const oldTargetInRedZone = isInsideRedZone(runtime.targetX, intervals);

    if (signature !== runtime.redZoneSignature) {
      runtime.redZoneSignature = signature;
      runtime.redZoneTarget = null;
      runtime.cachedTarget = null;
    }

    if (playerInRedZone || oldTargetInRedZone) {
      runtime.evacuatingRedZone = true;
      runtime.cachedTarget = null;

      if (
        runtime.redZoneTarget === null
        || isInsideRedZone(runtime.redZoneTarget, intervals)
        || now - runtime.lastPlanAt >= CONFIG.targetReplanMs
      ) {
        runtime.redZoneTarget = chooseRedZoneEvacuationTarget(
          scene,
          items,
          intervals,
          speedMultiplier,
        ).x;
        runtime.lastPlanAt = now;
      }

      runtime.currentRisk = redZoneRiskAt(playerX, scene);
      runtime.targetX = runtime.redZoneTarget;
      runtime.targetRisk = redZoneRiskAt(runtime.targetX, scene);
      return {
        x: runtime.targetX,
        risk: runtime.targetRisk,
        speedMultiplier,
        redZoneEmergency: true,
      };
    }

    runtime.evacuatingRedZone = false;
    runtime.redZoneTarget = null;
    if (
      runtime.cachedTarget
      && now - runtime.lastPlanAt < CONFIG.targetReplanMs
      && !isInsideRedZone(playerX, intervals)
      && !isInsideRedZone(runtime.cachedTarget.x, intervals)
    ) {
      return runtime.cachedTarget;
    }

    const snapshots = buildHazardSnapshots(items);
    const timeline = buildHazardTimeline(
      snapshots,
      speedMultiplier,
      scene.getGroundY(),
    );
    const candidates = CONTROL_PLANS.map((controlPlan) => {
      const trajectory = simulateCollisionRisk(
        scene,
        items,
        speedMultiplier,
        false,
        playerX,
        timeline,
        controlPlan,
      );
      let risk = trajectory.risk
        + riskAt(
          trajectory.finalX,
          scene,
          items,
          trajectory.finalY,
          speedMultiplier,
        ) * 0.08
        + mobilityRiskAt(trajectory.finalX, width, speedMultiplier);
      if (
        controlPlan.first !== runtime.currentDirection
        && now - runtime.lastTargetAt < CONFIG.targetHoldMs
      ) {
        risk += CONFIG.targetSwitchPenalty;
      }
      return {
        x: trajectory.finalX,
        risk,
        trajectory,
        controlPlan,
      };
    });
    candidates.sort(compareSurvivalCandidates);

    const selected = candidates[0];
    const holdCandidate = candidates.find(
      (candidate) => candidate.controlPlan.label === 'hold',
    );
    runtime.currentRisk = holdCandidate?.risk ?? selected.risk;
    runtime.targetX = selected.x;
    runtime.targetRisk = selected.risk;
    runtime.lastPlanAt = now;
    if (selected.controlPlan.first !== runtime.currentDirection) {
      runtime.lastTargetAt = now;
    }
    runtime.currentDirection = selected.controlPlan.first;
    runtime.cachedTarget = {
      ...selected,
      speedMultiplier,
      redZoneEmergency: false,
    };
    return runtime.cachedTarget;
  }

  function setDirection(player, direction) {
    const left = direction < 0;
    const right = direction > 0;
    if (player.cursors?.left) player.cursors.left.isDown = left;
    if (player.cursors?.right) player.cursors.right.isDown = right;
    if (player.keyA) player.keyA.isDown = left;
    if (player.keyD) player.keyD.isDown = right;
  }

  function releaseControls() {
    const player = runtime.scene?.player;
    if (player) {
      setDirection(player, 0);
      if (player.sprite) player.targetX = player.sprite.x;
    }
  }

  function translateRect(rect, dx, dy) {
    return {
      left: rect.left + dx,
      right: rect.right + dx,
      top: rect.top + dy,
      bottom: rect.bottom + dy,
    };
  }

  function expandRect(rect, margin) {
    return {
      left: rect.left - margin,
      right: rect.right + margin,
      top: rect.top - margin,
      bottom: rect.bottom + margin,
    };
  }

  function rectsOverlap(a, b) {
    return !(
      a.right < b.left
      || a.left > b.right
      || a.bottom < b.top
      || a.top > b.bottom
    );
  }

  function rectGap(a, b) {
    const dx = Math.max(0, a.left - b.right, b.left - a.right);
    const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
    return Math.hypot(dx, dy);
  }

  function buildHazardSnapshots(items) {
    return items
      .filter((item) => item.kind === 'hazard' && item.go?.active)
      .map((item) => {
        const animationProgress = Number(item.go.anims?.getProgress?.() ?? 0);
        return {
          item,
          state: item.state,
          baseBounds: item.go.getBounds(),
          baseRects: getItemRects(item),
          landingRemaining: item.state === 'landing'
            ? PHYSICS.enemyLandingSeconds
              * (1 - Math.max(0, Math.min(1, animationProgress)))
            : PHYSICS.enemyLandingSeconds,
        };
      });
  }

  function predictHazardRects(snapshot, time, speedMultiplier, groundY) {
    const { item, state, baseBounds, baseRects } = snapshot;
    let dx = 0;
    let dy = 0;

    if (state === 'falling') {
      const fallingSpeed = Math.max(1, item.speed * speedMultiplier);
      const requestedDy = fallingSpeed * time;
      const maximumDy = Math.max(0, groundY - baseBounds.bottom);
      dy = Math.min(requestedDy, maximumDy);
      const landingTime = maximumDy / fallingSpeed;
      const walkingTime = Math.max(
        0,
        time - landingTime - PHYSICS.enemyLandingSeconds,
      );
      if (walkingTime > 0) {
        dx = PHYSICS.enemyWalkSpeed
          * (item.walkDirection || 1)
          * speedMultiplier
          * walkingTime;
        // 落地动画结束后贴合地面的实际碰撞框比下落碰撞框约低 30px。
        dy = maximumDy + 30;
      } else if (time > landingTime) {
        // 6 帧、8fps 的落地动画持续约 0.75 秒，期间 NPC 不横移。
        dy = maximumDy + 24;
      }
    } else if (state === 'landing') {
      const walkingTime = Math.max(0, time - snapshot.landingRemaining);
      if (walkingTime > 0) {
        dx = PHYSICS.enemyWalkSpeed
          * (item.walkDirection || 1)
          * speedMultiplier
          * walkingTime;
        dy = 6;
      }
    } else if (state === 'grounded') {
      const waitingTime = Math.max(0, (500 - (item.groundedElapsed || 0)) / 1000);
      const walkingTime = Math.max(0, time - waitingTime);
      dx = PHYSICS.enemyWalkSpeed
        * (item.walkDirection || 1)
        * speedMultiplier
        * walkingTime;
    }

    return baseRects.map((rect) => translateRect(rect, dx, dy));
  }

  function buildHazardTimeline(snapshots, speedMultiplier, groundY) {
    const timeline = [];
    const horizon = CONFIG.jumpPredictionSeconds;
    const dt = CONFIG.jumpPredictionStepSeconds;
    for (let time = dt; time <= horizon + dt / 2; time += dt) {
      const rects = [];
      for (const snapshot of snapshots) {
        for (const rect of predictHazardRects(
          snapshot,
          time,
          speedMultiplier,
          groundY,
        )) {
          rects.push(expandRect(rect, CONFIG.collisionMargin));
        }
      }
      timeline.push({ time, rects });
    }
    return timeline;
  }

  function simulateCollisionRisk(
    scene,
    items,
    speedMultiplier,
    jumpNow,
    targetX = runtime.targetX,
    hazardTimeline = null,
    controlPlan = null,
  ) {
    const player = scene.player;
    const sprite = player.sprite;
    const groundY = scene.getGroundY();
    const initialOnGround = player.isOnGround(groundY);
    const health = Number(player.getHealth?.() ?? player.playerHealth ?? 3);
    const playerSafetyMargin = CONFIG.collisionMargin
      + (health <= 1 ? 5 : health === 2 ? 2 : 0);
    const head = player.getHeadBounds();
    const body = player.getBodyBounds();
    const headOffset = { x: head.x - sprite.x, y: head.y - sprite.y };
    const bodyOffset = { x: body.x - sprite.x, y: body.y - sprite.y };

    let x = sprite.x;
    let y = sprite.y;
    let movementTargetX = Number.isFinite(player.targetX) ? player.targetX : x;
    let velocityY = jumpNow
      ? (initialOnGround ? PHYSICS.groundJumpVelocity : PHYSICS.airJumpVelocity)
      : player.velocityY;
    let risk = 0;
    let firstCollision = Infinity;
    let minimumGap = Infinity;
    const invincibilityRemaining = Math.max(
      0,
      ((player.invincibleUntilGameMs || 0) - (scene.elapsedGameMs || 0)) / 1000,
    );
    const redZones = getRedZoneIntervals(scene);
    const timeline = hazardTimeline || buildHazardTimeline(
      buildHazardSnapshots(items),
      speedMultiplier,
      groundY,
    );
    const horizon = CONFIG.jumpPredictionSeconds;
    const dt = CONFIG.jumpPredictionStepSeconds;

    for (const step of timeline) {
      const { time } = step;
      const onGround = y >= groundY - 0.5;
      const deltaX = targetX - movementTargetX;
      const direction = controlPlan
        ? (time < controlPlan.switchAt ? controlPlan.first : controlPlan.second)
        : (
          Math.abs(deltaX) <= CONFIG.directionDeadZone
            ? 0
            : Math.sign(deltaX)
        );
      const horizontalSpeed = PHYSICS.playerGroundSpeed
        * (onGround ? 1 : PHYSICS.playerAirSpeedScale);
      movementTargetX += direction * horizontalSpeed * dt;
      movementTargetX = Math.max(
        PHYSICS.playerHalfWidth,
        Math.min(scene.scale.width - PHYSICS.playerHalfWidth, movementTargetX),
      );
      // 源码以 60fps 为基准，每帧追随内部 targetX 差值的 20%。
      x += (movementTargetX - x) * PHYSICS.playerFollowPerFrame;

      const gravity = velocityY < 0
        ? PHYSICS.risingGravity
        : PHYSICS.fallingGravity;
      velocityY += gravity * dt;
      y += velocityY * dt;
      if (y >= groundY) {
        y = groundY;
        velocityY = 0;
      }

      if (isInsideRedZone(x, redZones)) {
        firstCollision = Math.min(firstCollision, time);
        risk += 1_000_000_000;
      }
      risk += mobilityRiskAt(x, scene.scale.width, speedMultiplier) * dt * 0.35;

      const predictedHead = expandRect({
        left: x + headOffset.x,
        right: x + headOffset.x + head.width,
        top: y + headOffset.y,
        bottom: y + headOffset.y + head.height,
      }, playerSafetyMargin);
      const predictedBody = expandRect({
        left: x + bodyOffset.x,
        right: x + bodyOffset.x + body.width,
        top: y + bodyOffset.y,
        bottom: y + bodyOffset.y + body.height,
      }, playerSafetyMargin);

      for (const expandedHazard of step.rects) {
          const collision =
            rectsOverlap(predictedHead, expandedHazard)
            || rectsOverlap(predictedBody, expandedHazard);
          if (collision) {
            // NPC 受击后 2.5 秒内重复接触不会扣血。无敌期内不把接触当成
            // 致命路线，让角色利用这段时间从边缘或包围中撤出。
            if (time < invincibilityRemaining) continue;
            firstCollision = Math.min(firstCollision, time);
            // 远期碰撞仍需关注，但不能因此提前一秒逃进角落。80ms 后会
            // 重新规划，越接近当前时刻的碰撞惩罚才应快速增大。
            risk += 32_000 * Math.exp(-time / 0.28);
          } else {
            const gap = Math.min(
              rectGap(predictedHead, expandedHazard),
              rectGap(predictedBody, expandedHazard),
            );
            minimumGap = Math.min(minimumGap, gap);
            if (gap < CONFIG.closePassDistance) {
              // 即使尚未相交，过近也会因为帧率和碰撞框误差变成擦碰。
              risk += (CONFIG.closePassDistance - gap)
                * (horizon - time + 0.16)
                * 14;
            }
          }
      }
    }
    return {
      risk,
      firstCollision,
      minimumGap,
      finalX: x,
      finalY: y,
      finalMovementTargetX: movementTargetX,
    };
  }

  function decideJump(
    scene,
    items,
    speedMultiplier,
    redZoneEmergency,
    controlPlan = null,
  ) {
    const player = scene.player;
    const now = performance.now();

    // 红区撤离时优先保持最高水平速度。
    if (
      redZoneEmergency
      || player.jumpsRemaining <= 0
      || now - runtime.lastJumpAt < CONFIG.jumpCooldownMs
    ) {
      return null;
    }

    const snapshots = buildHazardSnapshots(items);
    const timeline = buildHazardTimeline(
      snapshots,
      speedMultiplier,
      scene.getGroundY(),
    );
    const noJump = simulateCollisionRisk(
      scene,
      items,
      speedMultiplier,
      false,
      runtime.targetX,
      timeline,
      controlPlan,
    );

    // 当前轨迹没有预测碰撞，不浪费任何一段跳跃。
    if (!Number.isFinite(noJump.firstCollision)) return null;

    const phase = player.jumpsRemaining >= 2 ? 'first' : 'second';
    const maximumLead = phase === 'first' ? 0.85 : 0.65;
    // 过早起跳容易在空中撞上下落 NPC。持续重算，等到真正需要时再跳。
    if (noJump.firstCollision > maximumLead) return null;

    const jump = simulateCollisionRisk(
      scene,
      items,
      speedMultiplier,
      true,
      runtime.targetX,
      timeline,
      controlPlan,
    );
    const collisionDelayed =
      jump.firstCollision >= noJump.firstCollision + 0.14;
    const riskReduced = jump.risk < noJump.risk * 0.55;

    // 跳起后更早接触其他 NPC 时，禁止为了躲一个目标撞向另一个目标。
    if (jump.firstCollision < noJump.firstCollision - 0.04) return null;

    // 只有现在跳明显优于保持当前轨迹时，才消耗一次跳跃。
    if (!collisionDelayed && !riskReduced) return null;
    return phase;
  }

  function triggerJump(player, phase) {
    const now = performance.now();
    if (now - runtime.lastJumpAt < CONFIG.jumpCooldownMs) return false;
    runtime.lastJumpAt = now;
    runtime.lastJumpLabel = phase === 'first' ? '避险一段跳' : '避险二段跳';
    runtime.lastJumpLabelUntil = now + 900;
    if (player.spaceKey) {
      player.spaceKey._justDown = true;
      player.spaceKey.isDown = true;
      setTimeout(() => {
        if (player.spaceKey) player.spaceKey.isDown = false;
      }, 34);
    }
    return true;
  }

  function drawOverlay(scene, items) {
    const ctx = createOrUpdateOverlay();
    if (!ctx || !runtime.overlay) return;
    ctx.clearRect(0, 0, runtime.overlay.width, runtime.overlay.height);

    const sx = runtime.overlay.width / scene.scale.width;
    const sy = runtime.overlay.height / scene.scale.height;
    ctx.save();
    ctx.scale(sx, sy);
    ctx.lineWidth = 2 / sx;

    for (const zone of scene.redZones?.zones || []) {
      ctx.fillStyle = 'rgba(255,35,35,.18)';
      ctx.strokeStyle = 'rgba(255,60,60,.9)';
      const left = zone.x - zone.width / 2 + 24;
      const width = zone.width - 48;
      ctx.fillRect(left, 0, width, zone.playAreaBottom);
      ctx.strokeRect(left, 0, width, zone.playAreaBottom);
    }

    for (const item of items) {
      if (!item.go?.active) continue;
      ctx.strokeStyle = item.kind === 'hazard' ? '#ff5a52' : '#ffd138';
      for (const rect of getItemRects(item)) {
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      }
    }

    const player = scene.player;
    const body = player.getBodyBounds();
    ctx.strokeStyle = '#55e7ff';
    ctx.strokeRect(body.x, body.y, body.width, body.height);

    ctx.beginPath();
    ctx.moveTo(player.sprite.x, player.sprite.y - 8);
    ctx.lineTo(runtime.targetX, player.sprite.y - 8);
    ctx.strokeStyle = '#7CFC98';
    ctx.stroke();
    ctx.fillStyle = '#7CFC98';
    ctx.beginPath();
    ctx.arc(runtime.targetX, player.sprite.y - 8, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function update() {
    requestAnimationFrame(update);
    makePanel();

    const scene = runtime.scene;
    if (!runtime.enabled) {
      releaseControls();
      clearOverlay();
      return;
    }
    if (!isGameScene(scene)) {
      setStatus('等待开始游戏后的首个 NPC…', '#80d8ff');
      return;
    }
    if (scene.isGameOver || scene.gamePaused || scene.orientation?.isPaused?.()) {
      releaseControls();
      if (scene.isGameOver) {
        if (!runtime.lastGameOverSummary) {
          const health = Number(scene.player.getHealth?.() ?? scene.player.playerHealth ?? 0);
          const reason = health <= 0 ? 'NPC碰撞' : '红区';
          runtime.lastGameOverSummary = `结束 ${getScore(scene)}分　${reason}`;
          console.warn('[VFoch Auto Dodge]', runtime.lastGameOverSummary);
        }
        setStatus(runtime.lastGameOverSummary, '#ffb74d');
      } else {
        setStatus('游戏已暂停', '#ffb74d');
      }
      clearOverlay();
      return;
    }
    runtime.lastGameOverSummary = '';

    const items = scene.fallingItems.getItems();
    const target = chooseTarget(scene, items);
    // 按内部 targetX 控制按键，先把“移动目标”制动到规划点，再让角色追随。
    // 若按 sprite.x 控制，内部 targetX 会持续越过规划点并造成大幅过冲。
    const controlX = Number.isFinite(scene.player.targetX)
      ? scene.player.targetX
      : scene.player.sprite.x;
    const delta = target.x - controlX;
    const direction = target.redZoneEmergency
      ? (Math.abs(delta) <= CONFIG.directionDeadZone ? 0 : Math.sign(delta))
      : (target.controlPlan?.first ?? 0);
    setDirection(scene.player, direction);

    const jumpPhase = decideJump(
      scene,
      items,
      target.speedMultiplier,
      target.redZoneEmergency,
      target.controlPlan,
    );
    if (jumpPhase) {
      triggerJump(scene.player, jumpPhase);
    }

    const arrow = direction < 0 ? '←' : direction > 0 ? '→' : '等待';
    if (target.redZoneEmergency) {
      setStatus(
        `红区紧急撤离 ${arrow}　安全出口 ${Math.round(runtime.targetX)}`,
        '#ff5252',
      );
    } else {
      const score = getScore(scene);
      const health = Number(
        scene.player.getHealth?.() ?? scene.player.playerHealth ?? 0,
      );
      setStatus(
        `${arrow} 分${score} 血${health}　风险${runtime.currentRisk.toFixed(1)}`
        + `　目标${Math.round(runtime.targetX)}`
        + `${
          runtime.lastJumpLabel && performance.now() < runtime.lastJumpLabelUntil
            ? `　${runtime.lastJumpLabel}`
            : ''
        }`,
        '#7CFC98',
      );
    }
    drawOverlay(scene, items);
  }

  function resetCapture() {
    releaseControls();
    runtime.scene = null;
    runtime.targetX = 800;
    runtime.cachedTarget = null;
    runtime.lastPlanAt = 0;
    runtime.lastTargetAt = 0;
    runtime.currentDirection = 0;
    runtime.evacuatingRedZone = false;
    runtime.redZoneTarget = null;
    runtime.redZoneSignature = '';
    runtime.lastJumpLabel = '';
    runtime.lastJumpLabelUntil = 0;
    runtime.lastGameOverSummary = '';
    clearOverlay();
    installArrayPushHook();
    setStatus('已重置，等待首个 NPC…', '#80d8ff');
  }

  window.addEventListener('keydown', (event) => {
    if (event.repeat) return;
    if (event.code === 'F8') {
      event.preventDefault();
      event.stopImmediatePropagation();
      runtime.enabled = !runtime.enabled;
      if (!runtime.enabled) {
        releaseControls();
        setStatus('自动躲避已暂停', '#ff8a80');
      }
    } else if (event.code === 'F9') {
      event.preventDefault();
      event.stopImmediatePropagation();
      resetCapture();
    }
  }, true);

  window.addEventListener('pagehide', () => {
    releaseControls();
    restoreArrayPush();
  });

  window.VFochAutoDodge = {
    runtime,
    reset: resetCapture,
    enable: () => { runtime.enabled = true; },
    disable: () => {
      runtime.enabled = false;
      releaseControls();
    },
  };

  installArrayPushHook();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', makePanel, { once: true });
  } else {
    makePanel();
  }
  requestAnimationFrame(update);
})();
