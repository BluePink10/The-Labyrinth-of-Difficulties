// ============================================================
// Thief & Innocents — клиент
// ============================================================
(() => {
  const $ = (id) => document.getElementById(id);

  const screens = ["join", "lobby", "role", "game", "vote", "result"];
  function showScreen(name) {
    screens.forEach((s) => $("screen-" + s).classList.toggle("active", s === name));
  }

  const AVATARS = ["1", "2", "3", "4", "5", "6", "7", "8"];
  const charSrc = (id) => `/static/assets/${id}.png`;
  const ASSET = {
    stone: "/static/assets/stone.png",
    chest: "/static/assets/chest.png",
    diamond: "/static/assets/diamond.png",
    roleInnocent: "/static/assets/9.png",   // свиток "мирный"
    roleThief: "/static/assets/10.png",     // свиток "вор"
  };

  // ---------------------------------------------------------
  // Предзагрузка картинок
  // ---------------------------------------------------------
  const charImg = {};       // id -> Image
  const imgReady = {};      // src -> Image (общий кэш для остальных ассетов)

  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(img); // не блокируем игру, если картинка не загрузилась
      img.src = src;
    });
  }

  const assetsReady = (async () => {
    const entries = await Promise.all([
      ...AVATARS.map((id) => loadImage(charSrc(id)).then((img) => (charImg[id] = img))),
      ...Object.entries(ASSET).map(([key, src]) => loadImage(src).then((img) => (imgReady[key] = img))),
    ]);
    return entries;
  })();

  let ws = null;
  let myId = null;
  let isHost = false;
  let selectedAvatar = AVATARS[0];
  let iAmThief = false;
  let roomCode = "";
  let desiredPlayers = 3;      // выбор при создании комнаты
  let roomMaxPlayers = 3;      // фактический размер комнаты (приходит с сервера)
  let latestLobbyPlayers = []; // для перерисовки пикера аватарок при live-обновлениях

  // Статические данные уровней (маза/сундуки/алмазы), приходят один раз при старте игры
  let world = { tile: 40, grid_w: 19, grid_h: 19, num_levels: 3, steal_range: 72 };
  let levels = [];      // [{maze, exit_x, chests:[{id,x,y}], diamond_piles:[{id,x,y,count}]}]
  let myLevel = 0;

  // Динамическое состояние (обновляется каждый тик)
  let players = {};     // id -> {id,name,avatar,level,x,y,diamonds,opening,steal_cd,connected}
  let chestsState = []; // по уровням: [{id,opened,progress}]
  let pilesState = [];  // по уровням: [{id,collected}]

  const PLAYER_SIZE_RATIO = 0.55;   // должно совпадать с PLAYER_SIZE/TILE на сервере
  const pileOffsetsCache = {};      // pileId -> [{dx,dy}] случайный, но стабильный разброс алмазов

  function pileOffsets(pile) {
    if (!pileOffsetsCache[pile.id]) {
      const offs = [];
      const n = Math.min(pile.count, 8);
      for (let i = 0; i < n; i++) {
        const angle = (i / n) * Math.PI * 2 + Math.random() * 0.5;
        const r = 0.14 + Math.random() * 0.16;
        offs.push({ dx: Math.cos(angle) * r, dy: Math.sin(angle) * r });
      }
      pileOffsetsCache[pile.id] = offs;
    }
    return pileOffsetsCache[pile.id];
  }

  // ---------------------------------------------------------
  // Экран входа
  // ---------------------------------------------------------
  function randomName() {
    const n = ["Лиса", "Сова", "Тигр", "Панда", "Ёж", "Кот", "Волк", "Заяц"];
    return n[Math.floor(Math.random() * n.length)] + Math.floor(Math.random() * 90 + 10);
  }
  $("input-name").value = randomName();

  function buildPlayersCountPicker() {
    const wrap = $("players-count-picker");
    wrap.innerHTML = "";
    for (let n = 3; n <= 8; n++) {
      const cell = document.createElement("div");
      cell.className = "count-cell" + (n === desiredPlayers ? " selected" : "");
      cell.textContent = n;
      cell.onclick = () => {
        desiredPlayers = n;
        [...wrap.children].forEach((c) => c.classList.remove("selected"));
        cell.classList.add("selected");
      };
      wrap.appendChild(cell);
    }
  }
  buildPlayersCountPicker();

  $("btn-create").onclick = async () => {
    $("join-error").textContent = "";
    try {
      const res = await fetch(`/api/new_room?players=${desiredPlayers}`);
      const data = await res.json();
      $("input-room").value = data.room;
      connect(data.room);
    } catch (e) {
      $("join-error").textContent = "Не удалось создать комнату. Проверь соединение.";
    }
  };

  $("btn-join").onclick = () => {
    const code = $("input-room").value.trim().toUpperCase();
    if (!code) {
      $("join-error").textContent = "Введи код комнаты.";
      return;
    }
    connect(code);
  };

  function connect(code) {
    roomCode = code;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/${code}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "join",
        name: $("input-name").value.trim() || randomName(),
        avatar: selectedAvatar,
      }));
    };
    ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
    ws.onclose = () => {
      if ($("screen-join").classList.contains("active")) return;
      $("join-error").textContent = "Соединение потеряно.";
      showScreen("join");
    };
    ws.onerror = () => { $("join-error").textContent = "Ошибка соединения."; };
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // ---------------------------------------------------------
  // Обработка сообщений сервера
  // ---------------------------------------------------------
  function handleMessage(msg) {
    switch (msg.type) {
      case "error":
        $("join-error").textContent = msg.message;
        break;
      case "joined":
        myId = msg.you;
        isHost = msg.host;
        selectedAvatar = msg.avatar || selectedAvatar;
        roomMaxPlayers = msg.max_players || roomMaxPlayers;
        $("lobby-room-code").textContent = roomCode;
        buildAvatarPicker();
        showScreen("lobby");
        break;
      case "lobby_state":
        renderLobby(msg);
        break;
      case "game_start":
        iAmThief = msg.is_thief;
        levels = msg.levels;
        world = msg.world;
        myLevel = 0;
        showRoleScreen();
        break;
      case "play_start":
        showScreen("game");
        setupCanvas();
        $("btn-steal").classList.toggle("hidden", !iAmThief);
        break;
      case "state":
        applyState(msg);
        break;
      case "vote_start":
        showVoteScreen();
        break;
      case "vote_progress":
        $("vote-status").textContent = `Проголосовали: ${msg.voted.length}/${roomMaxPlayers}`;
        break;
      case "player_left":
        if (players[msg.id]) players[msg.id].connected = false;
        break;
      case "result":
        showResult(msg);
        break;
    }
  }

  // ---------------------------------------------------------
  // Лобби
  // ---------------------------------------------------------
  function buildAvatarPicker() {
    const wrap = $("avatar-picker");
    wrap.innerHTML = "";
    AVATARS.forEach((id) => {
      const cell = document.createElement("div");
      cell.className = "avatar-cell";
      cell.dataset.avatarId = id;
      const img = document.createElement("img");
      img.src = charSrc(id);
      img.alt = "avatar " + id;
      cell.appendChild(img);
      cell.onclick = () => {
        if (cell.classList.contains("taken")) return;
        selectedAvatar = id;
        send({ type: "set_avatar", avatar: id });
        refreshAvatarPicker();
      };
      wrap.appendChild(cell);
    });
    refreshAvatarPicker();
  }

  // Перекрашивает пикер по последнему известному списку игроков в комнате —
  // вызывается и сразу после создания, и при каждом lobby_state (когда кто-то
  // другой меняет аватар, чтобы занятость обновлялась у всех живьём).
  function refreshAvatarPicker() {
    const wrap = $("avatar-picker");
    if (!wrap) return;
    const takenByOthers = new Set(
      latestLobbyPlayers.filter((p) => p.id !== myId).map((p) => p.avatar)
    );
    [...wrap.children].forEach((cell) => {
      const id = cell.dataset.avatarId;
      const taken = takenByOthers.has(id) && id !== selectedAvatar;
      cell.classList.toggle("taken", taken);
      cell.classList.toggle("selected", id === selectedAvatar);
    });
    $("avatar-hint").textContent = "Серые персонажи уже заняты другими игроками.";
  }

  function renderLobby(msg) {
    isHost = msg.host === myId;
    roomMaxPlayers = msg.max_players || roomMaxPlayers;
    latestLobbyPlayers = msg.players;

    const mine = msg.players.find((p) => p.id === myId);
    if (mine) selectedAvatar = mine.avatar;
    refreshAvatarPicker();

    const list = $("lobby-players");
    list.innerHTML = "";
    msg.players.forEach((p) => {
      const row = document.createElement("div");
      row.className = "player-row";
      row.innerHTML = `<img class="pav" src="${charSrc(p.avatar)}"><span class="name">${escapeHtml(p.name)}${p.id === myId ? " (ты)" : ""}</span>` +
        (msg.host === p.id ? `<span class="tag">хост</span>` : "");
      list.appendChild(row);
    });
    const need = roomMaxPlayers;
    const ready = msg.players.length === need;
    $("btn-start").disabled = !(ready && isHost);
    $("btn-start").classList.toggle("hidden", !isHost);
    $("lobby-need").textContent = `Нужно ${need} ${pluralPlayers(need)}, чтобы начать.`;
    $("lobby-hint").textContent = ready
      ? (isHost ? "Все в сборе — можно начинать!" : "Ждём, пока хост начнёт игру…")
      : `Ждём игроков: ${msg.players.length}/${need}`;
  }

  function pluralPlayers(n) {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return "игрок";
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "игрока";
    return "игроков";
  }

  $("btn-start").onclick = () => send({ type: "start_game" });

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------------------------------------------------------
  // Экран роли (приватный — виден только на своём устройстве)
  // ---------------------------------------------------------
  function showRoleScreen() {
    const title = $("role-title");
    const desc = $("role-desc");
    const img = $("role-image");
    if (iAmThief) {
      img.src = ASSET.roleThief;
      title.textContent = "Ты — ВОР!";
      title.className = "thief";
      desc.textContent = "Собирай алмазы и воруй у других: подойди близко и нажми «Украсть». Обычно 3💎, а если жертва открывает сундук — 10💎. После кражи — перезарядка.";
    } else {
      img.src = ASSET.roleInnocent;
      title.textContent = "Ты — МИРНЫЙ";
      title.className = "innocent";
      desc.textContent = "Собирай алмазы и открывай сундуки (держи «Открыть», стоя рядом). Следи за счётом — среди вас прячется вор!";
    }
    $("role-wait").textContent = "";
    $("btn-role-ready").disabled = false;
    showScreen("role");
  }

  $("btn-role-ready").onclick = () => {
    send({ type: "role_ack" });
    $("btn-role-ready").disabled = true;
    $("role-wait").textContent = "Ждём остальных игроков…";
  };

  // ---------------------------------------------------------
  // Игровой экран: canvas + ввод
  // ---------------------------------------------------------
  const canvas = $("game-canvas");
  const ctx = canvas.getContext("2d");
  let tileSize = 20;      // пикселей канваса на один тайл
  let stonePattern = null;

  function setupCanvas() {
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
  }

  function resizeCanvas() {
    const wrap = $("game-wrap");
    const availW = wrap.clientWidth;
    const availH = wrap.clientHeight;
    const worldTiles = world.grid_w;
    const size = Math.floor(Math.min(availW, availH));
    canvas.width = size;
    canvas.height = size;
    canvas.style.width = size + "px";
    canvas.style.height = size + "px";
    tileSize = size / worldTiles;
  }

  // Масштаб перевода координат сервера (логические "мировые" пиксели, TILE=world.tile)
  // в пиксели канваса (tileSize на тайл).
  function worldScale() {
    return tileSize / (world.tile || 40);
  }

  function applyState(msg) {
    $("hud-timer").textContent = formatTime(msg.timer);
    players = {};
    msg.players.forEach((p) => (players[p.id] = p));
    chestsState = msg.chests;
    pilesState = msg.diamond_piles;
    if (players[myId]) myLevel = players[myId].level;

    (msg.events || []).forEach(spawnFloater);
    renderHudScores();
    draw();
  }

  function formatTime(t) {
    t = Math.max(0, Math.ceil(t));
    const m = Math.floor(t / 60), s = t % 60;
    return `⏱ ${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function renderHudScores() {
    const wrap = $("hud-scores");
    wrap.innerHTML = "";
    Object.values(players).forEach((p) => {
      const el = document.createElement("div");
      el.className = "hud-score";
      el.innerHTML = `<img src="${charSrc(p.avatar)}"><span>${p.diamonds}</span><img class="diamond-icon" src="${ASSET.diamond}">`;
      wrap.appendChild(el);
    });
  }

  function spawnFloater(ev) {
    const wrap = $("floaters");
    const rect = canvas.getBoundingClientRect();
    const scale = worldScale();

    function makeFloater(pid, text, color) {
      const p = players[pid];
      if (!p || p.level !== myLevel) return;
      const el = document.createElement("div");
      el.className = "floater";
      el.textContent = text;
      el.style.color = color;
      el.style.left = (rect.left + p.x * scale) + "px";
      el.style.top = (rect.top + p.y * scale) + "px";
      wrap.appendChild(el);
      setTimeout(() => el.remove(), 1100);
    }

    if (ev.type === "steal") {
      makeFloater(ev.target, `-${ev.amount}💎`, "#ff6767");
      makeFloater(ev.thief, `+${ev.amount}💎`, "#00d68f");
    } else if (ev.type === "chest") {
      makeFloater(ev.player, `+${ev.amount}💎 сундук!`, "#ffd76a");
    }
  }

  function draw() {
    if (!levels.length) return;
    const lvl = levels[myLevel];
    const scale = worldScale();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // если текстура камня ещё не загрузилась — используем плоскую заливку как запасной вариант
    const stoneImg = imgReady.stone;
    const stoneOk = stoneImg && stoneImg.complete && stoneImg.naturalWidth > 0;

    for (let y = 0; y < world.grid_h; y++) {
      for (let x = 0; x < world.grid_w; x++) {
        const px = x * tileSize, py = y * tileSize;
        if (lvl.maze[y][x] === 0) {
          if (stoneOk) {
            ctx.drawImage(stoneImg, px, py, tileSize + 0.6, tileSize + 0.6);
          } else {
            ctx.fillStyle = "#3a3a44";
            ctx.fillRect(px, py, tileSize, tileSize);
          }
        } else {
          ctx.fillStyle = "#1a1a22";
          ctx.fillRect(px, py, tileSize, tileSize);
          ctx.strokeStyle = "#121218";
          ctx.strokeRect(px + 0.5, py + 0.5, tileSize - 1, tileSize - 1);
        }
      }
    }

    // алмазы (россыпью, как в исходной игре)
    const piles = pilesState[myLevel] || [];
    const pileMap = {}; piles.forEach((d) => (pileMap[d.id] = d));
    const diamondImg = imgReady.diamond;
    lvl.diamond_piles.forEach((d) => {
      const st = pileMap[d.id];
      if (st && st.collected) return;
      const cx = d.x * tileSize + tileSize / 2, cy = d.y * tileSize + tileSize / 2;
      const dSize = tileSize * 0.34;
      pileOffsets(d).forEach((o) => {
        const dx = cx + o.dx * tileSize * 2, dy = cy + o.dy * tileSize * 2;
        if (diamondImg && diamondImg.complete && diamondImg.naturalWidth > 0) {
          ctx.drawImage(diamondImg, dx - dSize / 2, dy - dSize / 2, dSize, dSize);
        } else {
          ctx.fillStyle = "#ff8fd0";
          ctx.beginPath(); ctx.arc(dx, dy, dSize / 2, 0, Math.PI * 2); ctx.fill();
        }
      });
    });

    // сундуки
    const chests = chestsState[myLevel] || [];
    const chestMap = {}; chests.forEach((c) => (chestMap[c.id] = c));
    const chestImg = imgReady.chest;
    lvl.chests.forEach((c) => {
      const st = chestMap[c.id] || { opened: false, progress: 0 };
      if (st.opened) return;
      const cx = c.x * tileSize + tileSize / 2, cy = c.y * tileSize + tileSize / 2;
      const cSize = tileSize * 0.85;
      if (chestImg && chestImg.complete && chestImg.naturalWidth > 0) {
        ctx.drawImage(chestImg, cx - cSize / 2, cy - cSize / 2, cSize, cSize);
      } else {
        ctx.fillStyle = "#a0522d";
        ctx.fillRect(cx - cSize / 2, cy - cSize / 2, cSize, cSize);
      }
      if (st.progress > 0) {
        const w = tileSize * 0.8, h = 4;
        const bx = cx - w / 2, by = c.y * tileSize - 6;
        ctx.fillStyle = "#444";
        ctx.fillRect(bx, by, w, h);
        ctx.fillStyle = "#00d68f";
        ctx.fillRect(bx, by, w * Math.min(1, st.progress / 2200), h);
      }
    });

    // Кольцо дальности кражи — видит ТОЛЬКО вор, и только вокруг себя.
    // Это чисто локальный рендер: роль (iAmThief) известна лишь этому
    // клиенту из приватного сообщения game_start, по сети другим не уходит.
    if (iAmThief && players[myId] && players[myId].level === myLevel) {
      const me = players[myId];
      const hitboxSize = tileSize * PLAYER_SIZE_RATIO;
      const centerX = me.x * scale + hitboxSize / 2, centerY = me.y * scale + hitboxSize / 2;
      const rangePx = (world.steal_range || 72) * scale;
      ctx.beginPath();
      ctx.arc(centerX, centerY, rangePx, 0, Math.PI * 2);
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = "rgba(255,103,103,0.55)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // игроки на этом же этаже
    Object.values(players).forEach((p) => {
      if (p.level !== myLevel || !p.connected) return;
      const hitboxSize = tileSize * PLAYER_SIZE_RATIO;
      const px = p.x * scale, py = p.y * scale;
      const centerX = px + hitboxSize / 2, centerY = py + hitboxSize / 2;

      const img = charImg[p.avatar];
      if (img && img.complete && img.naturalWidth > 0) {
        const maxDim = Math.max(img.naturalWidth, img.naturalHeight);
        const targetMax = tileSize * 1.9;
        const drawScale = targetMax / maxDim;
        const dw = img.naturalWidth * drawScale;
        const dh = img.naturalHeight * drawScale;
        ctx.drawImage(img, centerX - dw / 2, centerY - dh / 2, dw, dh);
      } else {
        ctx.fillStyle = "#6ec6ff";
        ctx.beginPath(); ctx.arc(centerX, centerY, hitboxSize / 2, 0, Math.PI * 2); ctx.fill();
      }

      if (p.steal_cd > 0 && p.id === myId) {
        ctx.font = `${Math.max(10, tileSize * 0.3)}px sans-serif`;
        ctx.fillStyle = "#ffb050";
        ctx.textAlign = "center";
        ctx.fillText(Math.ceil(p.steal_cd / 1000) + "с", centerX, centerY - tileSize * 1.1);
      }
    });
  }

  // ---------------------------------------------------------
  // Ввод: клавиатура
  // ---------------------------------------------------------
  const keyState = { up: false, down: false, left: false, right: false };
  let lastSentInput = "";

  function sendInputIfChanged() {
    const s = JSON.stringify(keyState);
    if (s !== lastSentInput) {
      lastSentInput = s;
      send({ type: "input", ...keyState });
    }
  }

  const GAME_KEYS = new Set(["w", "a", "s", "d", "W", "A", "S", "D",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "f", "F"]);
  window.addEventListener("keydown", (e) => {
    if (GAME_KEYS.has(e.key) && $("screen-game").classList.contains("active")) e.preventDefault();
    handleKey(e.key, true);
  });
  window.addEventListener("keyup", (e) => {
    if (GAME_KEYS.has(e.key) && $("screen-game").classList.contains("active")) e.preventDefault();
    handleKey(e.key, false);
  });

  function handleKey(key, down) {
    const map = {
      w: "up", ArrowUp: "up",
      s: "down", ArrowDown: "down",
      a: "left", ArrowLeft: "left",
      d: "right", ArrowRight: "right",
    };
    const k = map[key];
    if (k) { keyState[k] = down; sendInputIfChanged(); }
    if (key === " ") {
      e_action(down);
    }
    if ((key === "f" || key === "F") && down) {
      send({ type: "steal" });
    }
  }

  function e_action(held) {
    send({ type: "action", held });
    $("btn-action").classList.toggle("active", held);
  }

  // ---------------------------------------------------------
  // Ввод: виртуальный джойстик (touch)
  // ---------------------------------------------------------
  const joyBase = $("joystick-base");
  const joyKnob = $("joystick-knob");
  let joyActive = false, joyId = null, joyCenter = { x: 0, y: 0 };
  const JOY_RADIUS = 50;

  function joyStart(x, y, id) {
    joyActive = true; joyId = id;
    const r = joyBase.getBoundingClientRect();
    joyCenter = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    joyMove(x, y);
  }
  function joyMove(x, y) {
    let dx = x - joyCenter.x, dy = y - joyCenter.y;
    const dist = Math.hypot(dx, dy);
    if (dist > JOY_RADIUS) { dx = (dx / dist) * JOY_RADIUS; dy = (dy / dist) * JOY_RADIUS; }
    joyKnob.style.left = 37 + dx + "px";
    joyKnob.style.top = 37 + dy + "px";
    const dead = 12;
    keyState.left = dx < -dead;
    keyState.right = dx > dead;
    keyState.up = dy < -dead;
    keyState.down = dy > dead;
    sendInputIfChanged();
  }
  function joyEnd() {
    joyActive = false; joyId = null;
    joyKnob.style.left = "37px"; joyKnob.style.top = "37px";
    keyState.left = keyState.right = keyState.up = keyState.down = false;
    sendInputIfChanged();
  }

  joyBase.addEventListener("touchstart", (e) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    joyStart(t.clientX, t.clientY, t.identifier);
  }, { passive: false });
  window.addEventListener("touchmove", (e) => {
    if (!joyActive) return;
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) { e.preventDefault(); joyMove(t.clientX, t.clientY); }
    }
  }, { passive: false });
  window.addEventListener("touchend", (e) => {
    for (const t of e.changedTouches) if (t.identifier === joyId) joyEnd();
  });
  // мышь — для отладки на десктопе
  joyBase.addEventListener("mousedown", (e) => joyStart(e.clientX, e.clientY, "mouse"));
  window.addEventListener("mousemove", (e) => { if (joyActive && joyId === "mouse") joyMove(e.clientX, e.clientY); });
  window.addEventListener("mouseup", () => { if (joyId === "mouse") joyEnd(); });

  // Кнопка «Открыть»
  const btnAction = $("btn-action");
  ["touchstart", "mousedown"].forEach((ev) =>
    btnAction.addEventListener(ev, (e) => { e.preventDefault(); e_action(true); })
  );
  ["touchend", "mouseup", "touchcancel"].forEach((ev) =>
    btnAction.addEventListener(ev, (e) => { e.preventDefault(); e_action(false); })
  );

  // Кнопка «Украсть»
  const btnSteal = $("btn-steal");
  btnSteal.addEventListener("touchstart", (e) => {
    e.preventDefault();
    btnSteal.classList.add("active");
    send({ type: "steal" });
    setTimeout(() => btnSteal.classList.remove("active"), 200);
  }, { passive: false });
  btnSteal.addEventListener("click", () => {
    send({ type: "steal" });
  });

  // ---------------------------------------------------------
  // Голосование
  // ---------------------------------------------------------
  function showVoteScreen() {
    const wrap = $("vote-options");
    wrap.innerHTML = "";
    $("vote-status").textContent = "";
    Object.values(players).forEach((p) => {
      if (p.id === myId) return;
      const el = document.createElement("div");
      el.className = "vote-option";
      el.innerHTML = `<img class="pav" src="${charSrc(p.avatar)}"><span>${escapeHtml(p.name)}</span>`;
      el.onclick = () => {
        [...wrap.children].forEach((c) => c.classList.remove("picked"));
        el.classList.add("picked");
        send({ type: "vote", target: p.id });
        $("vote-status").textContent = "Голос принят. Ждём остальных…";
      };
      wrap.appendChild(el);
    });
    showScreen("vote");
  }

  // ---------------------------------------------------------
  // Результаты
  // ---------------------------------------------------------
  function showResult(msg) {
    const title = $("result-title");
    const iAmInnocent = !iAmThief;
    const won = (iAmInnocent && msg.innocents_win) || (iAmThief && !msg.innocents_win);
    title.textContent = msg.innocents_win ? "🎉 Мирные победили!" : "🥷 Вор победил!";
    title.className = won ? "win" : "lose";

    $("result-thief").innerHTML = `<img class="pav" src="${charSrc(msg.thief.avatar)}"><span>Настоящий вор: ${escapeHtml(msg.thief.name)}</span>`;

    const scoresWrap = $("result-scores");
    scoresWrap.innerHTML = "";
    msg.scores
      .slice()
      .sort((a, b) => b.diamonds - a.diamonds)
      .forEach((s) => {
        const row = document.createElement("div");
        row.className = "player-row";
        const p = players[s.id];
        row.innerHTML = `<img class="pav" src="${p ? charSrc(p.avatar) : ASSET.diamond}"><span class="name">${escapeHtml(s.name)}</span><span class="score">${s.diamonds}💎</span>`;
        scoresWrap.appendChild(row);
      });

    showScreen("result");
  }

  $("btn-again").onclick = () => location.reload();
})();
