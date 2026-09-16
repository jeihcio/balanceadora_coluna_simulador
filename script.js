(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* ================================================================
     CONSTANTES
     ================================================================ */
  var MASS_STEP = 5;                 // toda massa (desbalanceamento e chumbos) é múltiplo de 5
  var UNBALANCE_MIN = 10, UNBALANCE_MAX = 80; // faixa do desbalanceamento sorteado (múltiplos de 5)
  var WEIGHT_VALUES = [5, 10, 20, 25]; // únicos valores de chumbo disponíveis na máquina
  var A_MIN = 50, A_MAX = 300;
  var B_MIN = 50, B_MAX = 300;
  var CONTACT_TOL = 9;      // mm/px (escala 1:1) para considerar "encostou"
  var PLANE_LABEL_TIGHT_GAP = 90; // abaixo disso (px), os rótulos INTERNO/EXTERNO abrem para fora p/ não colidir
  var FLANGE_X = 190;       // referência fixa da máquina (início da medida A)
  var WHEEL_CY = 335;       // altura comum: régua A, perfil lateral e centro da roda de frente
  var RULER_B_Y = 455;      // altura da régua B (embaixo da roda)
  var FRONT_CX = 430, FRONT_CY = 335; // centro fixo da roda quando vista de frente
  var GUIDE_CX = 85, GUIDE_CY = 80, GUIDE_R = 56; // relógio didático (guia de posicionamento)

  var WHEEL_PRESETS = [
    { id: 'aro13', label: 'Aro 13"', diameters: [13] },
    { id: 'aro14', label: 'Aro 14"', diameters: [14] },
    { id: 'aro15', label: 'Aro 15"', diameters: [15] },
    { id: 'aro16', label: 'Aro 16"', diameters: [16] },
    { id: 'aro17', label: 'Aro 17"', diameters: [17] },
    { id: 'aro18', label: 'Aro 18"', diameters: [18] },
    { id: 'aro19', label: 'Aro 19"', diameters: [19] },
    { id: 'aro20', label: 'Aro 20"', diameters: [20] },
    { id: 'aro21', label: 'Aro 21"', diameters: [21] },
    { id: 'aro22', label: 'Aro 22"', diameters: [22] }
  ];

  /* ================================================================
     ESTADO DA SIMULAÇÃO
     ================================================================ */
  var state = {
    mode: 'learn',
    wheelView: 'side',
    tolerance: 15, // tolerância padrão = soma dos dois planos

    handleA_x: FLANGE_X + 20,
    handleBIn_x: FLANGE_X + 10,
    handleBOut_x: FLANGE_X + 40,

    rim: { internalX: 0, externalX: 0, diameterIn: 17 },
    geom: { cx: FRONT_CX, cy: FRONT_CY, r: 150, tireR: 174, innerR: 78, outerR: 126 },

    rotorAngleRaw: 0,
    spinning: false,
    hasSpun: false,

    unbalance: { internal: { mass: 45, angle: 40 }, external: { mass: 35, angle: 200 } },
    // cada plano tem só um "conjunto" de chumbos: todos colados um no
    // outro, no mesmo ângulo (peças reais coladas na roda não flutuam
    // separadas) — angle é a posição do conjunto, pieces é a lista das
    // gramaturas individuais que o compõem.
    weights: { internal: { angle: 0, pieces: [] }, external: { angle: 0, pieces: [] } },
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

  // arredonda para o múltiplo de "step" mais próximo (0 continua 0)
  function roundToStep(value, step) {
    return Math.round(value / step) * step;
  }

  // massa total dos chumbos de um plano (todos ficam colados um no outro,
  // no mesmo ângulo — a máquina trata o conjunto como uma peça só)
  function planeTotalMass(plane) {
    return state.weights[plane].pieces.reduce(function (a, b) { return a + b; }, 0);
  }

  // desbalanceamento restante de um plano = alvo - chumbos colocados
  // a leitura da máquina é sempre múltiplo de 5 g (só existe chumbo nesses
  // valores, então não faz sentido exibir uma leitura "quebrada")
  function computeRemaining(plane) {
    var target = toVector(state.unbalance[plane].mass, state.unbalance[plane].angle);
    var wp = state.weights[plane];
    var placed = toVector(planeTotalMass(plane), wp.angle);
    var result = fromVector(subVec(target, placed));
    result.mass = roundToStep(result.mass, MASS_STEP);
    return result;
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

  // ponto num círculo com a convenção de graus da MÁQUINA: 0° no lado
  // esquerdo (9h), 90° no topo (12h), 180° na direita (3h), 270° embaixo
  // (6h) — crescendo no sentido horário. É só um deslocamento de fase de
  // -90° em relação à parametrização "matemática" padrão (0°=topo).
  function polarXY(cx, cy, r, angleDeg) {
    var rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
  }

  // inverso de polarXY: converte um ponto de volta para ângulo (0-359°),
  // já na mesma convenção (0°=esquerda/9h, 90°=topo/12h, ...)
  function angleFromPoint(cx, cy, x, y) {
    var a = (Math.atan2(x - cx, cy - y) * 180) / Math.PI + 90;
    return ((a % 360) + 360) % 360;
  }

  // traduz um ângulo (convenção da máquina, 90°=12h) pra hora de relógio —
  // do jeito que um borracheiro pensa a posição na roda. 30° = 1 hora;
  // quando não cai numa hora cheia, mostra minutos (ex.: 40° -> "10:20").
  function hourLabel(angleDeg) {
    var h = ((angleDeg - 90) / 30) % 12;
    if (h < 0) h += 12;
    var whole = Math.floor(h);
    var minutes = Math.round((h - whole) * 60);
    if (minutes === 60) { minutes = 0; whole += 1; }
    whole = whole % 12;
    if (whole === 0) whole = 12;
    return minutes === 0 ? (whole + 'h') : (whole + ':' + (minutes < 10 ? '0' : '') + minutes);
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

  // menor distância angular entre dois ângulos (sempre 0-180, sem sinal)
  function angularDist(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  // diferença angular COM sinal, de b para a, no intervalo (-180, 180]
  // positivo = "a" está no sentido horário a partir de "b"
  function angularSignedDiff(a, b) {
    var d = (a - b) % 360;
    if (d < -180) d += 360;
    if (d > 180) d -= 360;
    return d;
  }

  // ângulo (referencial da roda) que está bem no topo (90°, marca REF) agora,
  // considerando a rotação atual do rotor — é aí que um chumbo novo "nasce"
  function currentTopWheelAngle() {
    var rotorMod = ((state.rotorAngleRaw % 360) + 360) % 360;
    return (((90 - rotorMod) % 360) + 360) % 360;
  }

  /* ================================================================
     REFERÊNCIAS DOM
     ================================================================ */
  var el = {};
  function q(id) { return document.getElementById(id); }

  function cacheRefs() {
    [
      'app', 'toast',
      'selectPreset', 'btnExercicio',
      'btnViewToggle', 'viewStatus',
      'machineSvg', 'sideRim', 'sideRimTread',
      'planeInternalLine', 'planeExternalLine', 'planeInternalLabel', 'planeExternalLabel',
      'rulerALine', 'rulerATicks', 'handleA', 'labelA',
      'rulerBTicks', 'calipersLine', 'handleBIn', 'handleBOut', 'labelB',
      'inputA', 'inputB', 'selectD', 'labelD',
      'angleTicks', 'wheelRotor', 'tireCircle', 'rimCircle', 'spokes',
      'outerPlaneRing', 'innerPlaneRing', 'valveStem', 'targetGhosts',
      'weightsInternal', 'weightsExternal', 'refPointer',
      'fieldZonesMachine',
      'btnGirar',
      'machineReadout', 'dispMassInt', 'dispAngleInt', 'dispMassExt', 'dispAngleExt',
      'ledRowInt', 'ledRowExt',
      'feedback', 'inputTolerance',
      'stepValInt', 'stepValExt', 'listInternal', 'listExternal',
      'guideTicks', 'guideMarkerInternal', 'guideMarkerExternal',
      'guideTextInternal', 'guideTextExternal',
      'balancedModal', 'balancedModalMsg', 'btnBalancedOk'
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
        var anchor = 'middle';
        // a etiqueta de 0° (9h) fica bem entre a coluna e a roda: com a hora
        // deixando o texto mais largo, um anchor "middle" na posição radial
        // normal cai em cima da barra vermelha da coluna. Sobe (foge da
        // flange "REF. MÁQUINA") e ancora pela esquerda, num x fixo já
        // livre da coluna, crescendo só pra direita.
        if (a === 0) {
          lp.y -= 46;
          lp.x = 168;
          anchor = 'start';
        }
        var t = document.createElementNS(SVG_NS, 'text');
        t.setAttribute('x', lp.x); t.setAttribute('y', lp.y);
        t.setAttribute('text-anchor', anchor);
        t.setAttribute('dominant-baseline', 'middle');
        t.textContent = a + '° (' + hourLabel(a) + ')';
        wrap.appendChild(t);
      }
      g.appendChild(wrap);
    }
  }

  function buildRefPointer() {
    var top = polarXY(FRONT_CX, FRONT_CY, 240, 90); // 90° = topo (12h) na convenção da máquina
    el.refPointer.innerHTML =
      '<polygon points="' + (top.x - 8) + ',' + (top.y - 16) + ' ' + (top.x + 8) + ',' + (top.y - 16) + ' ' + top.x + ',' + (top.y - 4) + '"></polygon>' +
      '<text x="' + top.x + '" y="' + (top.y - 20) + '" text-anchor="middle">REF 90° (12h)</text>';
  }

  /* ================================================================
     RELÓGIO DIDÁTICO (guia de posicionamento do chumbo)
     Reaproveita a mesma convenção da roda de frente: 12h = REF (90°, topo),
     ângulos crescendo no sentido horário (12h -> 3h -> 6h -> 9h).
     ================================================================ */
  function buildGuideTicks() {
    var g = el.guideTicks;
    g.innerHTML = '';
    var hours = [{ h: 12, a: 90 }, { h: 3, a: 180 }, { h: 6, a: 270 }, { h: 9, a: 0 }];
    hours.forEach(function (tick) {
      var p1 = polarXY(GUIDE_CX, GUIDE_CY, GUIDE_R - 8, tick.a);
      var p2 = polarXY(GUIDE_CX, GUIDE_CY, GUIDE_R + 2, tick.a);
      var pLabel = polarXY(GUIDE_CX, GUIDE_CY, GUIDE_R + 14, tick.a);
      var line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', p1.x); line.setAttribute('y1', p1.y);
      line.setAttribute('x2', p2.x); line.setAttribute('y2', p2.y);
      line.setAttribute('class', 'guide-tick-line');
      g.appendChild(line);
      var t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', pLabel.x); t.setAttribute('y', pLabel.y);
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dominant-baseline', 'middle');
      t.setAttribute('class', 'guide-tick-text');
      t.textContent = tick.h + 'h';
      g.appendChild(t);
    });
  }

  // atualiza o relógio didático + o veredito de cada plano: leve, pesado ou
  // fora do lugar — o "diagrama de campo" clássico de oficina, comparando o
  // alvo real (computeRemaining) com o ÚLTIMO chumbo colocado nesse plano.
  // Em modo Aprendizado também revela o alvo exato (anel tracejado), como
  // conferência; em Simulação só o veredito (igual numa máquina de verdade).
  function renderGuide() {
    renderGuidePlane('internal', el.guideMarkerInternal, el.guideTextInternal);
    renderGuidePlane('external', el.guideMarkerExternal, el.guideTextExternal);
  }

  // veredito do conjunto de chumbos de um plano (todos colados, mesmo
  // ângulo): leve, pesado, fora do lugar (mover) ou já balanceado —
  // compara o alvo real restante (computeRemaining) com o ângulo do
  // conjunto. Usado tanto no painel "Diagrama de campo" quanto na cor da
  // etiqueta "X g @ Y°" na lista de chumbos (em vez de pintar a própria
  // roda, que só causava confusão).
  function computeVerdict(plane) {
    var wp = state.weights[plane];
    if (!state.hasSpun || !wp.pieces.length) return null;
    var rem = computeRemaining(plane);
    if (rem.mass === 0) return { key: 'balanced', rem: rem };
    var diff = angularDist(rem.angle, wp.angle);
    var signed = angularSignedDiff(rem.angle, wp.angle);
    if (diff <= 30) return { key: 'leve', rem: rem };
    if (diff >= 150) return { key: 'pesado', rem: rem };
    return { key: 'mover', dir: signed > 0 ? 1 : -1, rem: rem };
  }

  function renderGuidePlane(plane, markerEl, textEl) {
    var planeName = plane === 'internal' ? 'Interno' : 'Externo';
    var wp = state.weights[plane];

    if (!state.hasSpun) {
      markerEl.innerHTML = '';
      textEl.innerHTML = '<strong>' + planeName + ':</strong> gire a roda para começar a procurar o ponto.';
      return;
    }
    if (wp.pieces.length === 0) {
      markerEl.innerHTML = '';
      textEl.innerHTML = '<strong>' + planeName + ':</strong> gire a roda até as bolinhas acenderem, depois clique em + Chumbo.';
      return;
    }

    var clusterPoint = polarXY(GUIDE_CX, GUIDE_CY, GUIDE_R, wp.angle);
    var dotsHtml = '<circle cx="' + clusterPoint.x + '" cy="' + clusterPoint.y + '" r="6" class="guide-marker-dot"></circle>';

    var verdict = computeVerdict(plane);
    var verdictHtml;
    if (verdict.key === 'balanced') {
      verdictHtml = 'balanceado — nenhum ajuste a mais necessário.';
    } else {
      if (verdict.key === 'leve') {
        verdictHtml = '<strong>leve</strong> — ainda faltam ' + verdict.rem.mass + ' g bem onde ele está; some outro chumbo do lado ou troque por um mais pesado.';
      } else if (verdict.key === 'pesado') {
        verdictHtml = '<strong>pesado</strong> — tem peso sobrando do lado oposto; troque por um chumbo mais leve.';
      } else {
        var dirText = verdict.dir > 0 ? 'avance o chumbo (Mover ►)' : 'recue o chumbo (◄ Mover)';
        verdictHtml = '<strong>fora do lugar</strong> — o peso está OK, mas ' + dirText + '.';
      }
      // informações do modo Aprendizado ficam sempre visíveis
      var pTarget = polarXY(GUIDE_CX, GUIDE_CY, GUIDE_R, verdict.rem.angle);
      dotsHtml += '<circle cx="' + pTarget.x + '" cy="' + pTarget.y + '" r="9" class="guide-target-ring"></circle>';
      verdictHtml += ' <span class="guide-exact">(conferindo: alvo real ' + verdict.rem.mass + ' g a ' + Math.round(verdict.rem.angle) + '° / ' + hourLabel(verdict.rem.angle) + ')</span>';
    }

    markerEl.innerHTML = dotsHtml;
    textEl.innerHTML = '<strong>' + planeName + ':</strong> ' + verdictHtml;
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
    randomOpt.textContent = 'Aro aleatório';
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

    // planos podem ficar próximos (roda estreita): se os rótulos centralizados
    // fossem colidir, cada um "abre" para o lado de fora da própria linha
    // em vez de ficar centralizado sobre ela.
    var planeGap = rim.externalX - rim.internalX;
    var labelsTight = planeGap < PLANE_LABEL_TIGHT_GAP;
    el.planeInternalLabel.setAttribute('text-anchor', labelsTight ? 'end' : 'middle');
    el.planeInternalLabel.setAttribute('x', labelsTight ? rim.internalX - 6 : rim.internalX);
    el.planeExternalLabel.setAttribute('text-anchor', labelsTight ? 'start' : 'middle');
    el.planeExternalLabel.setAttribute('x', labelsTight ? rim.externalX + 6 : rim.externalX);

    // régua A: sai da flange (referência fixa) até a roda
    // Dentro da tolerância, a seta "encaixa" exatamente em cima da linha do
    // plano (nada de ficar verde com um resto de folga visível).
    var contactA = Math.abs(state.handleA_x - rim.internalX) <= CONTACT_TOL;
    var drawA_x = contactA ? rim.internalX : state.handleA_x;
    var aVal = drawA_x - FLANGE_X;
    el.rulerALine.setAttribute('x1', FLANGE_X);
    el.rulerALine.setAttribute('x2', drawA_x);
    el.handleA.setAttribute('transform', 'translate(' + drawA_x + ',' + WHEEL_CY + ')');
    el.labelA.setAttribute('x', (FLANGE_X + drawA_x) / 2);
    el.labelA.textContent = 'A = ' + Math.round(aVal) + ' mm';
    el.rulerALine.classList.toggle('contact', contactA);
    el.handleA.classList.toggle('contact', contactA);

    // régua B: embaixo da roda
    var contactBIn = Math.abs(state.handleBIn_x - rim.internalX) <= CONTACT_TOL;
    var contactBOut = Math.abs(state.handleBOut_x - rim.externalX) <= CONTACT_TOL;
    var drawBIn_x = contactBIn ? rim.internalX : state.handleBIn_x;
    var drawBOut_x = contactBOut ? rim.externalX : state.handleBOut_x;
    el.handleBIn.setAttribute('transform', 'translate(' + drawBIn_x + ',' + RULER_B_Y + ')');
    el.handleBOut.setAttribute('transform', 'translate(' + drawBOut_x + ',' + RULER_B_Y + ')');
    el.calipersLine.setAttribute('x1', drawBIn_x);
    el.calipersLine.setAttribute('x2', drawBOut_x);
    var bVal = drawBOut_x - drawBIn_x;
    el.labelB.setAttribute('x', (drawBIn_x + drawBOut_x) / 2);
    el.labelB.textContent = 'B = ' + Math.round(bVal) + ' mm';
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
    renderGuide();
  }

  // raio visual de cada chumbo, correlacionado com a gramatura (chumbos
  // maiores em massa nascem visivelmente maiores, ainda que a diferença
  // seja pequena) — mapeia o intervalo dos valores reais de chumbo
  // disponíveis (WEIGHT_VALUES) num intervalo de raios em px.
  var PIECE_MASS_MIN = Math.min.apply(null, WEIGHT_VALUES);
  var PIECE_MASS_MAX = Math.max.apply(null, WEIGHT_VALUES);
  var PIECE_RADIUS_MIN = 10, PIECE_RADIUS_MAX = 16;
  function pieceRadius(mass) {
    var span = PIECE_MASS_MAX - PIECE_MASS_MIN;
    var t = span > 0 ? clamp((mass - PIECE_MASS_MIN) / span, 0, 1) : 0;
    return PIECE_RADIUS_MIN + t * (PIECE_RADIUS_MAX - PIECE_RADIUS_MIN);
  }

  // vetor unitário tangente ao círculo do plano no ângulo dado, na direção
  // de ângulo crescente — usado pra enfileirar os chumbos de um conjunto
  // lado a lado (como clipes de chumbo reais, colados um no outro).
  function tangentUnit(angleDeg) {
    var rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: Math.cos(rad), y: Math.sin(rad) };
  }

  // deslocamento (em px, ao longo da tangente) do centro de cada peça,
  // pra formar uma fileira encostada uma na outra e centralizada no
  // ângulo do conjunto.
  function layoutPieceOffsets(pieces) {
    var radii = pieces.map(pieceRadius);
    var totalWidth = radii.reduce(function (sum, r) { return sum + 2 * r; }, 0);
    var offsets = [];
    var cursor = -totalWidth / 2;
    for (var i = 0; i < radii.length; i++) {
      offsets.push(cursor + radii[i]);
      cursor += 2 * radii[i];
    }
    return offsets;
  }

  function positionClusterEls(groupEls, offsets, radius, angleDeg) {
    var anchor = polarXY(state.geom.cx, state.geom.cy, radius, angleDeg);
    var tangent = tangentUnit(angleDeg);
    for (var i = 0; i < groupEls.length; i++) {
      var x = anchor.x + tangent.x * offsets[i];
      var y = anchor.y + tangent.y * offsets[i];
      groupEls[i].setAttribute('transform', 'translate(' + x + ',' + y + ')');
    }
  }

  // os chumbos de um plano são um conjunto ÚNICO (mesmo ângulo pra todos —
  // a máquina não sabe separar chumbos colados lado a lado): desenhados
  // encostados um no outro, e arrastar/mover qualquer peça arrasta/move o
  // conjunto inteiro junto.
  function renderWeightGroup(plane, container, radius) {
    container.innerHTML = '';
    var wp = state.weights[plane];
    var pieces = wp.pieces;
    if (!pieces.length) return;

    var offsets = layoutPieceOffsets(pieces);
    var groupEls = [];
    for (var idx = 0; idx < pieces.length; idx++) {
      var mass = pieces[idx];
      var r = pieceRadius(mass);
      var g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'weight-marker ' + plane + (isSelected(plane, idx) ? ' selected' : ''));
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label',
        'Chumbo de ' + mass + ' gramas, parte de um conjunto de ' + pieces.length +
        ' no plano ' + planeLabel(plane) + ', a ' + Math.round(wp.angle) + ' graus (' + hourLabel(wp.angle) + ')');
      var circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('r', String(r));
      var text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('y', '1');
      text.setAttribute('font-size', Math.max(7, r * 0.65).toFixed(1));
      text.textContent = String(mass);
      g.appendChild(circle);
      g.appendChild(text);
      container.appendChild(g);
      groupEls.push(g);
    }
    positionClusterEls(groupEls, offsets, radius, wp.angle);
    attachClusterDrag(plane, radius, groupEls, offsets);
  }

  function attachClusterDrag(plane, radius, groupEls, offsets) {
    var dragging = false;
    function onMove(e) {
      if (!dragging) return;
      var pt = svgPointFromEvent(el.machineSvg, e);
      var screenAngle = angleFromPoint(state.geom.cx, state.geom.cy, pt.x, pt.y);
      var rotorMod = ((state.rotorAngleRaw % 360) + 360) % 360;
      var wheelAngle = ((screenAngle - rotorMod) % 360 + 360) % 360;
      state.weights[plane].angle = wheelAngle;
      positionClusterEls(groupEls, offsets, radius, wheelAngle);
      renderWeightLists();
      renderTargetGhosts();
      renderGuide();
    }
    function onEnd(e) {
      if (!dragging) return;
      dragging = false;
      groupEls.forEach(function (g) { try { g.releasePointerCapture(e.pointerId); } catch (_) {} });
    }
    groupEls.forEach(function (g, idx) {
      g.addEventListener('pointerdown', function (e) {
        dragging = true;
        setWheelView('front');
        state.selectedWeight = { plane: plane, index: idx };
        try { g.setPointerCapture(e.pointerId); } catch (_) {}
        renderWeightLists();
        markSelectionClasses();
        e.preventDefault();
        e.stopPropagation();
      });
      g.addEventListener('pointermove', onMove);
      g.addEventListener('pointerup', onEnd);
      g.addEventListener('pointercancel', onEnd);
      g.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        var dir = e.key === 'ArrowRight' ? 1 : -1;
        state.selectedWeight = { plane: plane, index: idx };
        moveWeight(plane, dir);
      });
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
      if (rem.mass === 0) return;
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

  /* ================================================================
     DIAGRAMA DE CAMPO: anel FIXO leve/mover/pesado cobrindo os 360°,
     por fora do pneu — não é desenhado dentro do #wheelRotor, então NÃO
     gira quando o usuário arrasta a roda. Os ângulos são sempre os da
     MÁQUINA (mesma referência da seta REF 90° e dos LEDs): 90° = topo.

       T ± 30°        -> LEVE   (é aqui, alinhado com a REF, que se coloca
                         ou aumenta o chumbo)
       T+150° a T+210° -> PESADO (lado oposto à REF: chumbo sobrando ali,
                         troque por um mais leve)
       nos outros 120° de cada lado -> MOVER: gire a roda nesse sentido
       até o ponto do plano chegar na faixa "leve" (topo) — esquerda
       sempre no sentido horário, direita sempre anti-horário.

     Construído uma única vez (é estático: não depende de medição, chumbo
     ou plano — é a mesma referência fixa da máquina o tempo todo).
     ================================================================ */
  function buildFieldZonesMachine() {
    var container = el.fieldZonesMachine;
    container.innerHTML = '';
    var cx = FRONT_CX, cy = FRONT_CY;
    var rInner = 224, rOuter = 240;
    var rIcon = (rInner + rOuter) / 2;
    var T = 90; // topo (12h) na convenção de graus da máquina

    var slices = [
      { key: 'leve', a0: T - 30, a1: T + 30 },
      { key: 'mover', a0: T + 30, a1: T + 150, arrowClockwise: false },   // direita: anti-horário
      { key: 'pesado', a0: T + 150, a1: T + 210 },
      { key: 'mover', a0: T + 210, a1: T + 330, arrowClockwise: true }    // esquerda: horário
    ];

    slices.forEach(function (slice) {
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', annulusSlicePath(cx, cy, rInner, rOuter, slice.a0, slice.a1));
      path.setAttribute('class', 'field-zone field-zone-' + slice.key);
      container.appendChild(path);

      if (slice.key === 'mover') {
        var span = slice.a1 - slice.a0;
        [slice.a0 + span * 0.28, slice.a0 + span * 0.72].forEach(function (ang) {
          container.appendChild(makeFieldZoneArrow(cx, cy, rIcon, ang, slice.arrowClockwise));
        });
      }
    });

    container.appendChild(makeFieldWeightIcon(cx, cy, rIcon, T, '+'));
    container.appendChild(makeFieldWeightIcon(cx, cy, rIcon, T + 180, '−'));
  }

  // ícone de "chumbo" (mesmo estilo circular dos marcadores de peso na roda)
  // com +/- dentro, marcando onde adicionar ou tirar peso
  function makeFieldWeightIcon(cx, cy, r, angleDeg, glyph) {
    var p = polarXY(cx, cy, r, angleDeg);
    var g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'field-weight-icon');
    g.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
    var circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('r', '12');
    g.appendChild(circle);
    var text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('y', '1');
    text.textContent = glyph;
    g.appendChild(text);
    return g;
  }

  // "fatia de rosquinha" (donut slice) entre dois raios e dois ângulos —
  // mesma convenção de polarXY (crescendo no sentido horário)
  function annulusSlicePath(cx, cy, rInner, rOuter, a0, a1) {
    var p0o = polarXY(cx, cy, rOuter, a0);
    var p1o = polarXY(cx, cy, rOuter, a1);
    var p1i = polarXY(cx, cy, rInner, a1);
    var p0i = polarXY(cx, cy, rInner, a0);
    var largeArc = (((a1 - a0) % 360) + 360) % 360 > 180 ? 1 : 0;
    return 'M ' + p0o.x + ' ' + p0o.y +
      ' A ' + rOuter + ' ' + rOuter + ' 0 ' + largeArc + ' 1 ' + p1o.x + ' ' + p1o.y +
      ' L ' + p1i.x + ' ' + p1i.y +
      ' A ' + rInner + ' ' + rInner + ' 0 ' + largeArc + ' 0 ' + p0i.x + ' ' + p0i.y +
      ' Z';
  }

  // seta (com rabinho) tangente ao arco em (r, angleDeg), apontando no
  // sentido horário ou anti-horário — usada nas faixas "mover" para indicar
  // para qual lado girar a roda até chegar na faixa "leve" (o alvo T).
  // tangente de polarXY para ângulo crescente aponta, em graus de tela
  // (0°=direita), no valor (angleDeg - 90) — por isso o -90 abaixo.
  function makeFieldZoneArrow(cx, cy, r, angleDeg, clockwise) {
    var p = polarXY(cx, cy, r, angleDeg);
    var base = angleDeg - 90;
    var tangentDeg = clockwise ? base : base + 180;
    var g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'field-zone-arrow');
    g.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ') rotate(' + tangentDeg + ')');
    var tail = document.createElementNS(SVG_NS, 'line');
    tail.setAttribute('x1', '-13'); tail.setAttribute('y1', '0');
    tail.setAttribute('x2', '2'); tail.setAttribute('y2', '0');
    tail.setAttribute('class', 'field-zone-arrow-tail');
    g.appendChild(tail);
    var head = document.createElementNS(SVG_NS, 'polygon');
    head.setAttribute('points', '9,0 -4,-6 -4,6');
    head.setAttribute('class', 'field-zone-arrow-head');
    g.appendChild(head);
    return g;
  }

  function renderWeightLists() {
    fillList(el.listInternal, 'internal');
    fillList(el.listExternal, 'external');
  }

  // a cor leve/mover/pesado (que antes ficava pintada na roda, e só causava
  // confusão girando e recentralizando junto com os chumbos) fica junto do
  // próprio ângulo na lista: uma faixa colorida do lado da etiqueta "X g @ Y°"
  // do ÚLTIMO chumbo de cada plano, com o mesmo veredito do Diagrama de Campo.
  function fillList(ul, plane) {
    ul.innerHTML = '';
    var verdict = computeVerdict(plane);
    var wp = state.weights[plane];
    var lastIdx = wp.pieces.length - 1;
    wp.pieces.forEach(function (mass, idx) {
      var li = document.createElement('li');
      if (isSelected(plane, idx)) li.classList.add('selected');
      if (idx === lastIdx && verdict && verdict.key !== 'balanced') {
        li.classList.add('verdict-' + verdict.key);
      }
      var span = document.createElement('span');
      span.textContent = mass + ' g @ ' + Math.round(wp.angle) + '°';
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
    var wp = state.weights[plane];
    var isNewCluster = wp.pieces.length === 0;
    if (isNewCluster) wp.angle = currentTopWheelAngle();
    wp.pieces.push(mass);
    state.selectedWeight = { plane: plane, index: wp.pieces.length - 1 };
    renderWeights();
    setFeedback(
      'Chumbo de ' + mass + ' g adicionado no plano ' + planeLabel(plane) +
      (isNewCluster
        ? ', na marca de referência (topo)'
        : ', colado junto com os outros chumbos desse plano — a máquina trata o conjunto como uma peça só') +
      '. Gire a roda para medir de novo.',
      'neutral'
    );
  }

  function removeWeight(plane) {
    setWheelView('front');
    var wp = state.weights[plane];
    if (!wp.pieces.length) return;
    wp.pieces.pop();
    if (state.selectedWeight && state.selectedWeight.plane === plane &&
        state.selectedWeight.index >= wp.pieces.length) {
      state.selectedWeight = null;
    }
    renderWeights();
  }

  function removeWeightAt(plane, idx) {
    state.weights[plane].pieces.splice(idx, 1);
    state.selectedWeight = null;
    renderWeights();
  }

  // o incremento do botão Mover não é um valor fixo: é a largura física
  // (traduzida em graus, no raio desse plano) do próprio conjunto de
  // chumbos colados — mover "a distância de uma peça da gramatura que o
  // sistema indicou" (ex.: 50 g = dois chumbos de 25, ou dois de 20 e um
  // de 10 — a largura desses chumbos juntos).
  function moveStepDegFor(plane) {
    var wp = state.weights[plane];
    var radius = plane === 'internal' ? state.geom.innerR : state.geom.outerR;
    var widthPx = wp.pieces.reduce(function (sum, m) { return sum + 2 * pieceRadius(m); }, 0);
    if (!widthPx) widthPx = 2 * pieceRadius(WEIGHT_VALUES[0]);
    return (widthPx / (2 * Math.PI * radius)) * 360;
  }

  function moveWeight(plane, dir) {
    setWheelView('front');
    var wp = state.weights[plane];
    if (!wp.pieces.length) {
      setFeedback('Não há chumbo no plano ' + planeLabel(plane) + ' para mover. Adicione um chumbo primeiro.', 'neutral');
      return;
    }
    var stepDeg = moveStepDegFor(plane);
    wp.angle = ((wp.angle + dir * stepDeg) % 360 + 360) % 360;
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
      state.rotorAngleRaw = deg;
      updateLeds();
      if (t < 1) requestAnimationFrame(frame);
      else onDone();
    }
    requestAnimationFrame(frame);
  }

  function setStatusLed(busy) {
    if (el.statusLed) el.statusLed.classList.toggle('busy', busy);
  }

  /* ================================================================
     BOLINHAS DE POSIÇÃO (como o visor de LEDs de uma balanceadora real)
     Em vez de mostrar o ângulo exato, o simulador mede o quão perto a
     marca do topo (REF 90°) está do ponto certo do plano; o usuário
     descobre o lugar girando a roda manualmente até acender tudo.
     ================================================================ */
  var LED_COUNT = 5;

  function ledsForDiff(absDiff) {
    if (absDiff <= 2) return 5;
    if (absDiff <= 6) return 4;
    if (absDiff <= 14) return 3;
    if (absDiff <= 26) return 2;
    if (absDiff <= 45) return 1;
    return 0;
  }

  function buildLedRow(container) {
    container.innerHTML = '';
    for (var i = 0; i < LED_COUNT; i++) {
      var dot = document.createElement('span');
      dot.className = 'led-dot';
      container.appendChild(dot);
    }
  }

  function setLedRow(container, lit) {
    Array.prototype.forEach.call(container.children, function (dot, i) {
      dot.classList.toggle('lit', i < lit);
      dot.classList.toggle('lit-full', lit === LED_COUNT && i < lit);
    });
  }

  // as bolinhas seguem a ÚLTIMA medição (state.lastReading), não o alvo "ao
  // vivo" — igual numa máquina real, que só atualiza a leitura girando de
  // novo. Só girar a roda manualmente (rotorAngleRaw) mexe nas bolinhas;
  // colocar/mover um chumbo não altera a leitura até o próximo GIRAR. A seta
  // de referência (REF 90°) também fica verde quando algum plano bate 5/5 —
  // um segundo sinal, bem visível, de que a roda está no lugar certo.
  function updateLeds() {
    if (!state.hasSpun) {
      setLedRow(el.ledRowInt, 0);
      setLedRow(el.ledRowExt, 0);
      el.refPointer.classList.remove('aligned');
      return;
    }
    var top = currentTopWheelAngle();
    var anyFull = false;
    ['internal', 'external'].forEach(function (plane) {
      var container = plane === 'internal' ? el.ledRowInt : el.ledRowExt;
      var reading = state.lastReading[plane];
      var lit = reading.mass === 0 ? LED_COUNT : ledsForDiff(angularDist(top, reading.angle));
      if (lit === LED_COUNT) anyFull = true;
      setLedRow(container, lit);
    });
    el.refPointer.classList.toggle('aligned', anyFull);
  }

  // gira a roda "na mão", arrastando qualquer parte dela (pneu OU aro/aro
  // metálico) — igual numa máquina real, onde depois do motor parar você
  // mesmo rotaciona a roda até achar o ponto. Os chumbos (desenhados por
  // cima, com seu próprio arraste) continuam tendo prioridade quando
  // agarrados diretamente neles.
  function attachRotorDragToEl(triggerEl) {
    var dragging = false;
    var lastAngle = 0;
    triggerEl.addEventListener('pointerdown', function (e) {
      if (state.spinning) return;
      dragging = true;
      try { triggerEl.setPointerCapture(e.pointerId); } catch (_) {}
      var pt = svgPointFromEvent(el.machineSvg, e);
      lastAngle = angleFromPoint(state.geom.cx, state.geom.cy, pt.x, pt.y);
      e.preventDefault();
    });
    triggerEl.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var pt = svgPointFromEvent(el.machineSvg, e);
      var angleNow = angleFromPoint(state.geom.cx, state.geom.cy, pt.x, pt.y);
      var delta = ((angleNow - lastAngle + 540) % 360) - 180; // caminho mais curto
      state.rotorAngleRaw += delta;
      lastAngle = angleNow;
      el.wheelRotor.setAttribute('transform', 'rotate(' + state.rotorAngleRaw + ' ' + state.geom.cx + ' ' + state.geom.cy + ')');
      updateLeds();
    });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      try { triggerEl.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    triggerEl.addEventListener('pointerup', end);
    triggerEl.addEventListener('pointercancel', end);
  }

  function attachRotorDrag() {
    attachRotorDragToEl(el.tireCircle);
    attachRotorDragToEl(el.rimCircle);
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
    updateLeds();
    renderGuide();
  }

  function updateDisplay(intR, extR) {
    var tol = state.tolerance;
    var total = intR.mass + extR.mass; // tolerância é sobre a soma dos dois planos, não cada um isolado
    var balanced = total <= tol;

    el.dispMassInt.textContent = intR.mass + ' g';
    el.dispAngleInt.textContent = intR.mass === 0 ? '—' : Math.round(intR.angle) + '°';
    el.dispMassExt.textContent = extR.mass + ' g';
    el.dispAngleExt.textContent = extR.mass === 0 ? '—' : Math.round(extR.angle) + '°';

    el.machineReadout.classList.toggle('is-balanced', balanced);
    fitMachineReadout();
  }

  // Calcula, a partir do espaço realmente disponível na telinha (medido no
  // DOM, não estimado), o maior tamanho de fonte que cabe sem quebrar linha
  // nem estourar a altura — assim "INTERNO/EXTERNO" cobrem quase toda a área
  // da telinha em qualquer largura de tela. Usa uma primeira estimativa pela
  // altura e depois MEDE a largura real do texto renderizado para corrigir
  // (em vez de estimar a largura de caractere, o que erra por fonte/zoom).
  function applyReadoutSize(massSize) {
    el.machineReadout.style.setProperty('--readout-mass-size', massSize + 'px');
    el.machineReadout.style.setProperty('--readout-label-size', (massSize * 0.32) + 'px');
    el.machineReadout.style.setProperty('--readout-led-size', (massSize * 0.3) + 'px');
    el.machineReadout.style.setProperty('--readout-led-gap', (massSize * 0.18) + 'px');
  }

  function fitMachineReadout() {
    var col = el.machineReadout.querySelector('.readout-col');
    if (!col) return;
    var rect = col.getBoundingClientRect();
    var availW = rect.width;
    var availH = rect.height;
    if (availW <= 0 || availH <= 0) return;

    var massSize = clamp(availH / 2.4, 9, 34);
    applyReadoutSize(massSize);

    var w1 = el.dispMassInt.getBoundingClientRect().width;
    var w2 = el.dispMassExt.getBoundingClientRect().width;
    var widestText = Math.max(w1, w2);
    var safeW = availW * 0.94;
    if (widestText > safeW && widestText > 0) {
      massSize = massSize * (safeW / widestText);
    }
    massSize = clamp(massSize, 9, 34);
    applyReadoutSize(massSize);
  }

  function updateFeedback(prevInt, curInt, prevExt, curExt) {
    var tol = state.tolerance;
    var total = curInt.mass + curExt.mass;
    var balanced = total <= tol;

    if (balanced) {
      var balancedMsg = 'Roda balanceada! A soma dos dois planos (' + total + ' g) está dentro da tolerância de ' + tol + ' g.';
      setFeedback(balancedMsg, 'good');
      showBalancedModal(balancedMsg);
      return;
    }

    var parts = [];
    var pairs = [
      { plane: 'internal', prev: prevInt, cur: curInt, ok: curInt.mass === 0 },
      { plane: 'external', prev: prevExt, cur: curExt, ok: curExt.mass === 0 }
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

  function showBalancedModal(msg) {
    if (!el.balancedModal) return;
    el.balancedModalMsg.textContent = msg;
    el.balancedModal.hidden = false;
    if (el.btnBalancedOk) el.btnBalancedOk.focus();
  }

  function hideBalancedModal() {
    if (!el.balancedModal) return;
    el.balancedModal.hidden = true;
  }

  function bindBalancedModal() {
    if (!el.balancedModal) return;
    el.btnBalancedOk.addEventListener('click', hideBalancedModal);
    el.balancedModal.addEventListener('click', function (e) {
      if (e.target === el.balancedModal) hideBalancedModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !el.balancedModal.hidden) hideBalancedModal();
    });
  }

  /* ================================================================
     GERAR EXERCÍCIO (um único botão + menu de padrões de roda)
     ================================================================ */
  function generateUnbalance() {
    return {
      internal: { mass: randMassMultiple(), angle: randInt(0, 359) },
      external: { mass: randMassMultiple(), angle: randInt(0, 359) }
    };
  }

  // sorteia um desbalanceamento sempre múltiplo de 5 (nunca zero: sempre há algo para corrigir)
  function randMassMultiple() {
    var steps = UNBALANCE_MAX / MASS_STEP;
    var minSteps = UNBALANCE_MIN / MASS_STEP;
    return MASS_STEP * randInt(minSteps, steps);
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

    hideBalancedModal();
    setWheelView('side');
    state.unbalance = generateUnbalance();
    state.weights = { internal: { angle: 0, pieces: [] }, external: { angle: 0, pieces: [] } };
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
    updateLeds();

    el.machineReadout.classList.remove('is-balanced');
    el.dispMassInt.textContent = '-- g'; el.dispAngleInt.textContent = '--°';
    el.dispMassExt.textContent = '-- g'; el.dispAngleExt.textContent = '--°';
    setFeedback('Meça a roda e clique em GIRAR para iniciar.', null);
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
    renderGuide();
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
      if (isNaN(v)) v = 15;
      state.tolerance = clamp(v, 0, 40);
      if (state.hasSpun) updateDisplay(state.lastReading.internal, state.lastReading.external);
    });

    // ao terminar de editar (sair do campo/apertar Enter), corrige o valor
    // exibido pro que realmente vai ser usado (múltiplo de 5, entre 0 e 40)
    // — sem isso o campo podia mostrar um número (ex.: 3 ou 50) diferente
    // do valor que a máquina de fato aplicava no cálculo.
    el.inputTolerance.addEventListener('change', function () {
      var v = parseInt(el.inputTolerance.value, 10);
      if (isNaN(v)) v = 15;
      var applied = clamp(roundToStep(v, 5), 0, 40);
      state.tolerance = applied;
      el.inputTolerance.value = String(applied);
      if (state.hasSpun) updateDisplay(state.lastReading.internal, state.lastReading.external);
    });

    // o próximo chumbo só pode ser um dos valores reais disponíveis na máquina (5/10/20/25 g)
    Array.prototype.forEach.call(document.querySelectorAll('.stepper-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var plane = btn.getAttribute('data-step-plane');
        var dir = parseInt(btn.getAttribute('data-step-dir'), 10);
        var idx = WEIGHT_VALUES.indexOf(state.pendingMass[plane]);
        if (idx === -1) idx = 0;
        idx = clamp(idx + dir, 0, WEIGHT_VALUES.length - 1);
        state.pendingMass[plane] = WEIGHT_VALUES[idx];
        (plane === 'internal' ? el.stepValInt : el.stepValExt).textContent = WEIGHT_VALUES[idx] + ' g';
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
    buildFieldZonesMachine();
    buildGuideTicks();
    buildLedRow(el.ledRowInt);
    buildLedRow(el.ledRowExt);
    updateWheelGeometry();
    setWheelView('side');
    el.machineSvg.setAttribute('data-wheel-view', 'side');
    generateExercise();
    bindEvents();
    attachRotorDrag();
    bindBalancedModal();
    setMode('learn');
    fitMachineReadout();

    // A 1ª medida acontece antes da webfont (IBM Plex Mono, carregada via
    // Google Fonts) terminar de baixar — o texto é medido com a fonte de
    // reserva do navegador, que tem uma largura diferente. Quando a fonte
    // "de verdade" entra, o texto pode ficar mais largo que a coluna e
    // vazar por cima da coluna vizinha. Por isso recalculamos assim que as
    // fontes terminam de carregar (e de novo num pequeno atraso, para
    // navegadores sem a Font Loading API).
    if (window.document && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(fitMachineReadout).catch(function () {});
    }
    setTimeout(fitMachineReadout, 350);
    setTimeout(fitMachineReadout, 1200);

    var resizeRaf = null;
    window.addEventListener('resize', function () {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(fitMachineReadout);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
