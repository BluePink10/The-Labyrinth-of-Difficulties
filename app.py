import asyncio
import json
import random
from typing import Dict, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

app = FastAPI()

# Подключаем папку со статическими файлами (html, css, js, картинки)
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def read_index():
    return FileResponse("static/index.html")

# Константы игры
GRID_WIDTH = 21
GRID_HEIGHT = 21
TILE = 32
PLAYER_SPEED = 120   # пикселей в секунду
STEAL_RANGE = TILE * 1.5

class Player:
    def __init__(self, websocket: WebSocket, player_id: str, name: str):
        self.ws = websocket
        self.id = player_id
        self.name = name
        self.x = TILE * 1.5
        self.y = TILE * 1.5
        self.role = "innocent"  # "innocent" или "thief"
        self.diamonds = 0
        self.ready = False
        self.voted_for: Optional[str] = None
        self.connected = True

class Room:
    def __init__(self, room_id: str):
        self.id = room_id
        self.players: Dict[str, Player] = {}
        self.state = "LOBBY"  # LOBBY, ROLE, PLAY, VOTE, RESULT
        self.maze = generate_eller_maze(GRID_WIDTH, GRID_HEIGHT)
        self.lock = asyncio.Lock()
        self.game_task: Optional[asyncio.Task] = None
        self.round_timer = 180  # 3 минуты

    def alive_players(self) -> List[Player]:
        return [p for p in self.players.values() if p.connected]

    async def broadcast(self, data: dict):
        raw = json.dumps(data)
        for p in self.players.values():
            if p.connected:
                try:
                    await p.ws.send_text(raw)
                except Exception:
                    p.connected = False

    async def maybe_begin_play(self):
        active = self.alive_players()
        if active and all(p.ready for p in active):
            self.state = "PLAY"
            if active:
                thief = random.choice(active)
                thief.role = "thief"
            
            await self.broadcast({
                "type": "start_play",
                "maze": self.maze,
                "players": {p.id: {"role": p.role, "x": p.x, "y": p.y} for p in active}
            })

    async def maybe_finish_vote(self):
        active = self.alive_players()
        voted_count = sum(1 for p in active if p.voted_for is not None)
        
        if voted_count >= len(active) and len(active) > 0:
            self.state = "RESULT"
            votes = {}
            for p in active:
                if p.voted_for:
                    votes[p.voted_for] = votes.get(p.voted_for, 0) + 1
            
            exiled = max(votes, key=votes.get) if votes else None
            thief_player = next((p for p in active if p.role == "thief"), None)
            
            thief_caught = (exiled == thief_player.id) if thief_player else False
            
            await self.broadcast({
                "type": "game_over",
                "thief_caught": thief_caught,
                "thief_id": thief_player.id if thief_player else None,
                "votes": votes
            })

rooms: Dict[str, Room] = {}

def generate_eller_maze(width: int, height: int):
    maze = [[1 for _ in range(width)] for _ in range(height)]
    for y in range(1, height, 2):
        for x in range(1, width, 2):
            maze[y][x] = 0
            if x + 2 < width:
                maze[y][x+1] = 0
            if y + 2 < height:
                maze[y+1][x] = 0
    return maze

def check_line_of_sight(x1: float, y1: float, x2: float, y2: float, maze) -> bool:
    mid_x = (x1 + x2) / 2
    mid_y = (y1 + y2) / 2
    gx = int(mid_x // TILE)
    gy = int(mid_y // TILE)
    if 0 <= gy < len(maze) and 0 <= gx < len(maze[0]):
        if maze[gy][gx] == 1:
            return False
    return True

@app.websocket("/ws/{room_id}/{player_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, player_id: str):
    await websocket.accept()
    
    if room_id not in rooms:
        rooms[room_id] = Room(room_id)
        rooms[room_id].game_task = asyncio.create_task(game_loop(rooms[room_id]))
        
    room = rooms[room_id]
    
    player = Player(websocket, player_id, f"Player_{player_id[:4]}")
    async with room.lock:
        room.players[player_id] = player

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                continue
                
            m_type = msg.get("type")

            async with room.lock:
                if m_type == "ready":
                    player.ready = True
                    await room.maybe_begin_play()
                
                elif m_type == "move":
                    if room.state == "PLAY":
                        nx = msg.get("x", player.x)
                        ny = msg.get("y", player.y)
                        gx, gy = int(nx // TILE), int(ny // TILE)
                        if 0 <= gy < len(room.maze) and 0 <= gx < len(room.maze[0]):
                            if room.maze[gy][gx] == 0:
                                player.x = nx
                                player.y = ny

                elif m_type == "steal":
                    if room.state == "PLAY" and player.role == "thief":
                        target_id = msg.get("target_id")
                        target = room.players.get(target_id)
                        if target and target.role == "innocent" and target.diamonds > 0:
                            dist = ((target.x - player.x)**2 + (target.y - player.y)**2)**0.5
                            if dist <= STEAL_RANGE and check_line_of_sight(player.x, player.y, target.x, target.y, room.maze):
                                target.diamonds -= 1
                                player.diamonds += 1

                elif m_type == "vote":
                    if room.state == "VOTE":
                        player.voted_for = msg.get("target_id")
                        await room.maybe_finish_vote()

    except WebSocketDisconnect:
        pass
    finally:
        async with room.lock:
            player.connected = False
            if room.state == "VOTE":
                await room.maybe_finish_vote()
            elif room.state == "ROLE" or room.state == "LOBBY":
                await room.maybe_begin_play()
            
            if not room.alive_players():
                if room.game_task:
                    room.game_task.cancel()
                rooms.pop(room_id, None)

async def game_loop(room: Room):
    dt = 0.05
    try:
        while room.state != "RESULT":
            await asyncio.sleep(dt)
            async with room.lock:
                if room.state == "PLAY":
                    room.round_timer -= dt
                    if room.round_timer <= 0:
                        room.state = "VOTE"
                    
                    snapshot = {
                        "type": "state_sync",
                        "timer": room.round_timer,
                        "players": {
                            p.id: {"x": p.x, "y": p.y, "diamonds": p.diamonds} 
                            for p in room.alive_players()
                        }
                    }
                else:
                    snapshot = None
            
            if snapshot:
                await room.broadcast(snapshot)
    except asyncio.CancelledError:
        pass
