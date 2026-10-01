"""
Thief & Innocents — web multiplayer backend.

От 3 до 8 игроков в комнате: 1 вор + остальные мирные жители.
Сервер авторитетен: хранит состояние комнаты, считает физику,
и рассылает снимки состояния всем клиентам по WebSocket.

Запуск локально:
    pip install -r requirements.txt
    uvicorn app:app --host 0.0.0.0 --port 7860
"""

import asyncio
import json
import random
import string
import uuid
from collections import defaultdict
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.middleware.base import BaseHTTPMiddleware

# ==========================================================
# Игровые константы
# ==========================================================
MAZE_W = 9                     # ширина лабиринта в "ячейках" (не тайлах)
MAZE_H = 9
GRID_W = MAZE_W * 2 + 1        # ширина сетки тайлов
GRID_H = MAZE_H * 2 + 1
NUM_LEVELS = 3

TILE = 40                      # логический размер тайла (пиксели "игрового мира")
WORLD_W = GRID_W * TILE
WORLD_H = GRID_H * TILE

PLAYER_SIZE = TILE * 0.55
PLAYER_SPEED = 190.0           # логических единиц в секунду
TICK_RATE = 20                 # обновлений в секунду
DT = 1.0 / TICK_RATE

GAME_DURATION = 210.0          # секунд на раунд (3.5 мин)
CHEST_OPEN_MS = 2200
CHEST_DECAY_MULT = 1.6
STEAL_COOLDOWN_MS = 9000
STEAL_RANGE = TILE * 1.8

# Аватарки — идентификаторы спрайтов static/assets/<id>.png (1..8)
AVATARS = [str(i) for i in range(1, 9)]

# Размер комнаты: от 3 до 8 игроков (ограничено количеством аватарок —
# каждому игроку достаётся уникальный персонаж).
MIN_PLAYERS = 3
MAX_PLAYERS = len(AVATARS)

ROOM_CODE_CHARS = string.ascii_uppercase + string.digits


# ==========================================================
# Генерация лабиринта (алгоритм Эллера) — логика из оригинала
# ==========================================================
def generate_ellers_maze(width, height, is_top_open, is_bottom_open):
    grid_width = width * 2 + 1
    grid_height = height * 2 + 1
    maze = [[0] * grid_width for _ in range(grid_height)]
    current_row_sets = list(range(width))
    next_set_id = width

    for y_idx in range(height):
        grid_y = y_idx * 2 + 1
        for x_idx in range(width):
            maze[grid_y][x_idx * 2 + 1] = 1

        for x_idx in range(width - 1):
            grid_x = x_idx * 2 + 1
            if current_row_sets[x_idx] != current_row_sets[x_idx + 1]:
                if y_idx == height - 1 or random.choice([True, False]):
                    old_set = current_row_sets[x_idx + 1]
                    new_set = current_row_sets[x_idx]
                    for i in range(width):
                        if current_row_sets[i] == old_set:
                            current_row_sets[i] = new_set
                    maze[grid_y][grid_x + 1] = 1

        if y_idx < height - 1:
            next_row_sets = [None] * width
            set_groups = defaultdict(list)
            for x_idx, s_id in enumerate(current_row_sets):
                set_groups[s_id].append(x_idx)

            for s_id, indices in set_groups.items():
                num_downs = random.randint(1, len(indices))
                downs = random.sample(indices, num_downs)
                for x_idx in downs:
                    grid_x = x_idx * 2 + 1
                    maze[grid_y + 1][grid_x] = 1
                    next_row_sets[x_idx] = s_id

            for x_idx in range(width):
                if next_row_sets[x_idx] is None:
                    next_row_sets[x_idx] = next_set_id
                    next_set_id += 1
            current_row_sets = next_row_sets

    mid_x = (grid_width // 2) if (grid_width // 2) % 2 == 1 else (grid_width // 2) - 1
    if is_top_open:
        maze[0][mid_x] = 1
    if is_bottom_open:
        maze[grid_height - 1][mid_x] = 1
    return maze, mid_x


def get_dead_ends(maze):
    dead_ends = []
    for y in range(1, len(maze) - 1):
        for x in range(1, len(maze[0]) - 1):
            if maze[y][x] == 1:
                neighbors = [maze[y - 1][x], maze[y + 1][x], maze[y][x - 1], maze[y][x + 1]]
                if neighbors.count(0) == 3:
                    dead_ends.append((x, y))
    return dead_ends


def generate_level_data(level_index):
    is_top_open = level_index > 0
    is_bot_open = level_index < NUM_LEVELS - 1
    maze, exit_x = generate_ellers_maze(MAZE_W, MAZE_H, is_top_open, is_bot_open)
    dead_ends = get_dead_ends(maze)
    random.shuffle(dead_ends)

    chests_count = min(3, len(dead_ends))
    chest_tiles = dead_ends[:chests_count]
    diamond_tiles = dead_ends[chests_count:]

    chests = [
        {"id": f"c{level_index}_{i}", "x": cx, "y": cy, "opened": False, "progress": 0}
        for i, (cx, cy) in enumerate(chest_tiles)
    ]

    diamond_piles = []
    for i, (dx, dy) in enumerate(diamond_tiles):
        if random.random() < 0.66:
            diamond_piles.append({
                "id": f"d{level_index}_{i}",
                "x": dx, "y": dy,
                "count": random.randint(4, 8),
                "collected": False,
            })

    return {"maze": maze, "exit_x": exit_x, "chests": chests, "diamond_piles": diamond_piles}


# ==========================================================
# Вспомогательная физика (прямоугольники в логических пикселях)
# ==========================================================
def rects_overlap(ax, ay, aw, ah, bx, by, bw, bh):
    return ax < bx + bw and ax + aw > bx and ay < by + bh and ay + ah > by


# ==========================================================
# Игрок (серверное состояние)
# ==========================================================
class Player:
    def __init__(self, pid, name, avatar, ws):
        self.id = pid
        self.name = name[:16] if name else "Игрок"
        self.avatar = avatar if avatar in AVATARS else AVATARS[0]
        self.ws = ws
        self.connected = True
        self.ready = False       # готов после экрана роли
        self.is_thief = False

        self.level = 0
        self.x = 0.0
        self.y = 0.0
        self.diamonds = 0

        self.input = {"up": False, "down": False, "left": False, "right": False}
        self.action_held = False
        self.is_opening = False
        self.steal_cd_ms = 0

        self.vote: Optional[str] = None

    def spawn(self, level_data_list, level_index, at_top):
        self.level = level_index
        exit_x = level_data_list[level_index]["exit_x"]
        ty = 1 if at_top else GRID_H - 2
        self.x = exit_x * TILE + (TILE - PLAYER_SIZE) / 2
        self.y = ty * TILE + (TILE - PLAYER_SIZE) / 2

    def public_dict(self):
        return {
            "id": self.id, "name": self.name, "avatar": self.avatar,
            "level": self.level, "x": round(self.x, 1), "y": round(self.y, 1),
            "diamonds": self.diamonds, "opening": self.is_opening,
            "steal_cd": self.steal_cd_ms, "connected": self.connected,
        }


# ==========================================================
# Комната
# ==========================================================
class Room:
    def __init__(self, code, max_players=MIN_PLAYERS):
        self.code = code
        self.max_players = max(MIN_PLAYERS, min(MAX_PLAYERS, max_players))
        self.players: dict[str, Player] = {}
        self.host_id: Optional[str] = None
        self.state = "LOBBY"   # LOBBY -> ROLE -> PLAY -> VOTE -> RESULT
        self.levels = []
        self.timer = GAME_DURATION
        self.events = []       # временные события (кражи) для текущего тика
        self.loop_task: Optional[asyncio.Task] = None
        self.lock = asyncio.Lock()
        self.result = None

    def alive_players(self):
        return [p for p in self.players.values() if p.connected]

    def taken_avatars(self, exclude_id=None):
        return {p.avatar for p in self.players.values() if p.id != exclude_id}

    def pick_avatar(self, requested, exclude_id=None):
        """Вернуть requested, если он свободен, иначе первый свободный аватар."""
        taken = self.taken_avatars(exclude_id)
        if requested in AVATARS and requested not in taken:
            return requested
        for a in AVATARS:
            if a not in taken:
                return a
        return AVATARS[0]  # не должно происходить: MAX_PLAYERS <= len(AVATARS)

    async def broadcast(self, payload: dict):
        dead = []
        data = json.dumps(payload, ensure_ascii=False)
        for p in list(self.players.values()):
            if not p.connected:
                continue
            try:
                await p.ws.send_text(data)
            except Exception:
                dead.append(p.id)
        for pid in dead:
            self.players[pid].connected = False

    async def send_to(self, player: "Player", payload: dict):
        try:
            await player.ws.send_text(json.dumps(payload, ensure_ascii=False))
        except Exception:
            player.connected = False

    def lobby_snapshot(self):
        return {
            "type": "lobby_state",
            "room": self.code,
            "host": self.host_id,
            "players": [
                {"id": p.id, "name": p.name, "avatar": p.avatar, "ready": p.ready}
                for p in self.players.values()
            ],
            "max_players": self.max_players,
        }

    async def try_start_game(self):
        if self.state != "LOBBY":
            return
        if len(self.players) != self.max_players:
            return
        self.levels = [generate_level_data(i) for i in range(NUM_LEVELS)]
        pids = list(self.players.keys())
        thief_id = random.choice(pids)
        for p in self.players.values():
            p.is_thief = (p.id == thief_id)
            p.ready = False
            p.diamonds = 0
            p.steal_cd_ms = 0
            p.spawn(self.levels, 0, at_top=True)
        self.state = "ROLE"
        self.timer = GAME_DURATION

        static_levels = [
            {"maze": lvl["maze"], "exit_x": lvl["exit_x"],
             "chests": [{"id": c["id"], "x": c["x"], "y": c["y"]} for c in lvl["chests"]],
             "diamond_piles": [{"id": d["id"], "x": d["x"], "y": d["y"], "count": d["count"]} for d in lvl["diamond_piles"]]}
            for lvl in self.levels
        ]
        for p in self.players.values():
            await self.send_to(p, {
                "type": "game_start",
                "you": p.id,
                "is_thief": p.is_thief,
                "levels": static_levels,
                "world": {"tile": TILE, "grid_w": GRID_W, "grid_h": GRID_H,
                          "num_levels": NUM_LEVELS, "steal_range": STEAL_RANGE},
                "duration": GAME_DURATION,
            })

    async def maybe_begin_play(self):
        if self.state == "ROLE" and all(p.ready for p in self.players.values()) and len(self.players) == self.max_players:
            self.state = "PLAY"
            await self.broadcast({"type": "play_start", "duration": self.timer})
            self.loop_task = asyncio.create_task(self.run_game_loop())

    async def run_game_loop(self):
        try:
            while self.state == "PLAY":
                await asyncio.sleep(DT)
                async with self.lock:
                    self.update_physics(DT)
                    self.timer -= DT
                    if self.timer <= 0:
                        self.timer = 0
                        self.state = "VOTE"
                        await self.broadcast({"type": "vote_start"})
                        break
                    await self.broadcast(self.snapshot())
        except asyncio.CancelledError:
            pass

    def update_physics(self, dt):
        for p in self.alive_players():
            if p.steal_cd_ms > 0:
                p.steal_cd_ms = max(0, p.steal_cd_ms - int(dt * 1000))

            dx = dy = 0.0
            if p.input["left"]:
                dx -= 1
            if p.input["right"]:
                dx += 1
            if p.input["up"]:
                dy -= 1
            if p.input["down"]:
                dy += 1
            if dx != 0 and dy != 0:
                dx *= 0.7071
                dy *= 0.7071

            maze = self.levels[p.level]["maze"]
            step = PLAYER_SPEED * dt
            if dx != 0:
                nx = p.x + dx * step
                if not self.collides(nx, p.y, maze):
                    p.x = nx
            if dy != 0:
                ny = p.y + dy * step
                if not self.collides(p.x, ny, maze):
                    p.y = ny

            # переход между этажами
            if p.y < -PLAYER_SIZE / 2 and p.level > 0:
                p.level -= 1
                p.spawn(self.levels, p.level, at_top=False)
            elif p.y > WORLD_H - PLAYER_SIZE / 2 and p.level < NUM_LEVELS - 1:
                p.level += 1
                p.spawn(self.levels, p.level, at_top=True)

            # сбор алмазов
            for pile in self.levels[p.level]["diamond_piles"]:
                if pile["collected"]:
                    continue
                px, py = pile["x"] * TILE, pile["y"] * TILE
                if rects_overlap(p.x, p.y, PLAYER_SIZE, PLAYER_SIZE, px, py, TILE, TILE):
                    pile["collected"] = True
                    p.diamonds += pile["count"]

        # сундуки: раздельно по уровням, чтобы decay применялся честно
        openers_by_chest = defaultdict(list)
        for p in self.alive_players():
            p.is_opening = False
        for p in self.alive_players():
            if not p.action_held:
                continue
            for chest in self.levels[p.level]["chests"]:
                if chest["opened"]:
                    continue
                cx, cy = chest["x"] * TILE, chest["y"] * TILE
                if rects_overlap(p.x, p.y, PLAYER_SIZE, PLAYER_SIZE, cx - 8, cy - 8, TILE + 16, TILE + 16):
                    openers_by_chest[chest["id"]].append(p)

        for lvl in self.levels:
            for chest in lvl["chests"]:
                if chest["opened"]:
                    continue
                openers = openers_by_chest.get(chest["id"], [])
                if openers:
                    chest["progress"] += DT * 1000
                    for op in openers:
                        op.is_opening = True
                    if chest["progress"] >= CHEST_OPEN_MS:
                        chest["opened"] = True
                        reward = random.randint(15, 25)
                        winner = openers[0]
                        winner.diamonds += reward
                        self.events.append({"type": "chest", "player": winner.id, "amount": reward})
                else:
                    chest["progress"] = max(0.0, chest["progress"] - DT * 1000 * CHEST_DECAY_MULT)

    def collides(self, x, y, maze):
        left = int(x // TILE)
        right = int((x + PLAYER_SIZE) // TILE)
        top = int(y // TILE)
        bottom = int((y + PLAYER_SIZE) // TILE)
        for ty in range(max(0, top), min(GRID_H - 1, bottom) + 1):
            for tx in range(max(0, left), min(GRID_W - 1, right) + 1):
                if maze[ty][tx] == 0:
                    if rects_overlap(x, y, PLAYER_SIZE, PLAYER_SIZE, tx * TILE, ty * TILE, TILE, TILE):
                        return True
        return False

    def try_steal(self, thief: Player):
        if not thief.is_thief or thief.steal_cd_ms > 0:
            return
        best, best_dist = None, None
        for other in self.alive_players():
            if other.id == thief.id or other.level != thief.level:
                continue
            dist = ((other.x - thief.x) ** 2 + (other.y - thief.y) ** 2) ** 0.5
            if dist <= STEAL_RANGE and other.diamonds > 0:
                if best is None or dist < best_dist:
                    best, best_dist = other, dist
        if best is None:
            return
        amount = min(10 if best.is_opening else 3, best.diamonds)
        if amount <= 0:
            return
        best.diamonds -= amount
        thief.diamonds += amount
        thief.steal_cd_ms = STEAL_COOLDOWN_MS
        self.events.append({"type": "steal", "thief": thief.id, "target": best.id, "amount": amount})

    def snapshot(self):
        chests_by_level = [
            [{"id": c["id"], "opened": c["opened"], "progress": c["progress"]} for c in lvl["chests"]]
            for lvl in self.levels
        ]
        piles_by_level = [
            [{"id": d["id"], "collected": d["collected"]} for d in lvl["diamond_piles"]]
            for lvl in self.levels
        ]
        snap = {
            "type": "state",
            "timer": round(self.timer, 1),
            "players": [p.public_dict() for p in self.players.values()],
            "chests": chests_by_level,
            "diamond_piles": piles_by_level,
            "events": self.events,
        }
        self.events = []
        return snap

    async def maybe_finish_vote(self):
        if self.state != "VOTE":
            return
        voters = [p for p in self.players.values() if p.connected]
        if not voters or not all(p.vote for p in voters):
            return
        tally = defaultdict(int)
        for p in voters:
            tally[p.vote] += 1

        thief = next(p for p in self.players.values() if p.is_thief)
        thief_votes = tally.get(thief.id, 0)
        # Строгое большинство от числа проголосовавших (например, 2 из 3, 5 из 8).
        innocents_win = thief_votes > len(voters) / 2

        self.state = "RESULT"
        self.result = {
            "type": "result",
            "thief": {"id": thief.id, "name": thief.name, "avatar": thief.avatar},
            "votes": {pid: v for pid, v in ((p.id, p.vote) for p in self.players.values())},
            "tally": tally,
            "scores": [{"id": p.id, "name": p.name, "diamonds": p.diamonds} for p in self.players.values()],
            "innocents_win": innocents_win,
        }
        await self.broadcast(self.result)


# ==========================================================
# Менеджер комнат
# ==========================================================
rooms: dict[str, Room] = {}
rooms_lock = asyncio.Lock()


def gen_room_code():
    return "".join(random.choice(ROOM_CODE_CHARS) for _ in range(4))


app = FastAPI()


class NoCacheForCodeMiddleware(BaseHTTPMiddleware):
    """
    Браузеры любят агрессивно кэшировать .html/.js/.css, из-за чего после
    обновления игры часть устройств какое-то время видит старую версию.
    Заставляем их каждый раз перепроверять актуальность файла у сервера
    (быстрый 304 Not Modified, если файл не менялся) — картинки при этом
    по-прежнему кэшируются нормально, они тяжёлые и меняются редко.
    """
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if request.url.path.endswith((".html", ".js", ".css")) or request.url.path == "/":
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


app.add_middleware(NoCacheForCodeMiddleware)


@app.get("/")
async def index():
    return FileResponse("static/index.html")


@app.get("/api/new_room")
async def api_new_room(players: int = MIN_PLAYERS):
    async with rooms_lock:
        code = gen_room_code()
        while code in rooms:
            code = gen_room_code()
        rooms[code] = Room(code, max_players=players)
    return {"room": code, "max_players": rooms[code].max_players}


@app.websocket("/ws/{room_code}")
async def ws_endpoint(websocket: WebSocket, room_code: str):
    room_code = room_code.upper().strip()
    await websocket.accept()

    async with rooms_lock:
        room = rooms.get(room_code)
        if room is None:
            room = Room(room_code)
            rooms[room_code] = room

    player: Optional[Player] = None
    try:
        raw = await websocket.receive_text()
        msg = json.loads(raw)
        if msg.get("type") != "join":
            await websocket.close()
            return

        async with room.lock:
            if room.state != "LOBBY" or len(room.players) >= room.max_players:
                await websocket.send_text(json.dumps({"type": "error", "message": "Комната заполнена или игра уже началась."}))
                await websocket.close()
                return

            pid = uuid.uuid4().hex[:8]
            name = str(msg.get("name") or "Игрок")
            avatar = room.pick_avatar(msg.get("avatar"))
            player = Player(pid, name, avatar, websocket)
            room.players[pid] = player
            if room.host_id is None:
                room.host_id = pid

            await websocket.send_text(json.dumps({
                "type": "joined", "you": pid, "host": room.host_id == pid,
                "avatar": avatar, "max_players": room.max_players,
            }))
            await room.broadcast(room.lobby_snapshot())

        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            mtype = msg.get("type")

            async with room.lock:
                if mtype == "set_avatar":
                    av = msg.get("avatar")
                    if av in AVATARS and av not in room.taken_avatars(exclude_id=player.id):
                        player.avatar = av
                    await room.broadcast(room.lobby_snapshot())

                elif mtype == "set_name":
                    nm = str(msg.get("name") or "").strip()
                    if nm:
                        player.name = nm[:16]
                    await room.broadcast(room.lobby_snapshot())

                elif mtype == "start_game":
                    if room.host_id == player.id and room.state == "LOBBY":
                        await room.try_start_game()

                elif mtype == "role_ack":
                    if room.state == "ROLE":
                        player.ready = True
                        await room.maybe_begin_play()

                elif mtype == "input":
                    if room.state == "PLAY":
                        for k in ("up", "down", "left", "right"):
                            if k in msg:
                                player.input[k] = bool(msg[k])

                elif mtype == "action":
                    if room.state == "PLAY":
                        player.action_held = bool(msg.get("held"))

                elif mtype == "steal":
                    if room.state == "PLAY":
                        room.try_steal(player)

                elif mtype == "vote":
                    if room.state == "VOTE":
                        target = msg.get("target")
                        if target in room.players:
                            player.vote = target
                            await room.broadcast({"type": "vote_progress",
                                                   "voted": [p.id for p in room.players.values() if p.vote]})
                            await room.maybe_finish_vote()

                elif mtype == "leave":
                    break

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if player is not None:
            async with room.lock:
                player.connected = False
                if room.state == "LOBBY":
                    room.players.pop(player.id, None)
                    if room.host_id == player.id:
                        room.host_id = next(iter(room.players), None)
                    await room.broadcast(room.lobby_snapshot())
                else:
                    await room.broadcast({"type": "player_left", "id": player.id})
            if not room.players or all(not p.connected for p in room.players.values()):
                async with rooms_lock:
                    t = room.loop_task
                    if t:
                        t.cancel()
                    rooms.pop(room.code, None)


app.mount("/static", StaticFiles(directory="static"), name="static")
