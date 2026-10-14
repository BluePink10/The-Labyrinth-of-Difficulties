// ============================================================
// Thief & Innocents — клиентский скрипт
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

    function injectControlsUI() {
      let sc = $("screen-controls");
      if (!sc) {
        sc = document.createElement("div");
        sc.id = "screen-controls";
        sc.className = "screen";
        document.body.appendChild(sc);
      }

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

    injectControlsUI();

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
      showScreen("controls");
    }

    const btnOpenControls = $("btn-open-controls");
    if (btnOpenControls) btnOpenControls.onclick = openControlsScreen;

    const btnCloseControls = $("btn-close-controls");
    if (btnCloseControls) btnCloseControls.onclick = () => showScreen(screenBeforeControls);

    let ws = null;
    let myId = null;
    let isHost = false;
    let selectedAvatar = AVATARS[0];
    let iAmThief = false;
    let roomCode = "";
    let desiredPlayers = 3;

    function randomName() {
      const n = ["Лиса", "Сова", "Тигр", "Панда", "Ёж", "Кот", "Волк", "Заяц"];
      return n[Math.floor(Math.random() * n.length)] + Math.floor(Math.random() * 90 + 10);
    }
    
    if ($("input-name")) $("input-name").value = randomName();

    // Рендер кнопок выбора количества игроков
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

    // Подключение к комнате
    async function createOrJoinRoom(code) {
      const name = ($("input-name")?.value || "").trim() || "Игрок";
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
          if ($("lobby-code")) $("lobby-code").textContent = roomCode;
          // Здесь обновляется список игроков в лобби стандартным образом
        } else if (msg.type === "error") {
          alert(msg.message);
        }
      };
    }

    const btnCreate = $("btn-create-room");
    if (btnCreate) {
      btnCreate.onclick = async () => {
        try {
          const res = await fetch(`/api/new_room?players=${desiredPlayers}`);
          const data = await res.json();
          createOrJoinRoom(data.room);
        } catch (e) {
          console.error(e);
        }
      };
    }

    const btnJoin = $("btn-join-room");
    if (btnJoin) {
      btnJoin.onclick = () => {
        const code = $("input-room")?.value || "";
        if (code.length >= 4) createOrJoinRoom(code);
      };
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initGame);
  } else {
    initGame();
  }
})();
