(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* ================================================================
     CONSTANTES
     ================================================================ */
  var MASS_MIN = 5, MASS_MAX = 80, MASS_STEP = 5;
  var A_MIN = 50, A_MAX = 300;
  var B_MIN = 50, B_MAX = 300;
  var CONTACT_TOL = 5;      // mm/px (escala 1:1) para considerar "encostou"
  var MOVE_STEP_DEG = 5;    // incremento dos botões de mover chumbo
  var FLANGE_X = 190;       // referência fixa da máquina (início da medida A)
  var WHEEL_CY = 335;       // altura comum: régua A, perfil lateral e centro da roda de frente
  var RULER_B_Y = 455;      // altura da régua B (embaixo da roda)
  var FRONT_CX = 430, FRONT_CY = 335; // centro fixo da roda quando vista de frente

  var WHEEL_PRESETS = [
    { id: 'compact', label: 'Popular (aro 13"–14")', diameters: [13, 14] },
    { id: 'sedan', label: 'Sedã / hatch (aro 15"–16")', diameters: [15, 16] },
    { id: 'suv', label: 'SUV / picape (aro 17"–18")', diameters: [17, 18] },
    { id: 'sport', label: 'Esportivo (aro 19"–20")', diameters: [19, 20] },
    { id: 'premium', label: 'Premium (aro 21"–22")', diameters: [21, 22] }
  ];

  /* ================================================================
     ESTADO DA SIMULAÇÃO
     ================================================================ */
  var state = {
    mode: 'sim',
    wheelView: 'side',
    tolerance: 5,

    handleA_x: FLANGE_X + 20,
    handleBIn_x: FLANGE_X + 10,
    handleBOut_x: FLANGE_X + 40,

    rim: { internalX: 0, externalX: 0, diameterIn: 17 },
    geom: { cx: FRONT_CX, cy: FRONT_CY, r: 150, tireR: 174, innerR: 78, outerR: 126 },

    rotorAngleRaw: 0,
    spinning: false,
    hasSpun: false,

    unbalance: { internal: { mass: 45, angle: 40 }, external: { mass: 35, angle: 200 } },
    weights: { internal: [], external: [] },
    pendingMass: { internal: 5, external: 5 },
    selectedWeight: null,
    lastReading: { internal: null, external: null }
  };

  /* ================================================================
     CÁLCULO VETORIAL DE DESBALANCEAMENTO
     Cada chumbo (ou o próprio desbalanceamento-alvo) é uma massa
     aplicada em um ângulo fixo da roda. Tratamos massa+ângulo como um
     vetor 2D: somando os vetores dos chumbos e subtraindo do vetor
     alvo, obtemos o vetor de desbalanceamento restante. Por isso um
     chumbo no ângulo certo reduz a leitura e um chumbo no ângulo
     errado pode aumentá-la — a física do problema, não só um número
     fixo mudando na tela.
     ================================================================ */

  // massa + ângulo -> vetor (x, y)
  function toVector(mass, angleDeg) {
    var rad = (angleDeg * Math.PI) / 180;
    return { x: mass * Math.cos(rad), y: mass * Math.sin(rad) };
  }

  function addVec(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
  function subVec(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }

  // vetor -> massa (magnitude) + ângulo normalizado em 0-359°
  function fromVector(v) {
    var mass = Math.sqrt(v.x * v.x + v.y * v.y);
    var angle = (Math.atan2(v.y, v.x) * 180) / Math.PI;
    angle = ((angle % 360) + 360) % 360;
    return { mass: mass, angle: angle };
  }

  // soma vetorial de todos os chumbos de um plano
  function sumWeights(list) {
    var acc = { x: 0, y: 0 };
    for (var i = 0; i < list.length; i++) {
      acc = addVec(acc, toVector(list[i].mass, list[i].angle));
    }
    return acc;
  }

  // desbalanceamento restante de um plano = alvo - soma dos chumbos colocados
  function computeRemaining(plane) {
    var target = toVector(state.unbalance[plane].mass, state.unbalance[plane].angle);
    var placed = sumWeights(state.weights[plane]);
    return fromVector(subVec(target, placed));
  }

  /* ================================================================
     GEOMETRIA (posições na tela, uso de A/B/D)
     ================================================================ */
  function radiusForDiameter(diameterIn) {
    var base = 150, scale = diameterIn / 17;
    return Math.max(92, Math.min(190, base * scale));
  }

  function rimHeightFor(diameterIn) {
    return 60 + (diameterIn - 13) * 10;
  }

  // ponto num círculo com 0° no topo, crescendo no sentido horário
  function polarXY(cx, cy, r, angleDeg) {
    var rad = (angleDeg * Math.PI) / 180;
    return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
  }

  // inverso de polarXY: converte um ponto de volta para ângulo (0-359°)
  function angleFromPoint(cx, cy, x, y) {
    var a = (Math.atan2(x - cx, cy - y) * 180) / Math.PI;
    return ((a % 360) + 360) % 360;
  }

  function svgPointFromEvent(svgEl, evt) {
    var pt = svgEl.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    var ctm = svgEl.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    var loc = pt.matrixTransform(ctm.inverse());
    return { x: loc.x, y: loc.y };
  }

  function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function planeLabel(p) { return p === 'internal' ? 'interno' : 'externo'; }

  /* ================================================================
     REFERÊNCIAS DOM
     ================================================================ */
  var el = {};
  function q(id) { return document.getElementById(id); }

  function cacheRefs() {
    [
      'app', 'toast',
      'modeLearnBtn', 'modeSimBtn', 'selectPreset', 'btnExercicio',
      'btnViewToggle', 'viewStatus',
      'machineSvg', 'sideRim', 'sideRimTread',
      'planeInternalLine', 'planeExternalLine', 'planeInternalLabel', 'planeExternalLabel',
      'rulerALine', 'rulerATicks', 'handleA', 'labelA',
      'rulerBTicks', 'calipersLine', 'handleBIn', 'handleBOut', 'labelB',
      'inputA', 'inputB', 'selectD', 'labelD',
      'angleTicks', 'wheelRotor', 'tireCircle', 'rimCircle', 'spokes',
      'outerPlaneRing', 'innerPlaneRing', 'valveStem', 'targetGhosts',
      'weightsInternal', 'weightsExternal', 'refPointer',
      'btnGirar', 'miniStatus', 'statusLed',
      'display', 'displayTitle', 'dispMassInt', 'dispAngleInt', 'dispMassExt', 'dispAngleExt',
      'feedback', 'inputTolerance',
      'stepValInt', 'stepValExt', 'listInternal', 'listExternal'
    ].forEach(function (id) { el[id] = q(id); });
  }

  /* ================================================================
     CONSTRUÇÃO ESTÁTICA (feita uma vez)
     ================================================================ */
  function buildRulerTicks(container, baseX, y, tickDir) {
    // tickDir: -1 = ticks apontam para cima da linha, 1 = para baixo
    container.innerHTML = '';
    for (var mm = 0; mm <= A_MAX; mm += 10) {
      var x = baseX + mm;
      var major = mm % 50 === 0;
      var len = major ? 16 : 10;
      var line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', x); line.setAttribute('x2', x);
      line.setAttribute('y1', y + tickDir * 6);
      line.setAttribute('y2', y + tickDir * (6 + len));
      line.setAttribute('class', 'tick-line');
      container.appendChild(line);
      if (major) {
        var t = document.createElementNS(SVG_NS, 'text');
        t.setAttribute('x', x); t.setAttribute('y', y + tickDir * (6 + len + 12));
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('class', 'tick-text');
        t.textContent = String(mm);
        container.appendChild(t);
      }
    }
  }

  function buildAngleTicks() {
    var g = el.angleTicks;
    g.innerHTML = '';
    var r1 = 245, r2Minor = 254, r2Major = 262, rLabel = 278;
    for (var a = 0; a < 360; a += 30) {
      var major = a % 90 === 0;
      var p1 = polarXY(FRONT_CX, FRONT_CY, r1, a);
      var p2 = polarXY(FRONT_CX, FRONT_CY, major ? r2Major : r2Minor, a);
      var wrap = document.createElementNS(SVG_NS, 'g');
      wrap.setAttribute('class', 'angle-tick');
      var line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', p1.x); line.setAttribute('y1', p1.y);
      line.setAttribute('x2', p2.x); line.setAttribute('y2', p2.y);
      wrap.appendChild(line);
      if (major) {
        var lp = polarXY(FRONT_CX, FRONT_CY, rLabel, a);
        var t = document.createElementNS(SVG_NS, 'text');
        t.setAttribute('x', lp.x); t.setAttribute('y', lp.y);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('dominant-baseline', 'middle');
        t.textContent = a + '°';
        wrap.appendChild(t);
      }
      g.appendChild(wrap);
    }
  }

  function buildRefPointer() {
    var top = polarXY(FRONT_CX, FRONT_CY, 240, 0);
    el.refPointer.innerHTML =
      '<polygon points="' + (top.x - 8) + ',' + (top.y - 16) + ' ' + (top.x + 8) + ',' + (top.y - 16) + ' ' + top.x + ',' + (top.y - 4) + '"></polygon>' +
      '<text x="' + top.x + '" y="' + (top.y - 20) + '" text-anchor="middle">REF 0°</text>';
  }

  var DIAMETERS_IN = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

  function buildDiameterSelect() {
    DIAMETERS_IN.forEach(function (d) {
      var opt = document.createElement('option');
      opt.value = String(d);
      opt.textContent = d + '"';
      el.selectD.appendChild(opt);
    });
    el.selectD.value = String(state.rim.diameterIn);
  }

  function buildPresetSelect() {
    var randomOpt = document.createElement('option');
    randomOpt.value = 'random';
    randomOpt.textContent = 'Aleatório';
    el.selectPreset.appendChild(randomOpt);
    WHEEL_PRESETS.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      el.selectPreset.appendChild(opt);
    });
    el.selectPreset.value = 'random';
  }

  /* ================================================================
     GEOMETRIA DINÂMICA (depende de D / estado atual)
     ================================================================ */
  function updateWheelGeometry() {
    var r = radiusForDiameter(state.rim.diameterIn);
    var geom = {
      cx: FRONT_CX, cy: FRONT_CY,
      r: r, tireR: r * 1.16, innerR: r * 0.52, outerR: r * 0.84
    };
    state.geom = geom;

    el.rimCircle.setAttribute('r', geom.r);
    el.tireCircle.setAttribute('r', geom.tireR);
    el.innerPlaneRing.setAttribute('r', geom.innerR);
    el.outerPlaneRing.setAttribute('r', geom.outerR);

    buildSpokes();
    buildValveStem();
    updateDiameterLabel();
  }

  function buildSpokes() {
    var g = el.spokes;
    g.innerHTML = '';
    for (var i = 0; i < 6; i++) {
      var a = i * 60;
      var p1 = polarXY(state.geom.cx, state.geom.cy, 20, a);
      var p2 = polarXY(state.geom.cx, state.geom.cy, state.geom.r * 0.88, a);
      var line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', p1.x); line.setAttribute('y1', p1.y);
      line.setAttribute('x2', p2.x); line.setAttribute('y2', p2.y);
      line.setAttribute('class', 'spoke');
      g.appendChild(line);
    }
  }

  function buildValveStem() {
    var p = polarXY(state.geom.cx, state.geom.cy, state.geom.r * 0.92, 0);
    el.valveStem.innerHTML =
      '<rect x="' + (p.x - 4) + '" y="' + (p.y - 9) + '" width="8" height="15" rx="2"></rect>';
  }

  function updateDiameterLabel() {
    var d = state.rim.diameterIn;
    var mm = (d * 25.4).toFixed(1).replace('.', ',');
    el.labelD.textContent = 'D = ' + d + '" (' + mm + ' mm)';
  }

  /* ================================================================
     VISTA LATERAL: perfil da roda + réguas A e B
     ================================================================ */
  function renderMeasureFigure() {
    var rim = state.rim;
    var h = rimHeightFor(rim.diameterIn);

    el.sideRim.setAttribute('x', rim.internalX);
    el.sideRim.setAttribute('width', Math.max(4, rim.externalX - rim.internalX));
    el.sideRim.setAttribute('y', WHEEL_CY - h / 2);
    el.sideRim.setAttribute('height', h);

    el.sideRimTread.setAttribute('x', rim.internalX);
    el.sideRimTread.setAttribute('width', Math.max(4, rim.externalX - rim.internalX));
    el.sideRimTread.setAttribute('y', WHEEL_CY - h / 2);

    el.planeInternalLine.setAttribute('x1', rim.internalX);
    el.planeInternalLine.setAttribute('x2', rim.internalX);
    el.planeExternalLine.setAttribute('x1', rim.externalX);
    el.planeExternalLine.setAttribute('x2', rim.externalX);
    el.planeInternalLabel.setAttribute('x', rim.internalX);
    el.planeExternalLabel.setAttribute('x', rim.externalX);

    // régua A: sai da flange (referência fixa) até a roda
    var aVal = state.handleA_x - FLANGE_X;
    el.rulerALine.setAttribute('x1', FLANGE_X);
    el.rulerALine.setAttribute('x2', state.handleA_x);
    el.handleA.setAttribute('transform', 'translate(' + state.handleA_x + ',' + WHEEL_CY + ')');
    el.labelA.setAttribute('x', (FLANGE_X + state.handleA_x) / 2);
    el.labelA.textContent = 'A = ' + Math.round(aVal) + ' mm';
    var contactA = Math.abs(state.handleA_x - rim.internalX) <= CONTACT_TOL;
    el.rulerALine.classList.toggle('contact', contactA);
    el.handleA.classList.toggle('contact', contactA);

    // régua B: embaixo da roda
    el.handleBIn.setAttribute('transform', 'translate(' + state.handleBIn_x + ',' + RULER_B_Y + ')');
    el.handleBOut.setAttribute('transform', 'translate(' + state.handleBOut_x + ',' + RULER_B_Y + ')');
    el.calipersLine.setAttribute('x1', state.handleBIn_x);
    el.calipersLine.setAttribute('x2', state.handleBOut_x);
    var bVal = state.handleBOut_x - state.handleBIn_x;
    el.labelB.setAttribute('x', (state.handleBIn_x + state.handleBOut_x) / 2);
    el.labelB.textContent = 'B = ' + Math.round(bVal) + ' mm';
    var contactBIn = Math.abs(state.handleBIn_x - rim.internalX) <= CONTACT_TOL;
    var contactBOut = Math.abs(state.handleBOut_x - rim.externalX) <= CONTACT_TOL;
    el.handleBIn.classList.toggle('contact', contactBIn);
    el.handleBOut.classList.toggle('contact', contactBOut);
    el.calipersLine.classList.toggle('contact', contactBIn && contactBOut);

    if (document.activeElement !== el.inputA) el.inputA.value = Math.round(aVal);
    if (document.activeElement !== el.inputB) el.inputB.value = Math.round(bVal);
  }

  /* ================================================================
     VISTA DA RODA: lateral (padrão) ou frontal (ao mexer nos chumbos)
     ================================================================ */
  function setWheelView(view) {
    if (state.wheelView === view) return;
    state.wheelView = view;
    el.machineSvg.setAttribute('data-wheel-view', view);
    if (view === 'front') {
      el.btnViewToggle.textContent = 'Ver roda de lado';
      el.viewStatus.textContent = 'Vista frontal (posicionando chumbos ao redor do aro)';
    } else {
      el.btnViewToggle.textContent = 'Ver roda de frente';
      el.viewStatus.textContent = 'Vista lateral (mesma posição de montagem de uma máquina real)';
    }
  }

  /* ================================================================
     PESOS (CHUMBOS) — desenho, seleção, arraste
     ================================================================ */
  function isSelected(plane, idx) {
    return !!state.selectedWeight && state.selectedWeight.plane === plane && state.selectedWeight.index === idx;
  }

  function renderWeights() {
    renderWeightGroup('internal', el.weightsInternal, state.geom.innerR);
    renderWeightGroup('external', el.weightsExternal, state.geom.outerR);
    renderWeightLists();
    renderTargetGhosts();
  }

  function renderWeightGroup(plane, container, radius) {
    container.innerHTML = '';
    var list = state.weights[plane];
    for (var idx = 0; idx < list.length; idx++) {
      var w = list[idx];
      var p = polarXY(state.geom.cx, state.geom.cy, radius, w.angle);
      var g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'weight-marker ' + plane + (isSelected(plane, idx) ? ' selected' : ''));
      g.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', 'Chumbo de ' + w.mass + ' gramas a ' + Math.round(w.angle) + ' graus, plano ' + planeLabel(plane));
      var circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('r', '14');
      var text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('y', '1');
      text.textContent = String(w.mass);
      g.appendChild(circle);
      g.appendChild(text);
      container.appendChild(g);
      attachWeightDrag(g, plane, idx, radius);
    }
  }

  function attachWeightDrag(g, plane, index, radius) {
    var dragging = false;
    g.addEventListener('pointerdown', function (e) {
      dragging = true;
      setWheelView('front');
      state.selectedWeight = { plane: plane, index: index };
      try { g.setPointerCapture(e.pointerId); } catch (_) {}
      renderWeightLists();
      markSelectionClasses();
      e.preventDefault();
      e.stopPropagation();
    });
    g.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var pt = svgPointFromEvent(el.machineSvg, e);
      var screenAngle = angleFromPoint(state.geom.cx, state.geom.cy, pt.x, pt.y);
      var rotorMod = ((state.rotorAngleRaw % 360) + 360) % 360;
      var wheelAngle = ((screenAngle - rotorMod) % 360 + 360) % 360;
      state.weights[plane][index].angle = wheelAngle;
      var p = polarXY(state.geom.cx, state.geom.cy, radius, wheelAngle);
      g.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
      renderWeightLists();
      renderTargetGhosts();
    });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      try { g.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
    g.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      var dir = e.key === 'ArrowRight' ? 1 : -1;
      state.selectedWeight = { plane: plane, index: index };
      moveWeight(plane, dir);
    });
  }

  function markSelectionClasses() {
    ['weightsInternal', 'weightsExternal'].forEach(function (id) {
      Array.prototype.forEach.call(el[id].children, function (g) {
        var plane = g.classList.contains('internal') ? 'internal' : 'external';
        var idx = Array.prototype.indexOf.call(el[id].children, g);
        g.classList.toggle('selected', isSelected(plane, idx));
      });
    });
  }

  function renderTargetGhosts() {
    el.targetGhosts.innerHTML = '';
    ['internal', 'external'].forEach(function (plane) {
      var rem = computeRemaining(plane);
      if (rem.mass < 0.5) return;
      var radius = plane === 'internal' ? state.geom.innerR : state.geom.outerR;
      var p0 = polarXY(state.geom.cx, state.geom.cy, radius, rem.angle);
      var p1 = polarXY(state.geom.cx, state.geom.cy, radius + 30, rem.angle);
      var g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'target-ghost ' + plane);
      var line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', p0.x); line.setAttribute('y1', p0.y);
      line.setAttribute('x2', p1.x); line.setAttribute('y2', p1.y);
      var text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', p1.x); text.setAttribute('y', p1.y);
      text.setAttribute('text-anchor', 'middle');
      text.textContent = Math.round(rem.mass) + 'g';
      g.appendChild(line);
      g.appendChild(text);
      el.targetGhosts.appendChild(g);
    });
  }

  function renderWeightLists() {
    fillList(el.listInternal, 'internal');
    fillList(el.listExternal, 'external');
  }

  function fillList(ul, plane) {
    ul.innerHTML = '';
    state.weights[plane].forEach(function (w, idx) {
      var li = document.createElement('li');
      if (isSelected(plane, idx)) li.classList.add('selected');
      var span = document.createElement('span');
      span.textContent = w.mass + ' g @ ' + Math.round(w.angle) + '°';
      li.appendChild(span);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '×';
      btn.setAttribute('aria-label', 'Remover este chumbo');
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        removeWeightAt(plane, idx);
      });
      li.appendChild(btn);
      li.addEventListener('click', function () {
        setWheelView('front');
        state.selectedWeight = { plane: plane, index: idx };
        renderWeights();
      });
      ul.appendChild(li);
    });
  }

  function addWeight(plane) {
    setWheelView('front');
    var mass = state.pendingMass[plane];
    state.weights[plane].push({ mass: mass, angle: 180 });
    state.selectedWeight = { plane: plane, index: state.weights[plane].length - 1 };
    renderWeights();
    setFeedback('Chumbo de ' + mass + ' g adicionado no plano ' + planeLabel(plane) + '. Posicione-o e gire a roda para medir novamente.', 'neutral');
  }

  function removeWeight(plane) {
    setWheelView('front');
    if (!state.weights[plane].length) return;
    state.weights[plane].pop();
    if (state.selectedWeight && state.selectedWeight.plane === plane &&
        state.selectedWeight.index >= state.weights[plane].length) {
      state.selectedWeight = null;
    }
    renderWeights();
  }

  function removeWeightAt(plane, idx) {
    state.weights[plane].splice(idx, 1);
    state.selectedWeight = null;
    renderWeights();
  }

  function moveWeight(plane, dir) {
    setWheelView('front');
    var list = state.weights[plane];
    if (!list.length) {
      setFeedback('Não há chumbo no plano ' + planeLabel(plane) + ' para mover. Adicione um chumbo primeiro.', 'neutral');
      return;
    }
    var idx = (state.selectedWeight && state.selectedWeight.plane === plane) ? state.selectedWeight.index : list.length - 1;
    var w = list[idx];
    w.angle = ((w.angle + dir * MOVE_STEP_DEG) % 360 + 360) % 360;
    state.selectedWeight = { plane: plane, index: idx };
    renderWeights();
  }

  /* ================================================================
     GIRAR A RODA / MEDIÇÃO
     A animação é feita 100% via requestAnimationFrame, escrevendo o
     atributo "transform" a cada quadro. Não há transição CSS em
     #wheelRotor: misturar as duas fazia o navegador tentar animar
     cada quadro por conta própria, e a roda "disparava" na tela em
     vez de girar no lugar.
     ================================================================ */
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function animateRotor(fromDeg, toDeg, duration, onDone) {
    var start = null;
    function frame(now) {
      if (start === null) start = now;
      var t = Math.min(1, (now - start) / duration);
      var deg = fromDeg + (toDeg - fromDeg) * easeOutCubic(t);
      el.wheelRotor.setAttribute('transform', 'rotate(' + deg + ' ' + state.geom.cx + ' ' + state.geom.cy + ')');
      if (t < 1) requestAnimationFrame(frame);
      else onDone();
    }
    requestAnimationFrame(frame);
  }

  function setStatusLed(busy) {
    el.statusLed.classList.toggle('busy', busy);
    el.miniStatus.textContent = busy ? 'GIRANDO...' : 'PRONTA';
  }

  function handleGirar() {
    if (state.spinning) return;
    setWheelView('front');
    state.spinning = true;
    el.btnGirar.disabled = true;
    setStatusLed(true);

    var prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var fromDeg = state.rotorAngleRaw;
    var currentMod = ((fromDeg % 360) + 360) % 360;
    var landingMod = randInt(0, 359);
    var spins = randInt(3, 4);
    var toDeg = fromDeg + spins * 360 + ((landingMod - currentMod + 360) % 360);

    function finish() {
      state.rotorAngleRaw = toDeg;
      state.spinning = false;
      el.btnGirar.disabled = false;
      setStatusLed(false);
      afterSpinMeasure();
    }

    if (prefersReduced) {
      el.wheelRotor.setAttribute('transform', 'rotate(' + toDeg + ' ' + state.geom.cx + ' ' + state.geom.cy + ')');
      finish();
    } else {
      animateRotor(fromDeg, toDeg, 1100, finish);
    }
  }

  function afterSpinMeasure() {
    var prevInt = state.lastReading.internal;
    var prevExt = state.lastReading.external;
    var curInt = computeRemaining('internal');
    var curExt = computeRemaining('external');

    updateDisplay(curInt, curExt);
    updateFeedback(prevInt, curInt, prevExt, curExt);

    state.lastReading = { internal: curInt, external: curExt };
    state.hasSpun = true;
    renderTargetGhosts();
  }

  function updateDisplay(intR, extR) {
    var tol = state.tolerance;
    var balancedInt = intR.mass <= tol;
    var balancedExt = extR.mass <= tol;

    el.dispMassInt.textContent = Math.round(intR.mass) + ' g';
    el.dispAngleInt.textContent = balancedInt ? '—' : Math.round(intR.angle) + '°';
    el.dispMassExt.textContent = Math.round(extR.mass) + ' g';
    el.dispAngleExt.textContent = balancedExt ? '—' : Math.round(extR.angle) + '°';

    if (balancedInt && balancedExt) {
      el.displayTitle.textContent = 'RODA OK — BALANCEADA';
      el.display.classList.add('is-balanced');
    } else {
      el.displayTitle.textContent = 'NOVA MEDIÇÃO';
      el.display.classList.remove('is-balanced');
    }
  }

  function updateFeedback(prevInt, curInt, prevExt, curExt) {
    var tol = state.tolerance;
    var balancedInt = curInt.mass <= tol;
    var balancedExt = curExt.mass <= tol;

    if (balancedInt && balancedExt) {
      setFeedback('Roda balanceada! Os planos interno e externo estão dentro da tolerância de ' + tol + ' g.', 'good');
      return;
    }

    var parts = [];
    var pairs = [
      { plane: 'internal', prev: prevInt, cur: curInt, ok: balancedInt },
      { plane: 'external', prev: prevExt, cur: curExt, ok: balancedExt }
    ];
    var worsened = false;
    pairs.forEach(function (p) {
      if (p.ok) return;
      if (!p.prev) {
        parts.push('Desbalanceamento detectado no plano ' + planeLabel(p.plane) + '.');
        return;
      }
      var diff = p.cur.mass - p.prev.mass;
      if (Math.abs(diff) < 0.6) {
        parts.push('Sem alteração perceptível no plano ' + planeLabel(p.plane) + '.');
      } else if (diff < 0) {
        parts.push('O chumbo reduziu o desbalanceamento ' + planeLabel(p.plane) + '.');
      } else {
        parts.push('Você aumentou o desbalanceamento ' + planeLabel(p.plane) + '.');
        worsened = true;
      }
    });
    setFeedback(parts.join(' '), worsened ? 'bad' : 'neutral');
  }

  function setFeedback(msg, tone) {
    el.feedback.textContent = msg;
    el.feedback.classList.remove('feedback-good', 'feedback-bad', 'feedback-neutral');
    if (tone) el.feedback.classList.add('feedback-' + tone);
  }

  /* ================================================================
     GERAR EXERCÍCIO (um único botão + menu de padrões de roda)
     ================================================================ */
  function generateUnbalance() {
    return {
      internal: { mass: randInt(10, MASS_MAX), angle: randInt(0, 359) },
      external: { mass: randInt(10, MASS_MAX), angle: randInt(0, 359) }
    };
  }

  function pickPreset() {
    var presetId = el.selectPreset.value;
    if (presetId === 'random') {
      return WHEEL_PRESETS[randInt(0, WHEEL_PRESETS.length - 1)];
    }
    for (var i = 0; i < WHEEL_PRESETS.length; i++) {
      if (WHEEL_PRESETS[i].id === presetId) return WHEEL_PRESETS[i];
    }
    return WHEEL_PRESETS[0];
  }

  function generateExercise() {
    var preset = pickPreset();
    var diameterIn = preset.diameters[randInt(0, preset.diameters.length - 1)];

    setWheelView('side');
    state.unbalance = generateUnbalance();
    state.weights = { internal: [], external: [] };
    state.selectedWeight = null;
    state.lastReading = { internal: null, external: null };
    state.hasSpun = false;
    state.rotorAngleRaw = 0;
    el.wheelRotor.setAttribute('transform', 'rotate(0 ' + state.geom.cx + ' ' + state.geom.cy + ')');

    state.rim.internalX = FLANGE_X + randInt(70, 220);
    state.rim.externalX = state.rim.internalX + randInt(50, 180);
    state.handleA_x = FLANGE_X + 20;
    state.handleBIn_x = FLANGE_X + 10;
    state.handleBOut_x = FLANGE_X + 40;

    state.rim.diameterIn = diameterIn;
    el.selectD.value = String(diameterIn);

    updateWheelGeometry();
    renderMeasureFigure();
    renderWeights();

    el.displayTitle.textContent = 'AGUARDANDO';
    el.display.classList.remove('is-balanced');
    el.dispMassInt.textContent = '-- g'; el.dispAngleInt.textContent = '--°';
    el.dispMassExt.textContent = '-- g'; el.dispAngleExt.textContent = '--°';
    setFeedback('Meça a roda e clique em GIRAR para iniciar.', null);

    showToast('Novo exercício: ' + preset.label + '. Meça A, B e D e balanceie os dois planos.');
  }

  /* ================================================================
     UI GERAL (modo, toast, steppers, inputs)
     ================================================================ */
  var toastTimer = null;
  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 4200);
  }

  function setMode(mode) {
    state.mode = mode;
    el.app.dataset.mode = mode;
    el.modeLearnBtn.setAttribute('aria-pressed', String(mode === 'learn'));
    el.modeSimBtn.setAttribute('aria-pressed', String(mode === 'sim'));
  }

  function makeDraggable(handleEl, opts) {
    var dragging = false;
    handleEl.style.touchAction = 'none';
    handleEl.addEventListener('pointerdown', function (e) {
      dragging = true;
      try { handleEl.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    handleEl.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var pt = svgPointFromEvent(el.machineSvg, e);
      var x = clamp(pt.x, opts.min, opts.max);
      opts.setX(x);
      renderMeasureFigure();
    });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      try { handleEl.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    handleEl.addEventListener('pointerup', end);
    handleEl.addEventListener('pointercancel', end);
    handleEl.addEventListener('keydown', function (e) {
      var cur = opts.getX();
      if (e.key === 'ArrowLeft') cur -= 5;
      else if (e.key === 'ArrowRight') cur += 5;
      else return;
      e.preventDefault();
      opts.setX(clamp(cur, opts.min, opts.max));
      renderMeasureFigure();
    });
  }

  function bindEvents() {
    el.modeLearnBtn.addEventListener('click', function () { setMode('learn'); });
    el.modeSimBtn.addEventListener('click', function () { setMode('sim'); });

    el.btnExercicio.addEventListener('click', generateExercise);

    el.btnViewToggle.addEventListener('click', function () {
      setWheelView(state.wheelView === 'side' ? 'front' : 'side');
    });

    el.btnGirar.addEventListener('click', handleGirar);

    makeDraggable(el.handleA, {
      getX: function () { return state.handleA_x; },
      setX: function (x) { state.handleA_x = x; },
      min: FLANGE_X, max: FLANGE_X + A_MAX
    });
    makeDraggable(el.handleBIn, {
      getX: function () { return state.handleBIn_x; },
      setX: function (x) { state.handleBIn_x = x; },
      min: FLANGE_X, max: FLANGE_X + B_MAX
    });
    makeDraggable(el.handleBOut, {
      getX: function () { return state.handleBOut_x; },
      setX: function (x) { state.handleBOut_x = x; },
      min: FLANGE_X, max: FLANGE_X + B_MAX * 2
    });

    el.inputA.addEventListener('input', function () {
      var v = parseFloat(el.inputA.value);
      if (isNaN(v)) return;
      state.handleA_x = FLANGE_X + clamp(v, A_MIN, A_MAX);
      renderMeasureFigure();
    });
    el.inputB.addEventListener('input', function () {
      var v = parseFloat(el.inputB.value);
      if (isNaN(v)) return;
      state.handleBOut_x = state.handleBIn_x + clamp(v, B_MIN, B_MAX);
      renderMeasureFigure();
    });

    el.selectD.addEventListener('change', function () {
      state.rim.diameterIn = parseInt(el.selectD.value, 10);
      updateWheelGeometry();
      renderMeasureFigure();
      renderWeights();
    });

    el.inputTolerance.addEventListener('input', function () {
      var v = parseInt(el.inputTolerance.value, 10);
      if (isNaN(v)) v = 5;
      state.tolerance = clamp(v, 1, 20);
      if (state.hasSpun) updateDisplay(state.lastReading.internal, state.lastReading.external);
    });

    Array.prototype.forEach.call(document.querySelectorAll('.stepper-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var plane = btn.getAttribute('data-step-plane');
        var dir = parseInt(btn.getAttribute('data-step-dir'), 10);
        var v = clamp(state.pendingMass[plane] + dir * MASS_STEP, MASS_MIN, MASS_MAX);
        state.pendingMass[plane] = v;
        (plane === 'internal' ? el.stepValInt : el.stepValExt).textContent = v + ' g';
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-action]'), function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.getAttribute('data-action');
        var plane = btn.getAttribute('data-plane');
        if (action === 'add') addWeight(plane);
        else if (action === 'remove') removeWeight(plane);
        else if (action === 'move') moveWeight(plane, parseInt(btn.getAttribute('data-dir'), 10));
      });
    });
  }

  /* ================================================================
     INICIALIZAÇÃO
     ================================================================ */
  function init() {
    cacheRefs();
    buildDiameterSelect();
    buildPresetSelect();
    buildRulerTicks(el.rulerATicks, FLANGE_X, WHEEL_CY, -1);
    buildRulerTicks(el.rulerBTicks, FLANGE_X, RULER_B_Y, 1);
    buildAngleTicks();
    buildRefPointer();
    updateWheelGeometry();
    setWheelView('side');
    el.machineSvg.setAttribute('data-wheel-view', 'side');
    generateExercise();
    bindEvents();
    setMode('sim');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
