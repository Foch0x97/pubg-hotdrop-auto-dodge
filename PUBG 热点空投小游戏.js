// ==UserScript==
// @name         PUBG 热点空投小游戏
// @namespace    VFoch Network
// @version      2.4.0
// @description  读取 Phaser 游戏对象，预测 NPC、空投和红区，自动移动与跳跃
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
    debugOverlay: true,
    candidateStep: 28,
    edgeMargin: 52,
    directionDeadZone: 16,
    targetReplanMs: 70,
    targetHoldMs: 180,
    targetSwitchPenalty: 26,
    jumpCooldownMs: 150,
    jumpPredictionSeconds: 1.18,
    jumpPredictionStepSeconds: 0.04,
    predictionSeconds: 1.7,
    redZoneSafetyMargin: 38,
  };

  const runtime = {
    scene: null,
    enabled: CONFIG.enabled,
    originalPush: null,
    pushHooked: false,
    targetX: 800,
    targetRisk: 0,
    currentRisk: 0,
    lastPlanAt: 0,
    lastTargetAt: 0,
    cachedTarget: null,
    lastJumpAt: 0,
    lastJumpLabel: '',
    lastJumpLabelUntil: 0,
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
      <div style="font-weight:800;color:#ffd138">VFoch Auto Dodge 2.4</div>
      <div class="vf-status" style="margin-top:4px;color:#80d8ff">等待小游戏运行时…</div>
      <div style="margin-top:5px;color:#aaa">F8 开关　F9 重新捕获</div>
    `;
    Object.assign(panel.style, {
      position: 'fixed',
      top: '86px',
      right: '12px',
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
    Array.prototype.push = function (...args) {
      const result = runtime.originalPush.apply(this, args);
      if (!runtime.scene) {
        for (const value of args) {
          if (
            value
            && (value.kind === 'hazard' || value.kind === 'collectible')
            && value.go
            && captureSceneFromItem(value)
          ) {
            break;
          }
        }
      }
      return result;
    };
    runtime.pushHooked = true;
  }

  function restoreArrayPush() {
    if (!runtime.pushHooked || !runtime.originalPush) return;
    Array.prototype.push = runtime.originalPush;
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
        + 120 * (item.walkDirection || 1) * speedMultiplier * CONFIG.predictionSeconds;
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
    const candidates = [];

    // 更细的采样用于尽快找到最近的安全出口。
    for (let x = CONFIG.edgeMargin; x <= width - CONFIG.edgeMargin; x += 12) {
      if (isInsideRedZone(x, intervals)) continue;
      let npcRisk = 0;
      for (const item of items) {
        npcRisk += hazardRiskAt(x, scene, item, playerY, speedMultiplier);
      }
      const distance = Math.abs(x - playerX);
      const nearestBoundary = intervals.length
        ? Math.min(...intervals.flatMap((interval) => [
          Math.abs(x - interval.left),
          Math.abs(x - interval.right),
        ]))
        : width;

      // 首要目标是用最短时间离开红区；NPC 只作为次级选择条件。
      const score = distance * 10 + npcRisk * 0.08 - Math.min(100, nearestBoundary) * 0.35;
      candidates.push({ x, risk: score });
    }

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

  function chooseTarget(scene, items) {
    const player = scene.player;
    const playerX = player.sprite.x;
    const playerY = player.sprite.y;
    const width = scene.scale.width;
    const speedMultiplier = getSpeedMultiplier(getScore(scene));
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
      ) {
        runtime.redZoneTarget = chooseRedZoneEvacuationTarget(
          scene,
          items,
          intervals,
          speedMultiplier,
        ).x;
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
    const now = performance.now();

    // 每帧重算会让目标在相邻安全格之间来回切换。短周期缓存不影响预判，
    // 但能让角色真正完成一次有意义的横移。
    if (
      runtime.cachedTarget
      && now - runtime.lastPlanAt < CONFIG.targetReplanMs
      && !isInsideRedZone(playerX, intervals)
      && !isInsideRedZone(runtime.cachedTarget.x, intervals)
    ) {
      return runtime.cachedTarget;
    }

    const currentRisk = riskAt(playerX, scene, items, playerY, speedMultiplier);
    const candidates = [];

    for (
      let x = CONFIG.edgeMargin;
      x <= width - CONFIG.edgeMargin;
      x += CONFIG.candidateStep
    ) {
      // 评估从当前位置移动到候选点的整段路线，而不是只看终点。
      // 这会提前排除即将有下落 NPC 或游走 NPC 穿过的路线。
      const trajectory = simulateCollisionRisk(
        scene,
        items,
        speedMultiplier,
        false,
        x,
      );
      let risk = trajectory.risk + riskAt(x, scene, items, playerY, speedMultiplier) * 0.16;
      const travelSeconds = Math.abs(x - playerX) / 384;
      risk += travelSeconds * 2.2;
      if (Math.abs(x - runtime.targetX) < CONFIG.candidateStep) {
        risk -= 5;
      } else if (now - runtime.lastTargetAt < CONFIG.targetHoldMs) {
        risk += CONFIG.targetSwitchPenalty;
      }
      candidates.push({ x, risk, trajectory });
    }

    const currentTrajectory = simulateCollisionRisk(
      scene,
      items,
      speedMultiplier,
      false,
      playerX,
    );
    candidates.push({
      x: playerX,
      risk: currentTrajectory.risk + currentRisk * 0.16 - (currentRisk < 25 ? 4 : 0),
      trajectory: currentTrajectory,
    });
    candidates.sort((a, b) => a.risk - b.risk);

    runtime.currentRisk = currentRisk;
    runtime.targetX = candidates[0].x;
    runtime.targetRisk = candidates[0].risk;
    runtime.lastPlanAt = now;
    runtime.lastTargetAt = now;
    runtime.cachedTarget = {
      ...candidates[0],
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

  function predictHazardRects(item, time, speedMultiplier, groundY) {
    const baseBounds = item.go.getBounds();
    let dx = 0;
    let dy = 0;

    if (item.state === 'falling') {
      const fallingSpeed = Math.max(1, item.speed * speedMultiplier);
      const requestedDy = fallingSpeed * time;
      const maximumDy = Math.max(0, groundY - baseBounds.bottom);
      dy = Math.min(requestedDy, maximumDy);
      // NPC 落地后会开始游走。提前将这段路线纳入模型，避免角色横移到
      // 即将被落地 NPC 占据的安全格。
      const landingTime = maximumDy / fallingSpeed;
      const walkingTime = Math.max(0, time - landingTime - 0.12);
      if (walkingTime > 0) {
        dx = 120 * (item.walkDirection || 1) * speedMultiplier * walkingTime;
      }
    } else if (item.state === 'grounded') {
      dx = 120 * (item.walkDirection || 1) * speedMultiplier * time;
    }

    return getItemRects(item).map((rect) => translateRect(rect, dx, dy));
  }

  function simulateCollisionRisk(
    scene,
    items,
    speedMultiplier,
    jumpNow,
    targetX = runtime.targetX,
  ) {
    const player = scene.player;
    const sprite = player.sprite;
    const groundY = scene.getGroundY();
    const initialOnGround = player.isOnGround(groundY);
    const head = player.getHeadBounds();
    const body = player.getBodyBounds();
    const headOffset = { x: head.x - sprite.x, y: head.y - sprite.y };
    const bodyOffset = { x: body.x - sprite.x, y: body.y - sprite.y };

    let x = sprite.x;
    let y = sprite.y;
    let velocityY = jumpNow
      ? (initialOnGround ? -860 : -720)
      : player.velocityY;
    let risk = 0;
    let firstCollision = Infinity;
    let minimumGap = Infinity;
    const redZones = getRedZoneIntervals(scene);
    const horizon = CONFIG.jumpPredictionSeconds;
    const dt = CONFIG.jumpPredictionStepSeconds;

    for (let time = dt; time <= horizon; time += dt) {
      const onGround = y >= groundY - 0.5;
      const horizontalSpeed = 384 * (onGround ? 1 : 0.8);
      const horizontalStep = horizontalSpeed * dt;
      const deltaX = targetX - x;
      x += Math.sign(deltaX) * Math.min(Math.abs(deltaX), horizontalStep);

      const gravity = velocityY < 0 ? 2600 : 4000;
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

      const predictedHead = expandRect({
        left: x + headOffset.x,
        right: x + headOffset.x + head.width,
        top: y + headOffset.y,
        bottom: y + headOffset.y + head.height,
      }, 2);
      const predictedBody = expandRect({
        left: x + bodyOffset.x,
        right: x + bodyOffset.x + body.width,
        top: y + bodyOffset.y,
        bottom: y + bodyOffset.y + body.height,
      }, 2);

      for (const item of items) {
        if (item.kind !== 'hazard' || !item.go?.active) continue;
        const hazardRects = predictHazardRects(
          item,
          time,
          speedMultiplier,
          groundY,
        );
        for (const hazardRect of hazardRects) {
          const expandedHazard = expandRect(hazardRect, 2);
          const collision =
            rectsOverlap(predictedHead, expandedHazard)
            || rectsOverlap(predictedBody, expandedHazard);
          if (collision) {
            firstCollision = Math.min(firstCollision, time);
            risk += (horizon - time + 0.2) * 1800;
          } else {
            const gap = Math.min(
              rectGap(predictedHead, expandedHazard),
              rectGap(predictedBody, expandedHazard),
            );
            minimumGap = Math.min(minimumGap, gap);
            if (gap < 42) {
              // 即使尚未相交，过近也会因为帧率和碰撞框误差变成擦碰。
              risk += (42 - gap) * (horizon - time + 0.16) * 9;
            }
          }
        }
      }
    }
    return { risk, firstCollision, minimumGap };
  }

  function decideJump(scene, items, speedMultiplier, redZoneEmergency) {
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

    const noJump = simulateCollisionRisk(
      scene,
      items,
      speedMultiplier,
      false,
    );

    // 当前轨迹没有预测碰撞，不浪费任何一段跳跃。
    if (!Number.isFinite(noJump.firstCollision)) return null;

    const jump = simulateCollisionRisk(
      scene,
      items,
      speedMultiplier,
      true,
    );
    const collisionDelayed =
      jump.firstCollision >= noJump.firstCollision + 0.14;
    const riskReduced = jump.risk < noJump.risk * 0.58;

    // 只有现在跳明显优于保持当前轨迹时，才消耗一次跳跃。
    if (!collisionDelayed && !riskReduced) return null;
    return player.jumpsRemaining >= 2 ? 'first' : 'second';
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
      setStatus(scene.isGameOver ? '本局已结束' : '游戏已暂停', '#ffb74d');
      clearOverlay();
      return;
    }

    const items = scene.fallingItems.getItems();
    const target = chooseTarget(scene, items);
    const delta = target.x - scene.player.sprite.x;
    const direction =
      Math.abs(delta) <= CONFIG.directionDeadZone ? 0 : Math.sign(delta);
    setDirection(scene.player, direction);

    const jumpPhase = decideJump(
      scene,
      items,
      target.speedMultiplier,
      target.redZoneEmergency,
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
      setStatus(
        `${arrow}  风险 ${runtime.currentRisk.toFixed(1)}  目标 ${Math.round(runtime.targetX)}`
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
    runtime.evacuatingRedZone = false;
    runtime.redZoneTarget = null;
    runtime.redZoneSignature = '';
    runtime.lastJumpLabel = '';
    runtime.lastJumpLabelUntil = 0;
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
