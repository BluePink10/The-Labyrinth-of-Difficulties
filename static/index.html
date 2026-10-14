// ============================================================
// Thief & Innocents — клиентский скрипт (Согласован с index.html)
// ============================================================
(() => {
  const initGame = () => {
    const $ = (id) => document.getElementById(id);

    const screens = ["join", "lobby", "role", "game", "vote", "result", "controls"];
    let screenBeforeControls = "join";

    const AVATARS = ["1", "2", "3", "4", "5", "6", "7", "8"];
    const charSrc = (id) => `/static/assets/${id}.png`;
    const ASSET = {
      stone: "/static/assets/stone.png",
      chest: "/static/assets/chest.png",
      diamond: "/static/assets/diamond.png",
      roleInnocent: "/static/assets/9.png",    
      roleThief: "/static/assets/10.png",     
      hint: "/static/assets/11.png",          
    };

    // ---------------------------------------------------------
    // Управление экранами
    // ---------------------------------------------------------
    function showScreen(name) {
      screens.forEach((s) => {
        const el = $("screen-" + s);
        if (el) {
          const isActive = (s === name);
          el.classList.toggle("active", isActive);
          el.style.display = isActive ? "flex" : "none";
        }
      });
    }

    // Принудительно показываем стартовый экран при запуске
    showScreen("join");

    // Обработчики экрана управления (из вашего HTML: btn-open-controls, btn-close-controls)
    const btnOpenControls = $("btn-open-controls");
    if (btnOpenControls) {
      btnOpenControls.onclick = () => {
        const active = screens.find(s => $("screen-" + s)?.classList.contains("active"));
        if (active && active !== "controls") screenBeforeControls = active;
        showScreen("controls");
      };
    }

    const btnCloseControls = $("btn-close-controls");
    if (btnCloseControls) {
      btnCloseControls.onclick = () => showScreen(screenBeforeControls);
    }

    // Дополнительная кнопка управления поверх игры
    const gameWrap = $("game-wrap") \vert{}\vert{} $("screen-game");
    if (gameWrap && !$("btn-open-controls-game")) {
      const btn = document.createElement("button");
      btn.id = "btn-open-controls-game";
      btn.innerHTML = "🎮 Управление";
      btn.style.cssText = "position: absolute; top: 15px; right: 15px; z-index: 1000; padding: 10px 15px; background: rgba(20, 20, 25, 0.85); color: #00d68f; border: 2px solid #00d68f; border-radius: 10px; cursor: pointer; font-weight: bold; font-size: 14px;";
      btn.onclick = () => {
        screenBeforeControls = "game";
        showScreen("controls");
      };
      gameWrap.appendChild(btn);
    }

    // ---------------------------------------------------------
    // Состояние игры и выбор количества игроков
    // ---------------------------------------------------------
    let ws = null;
    let myId = null;
    let isHost = false;
    let selectedAvatar = AVATARS[0];
    let desiredPlayers = 3;
    let roomCode = "";

    function randomName() {
      const n = ["Лиса", "Сова", "Тигр", "Панда", "Ёж", "Кот", "Волк", "Заяц"];
      return n[Math.floor(Math.random() * n.length)] + Math.floor(Math.random() * 90 + 10);
    }
    
    const nameInput = $("input-name");
    if (nameInput && !nameInput.value) {
      nameInput.value = randomName();
    }

    // Заполняем сетку выбора игроков (3 до 8) для элемента #players-count-picker из HTML
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
          pickerContainer.querySelectorAll(".player-count-btn").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
        };
        pickerContainer.appendChild(btn);
      }
    }

    // ---------------------------------------------------------
    // Подключение по WebSocket
    // ---------------------------------------------------------
    function createOrJoinRoom(code) {
      const name = (nameInput?.value || "").trim() || "Игрок";
      roomCode = code.toUpperCase().trim();
      
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/ws/${roomCode}`);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "join", name, avatar: selectedAvatar }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "joined") {
          myId = msg.you;
          isHost = msg.host;
          showScreen("lobby");
        } else if (msg.type === "lobby_state") {
          roomCode = msg.room;
          isHost = (msg.host === myId);
          if ($("lobby-room-code")) $("lobby-room-code").textContent = roomCode;
        } else if (msg.type === "error") {
          const errEl = $("join-error");
          if (errEl) errEl.textContent = msg.message;
          else alert(msg.message);
        }
      };
    }

    // Кнопка создания комнаты (#btn-create в вашем HTML)
    const btnCreate = $("btn-create");
    if (btnCreate) {
      btnCreate.onclick = async () => {
        try {
          const res = await fetch(`/api/new_room?players=${desiredPlayers}`);
          const data = await res.json();
          if (data.room) {
            createOrJoinRoom(data.room);
          }
        } catch (e) {
          console.error("Ошибка при создании комнаты:", e);
        }
      };
    }

    // Кнопка входа по коду (#btn-join в вашем HTML)
    const btnJoin = $("btn-join");
    if (btnJoin) {
      btnJoin.onclick = () => {
        const code = ($("input-room")?.value || "").trim();
        if (code.length >= 4) {
          createOrJoinRoom(code);
        } else {
          const errEl = $("join-error");
          if (errEl) errEl.textContent = "Введите корректный код комнаты";
          else alert("Введите корректный код комнаты");
        }
      };
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initGame);
  } else {
    initGame();
  }
})();
