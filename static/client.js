// ============================================================
// Thief & Innocents — клиентский скрипт
// ============================================================
(() => {
  const initGame = () => {
    const $ = (id) => document.getElementById(id);

    // Список всех экранов игры
    const screens = ["join", "lobby", "role", "game", "vote", "result", "controls"];
    let screenBeforeControls = "join";

    // ---------------------------------------------------------
    // Константы и Ассеты
    // ---------------------------------------------------------
    const AVATARS = ["1", "2", "3", "4", "5", "6", "7", "8"];
    const charSrc = (id) => `/static/assets/${id}.png`;
    const ASSET = {
      stone: "/static/assets/stone.png",
      chest: "/static/assets/chest.png",
      diamond: "/static/assets/diamond.png",
      roleInnocent: "/static/assets/9.png",    
      roleThief: "/static/assets/10.png",     
      hint: "/static/assets/11.png",          // Картинка управления
    };

    // ---------------------------------------------------------
    // Полное очищение и сборка экрана управления (только картинка 11.png)
    // ---------------------------------------------------------
    function injectControlsUI() {
      let sc = $("screen-controls");
      if (!sc) {
        sc = document.createElement("div");
        sc.id = "screen-controls";
        sc.className = "screen";
        document.body.appendChild(sc);
      }

      // Перезаписываем стили экрана управления для полного перекрытия
      sc.dataset.injected = "true";
      sc.style.display = "none";
      sc.style.position = "fixed";
      sc.style.top = "0"; 
      sc.style.left = "0"; 
      sc.style.width = "100%"; 
      sc.style.height = "100%";
      sc.style.background = "rgba(10, 10, 15, 0.95)";
      sc.style.zIndex = "9999";
      sc.style.flexDirection = "column";
      sc.style.alignItems = "center";
      sc.style.justifyContent = "center";
      sc.style.padding = "20px";
      sc.style.boxSizing = "border-box";

      // Полностью очищаем старый HTML и оставляем ТОЛЬКО картинку и кнопку
      sc.innerHTML = `
        <div style="position: relative; max-width: 95%; max-height: 90vh; display: flex; flex-direction: column; align-items: center; justify-content: center;">
          <img id="img-controls-hint" src="${ASSET.hint}" alt="Управление" style="max-width: 100%; max-height: 78vh; border-radius: 12px; object-fit: contain; box-shadow: 0 8px 30px rgba(0,0,0,0.8);">
          <button id="btn-close-controls-injected" style="margin-top: 20px; padding: 12px 35px; font-size: 16px; border-radius: 10px; border: none; background: #ff6767; color: white; cursor: pointer; font-weight: bold; text-transform: uppercase; box-shadow: 0 4px 15px rgba(255,103,103,0.4);">Вернуться</button>
        </div>
      `;

      const closeBtn = $("btn-close-controls-injected");
      if (closeBtn) {
        closeBtn.onclick = () => showScreen(screenBeforeControls);
      }

      // Создаем кнопку "Управление" поверх игрового экрана
      const gameWrap = $("game-wrap") \vert{}\vert{} $("screen-game");
      if (gameWrap && !$("btn-open-controls-game")) {
        const btn = document.createElement("button");
        btn.id = "btn-open-controls-game";
        btn.innerHTML = "🎮 Управление";
        btn.style.position = "absolute";
        btn.style.top = "15px";
        btn.style.right = "15px";
        btn.style.zIndex = "1000";
        btn.style.padding = "10px 15px";
        btn.style.background = "rgba(20, 20, 25, 0.85)";
        btn.style.color = "#00d68f";
        btn.style.border = "2px solid #00d68f";
        btn.style.borderRadius = "10px";
        btn.style.cursor = "pointer";
        btn.style.fontWeight = "bold";
        btn.style.fontSize = "14px";
        btn.style.boxShadow = "0 4px 12px rgba(0,0,0,0.4)";
        btn.style.transition = "transform 0.2s, background 0.2s";

        btn.onmouseenter = () => btn.style.background = "rgba(0, 214, 143, 0.2)";
        btn.onmouseleave = () => btn.style.background = "rgba(20, 20, 25, 0.85)";

        btn.onclick = openControlsScreen;
        gameWrap.appendChild(btn);
      }
    }

    // Запускаем сборку интерфейса
    injectControlsUI();

    // ---------------------------------------------------------
    // Переключение экранов
    // ---------------------------------------------------------
    function showScreen(name) {
      screens.forEach((s) => {
        const el = $("screen-" + s);
        if (el) {
          const isActive = (s === name);
          el.classList.toggle("active", isActive);
          if (el.dataset.injected || s === "controls") {
            el.style.display = isActive ? "flex" : "none";
          }
        }
      });
    }

    function openControlsScreen() {
      const active = screens.find((s) => {
        const el = $("screen-" + s);
        return el && (el.classList.contains("active") || (el.style.display === "flex" && s !== "controls"));
      });
      if (active && active !== "controls") {
        screenBeforeControls = active;
      }
      updateControlsHintImage();
      showScreen("controls");
    }

    function updateControlsHintImage() {
      const hintImg = $("img-controls-hint");
      if (hintImg && ASSET.hint) {
        hintImg.src = ASSET.hint;
      }
    }

    const btnOpenControls = $("btn-open-controls");
    if (btnOpenControls) btnOpenControls.onclick = openControlsScreen;

    const btnCloseControls = $("btn-close-controls");
    if (btnCloseControls) btnCloseControls.onclick = () => showScreen(screenBeforeControls);

    // ---------------------------------------------------------
    // Загрузка Ассетов
    // ---------------------------------------------------------
    const charImg = {};        
    const imgReady = {};      

    function loadImage(src) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(img);
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

    // ---------------------------------------------------------
    // Глобальные переменные состояния
    // ---------------------------------------------------------
    let ws = null;
    let myId = null;
    let isHost = false;
    let selectedAvatar = AVATARS[0];
    let iAmThief = false;
    let roomCode = "";
    let desiredPlayers = 3;
    let roomMaxPlayers = 3;
    let latestLobbyPlayers = [];

    let world = { tile: 40, grid_w: 19, grid_h: 19, num_levels: 3, steal_range: 72 };
    let levels = [];
    let myLevel = 0;

    let players = {};
    let chestsState = [];
    let pilesState = [];

    const PLAYER_SIZE_RATIO = 0.55;
    const pileOffsetsCache = {};

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
    // Экран подключения (Join)
    // ---------------------------------------------------------
    function randomName() {
      const n = ["Лиса", "Сова", "Тигр", "Панда", "Ёж", "Кот", "Волк", "Заяц"];
      return n[Math.floor(Math.random() * n.length)] + Math.floor(Math.random() * 90 + 10);
    }
    
    if ($("input-name")) $("input-name").value = randomName();

    const pickerContainer = $("players-count-picker");
    if (pickerContainer) {
      pickerContainer.innerHTML = "";
      for (let i = 3; i <= 8; i++) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "player-count-btn " + (i === desiredPlayers ? "selected" : "");
        btn.textContent = i;
        btn.onclick = () => {
          desiredPlayers = i;
          document.querySelectorAll(".player-count-btn").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
        };
        pickerContainer.appendChild(btn);
      }
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initGame);
  } else {
    initGame();
  }
})();
