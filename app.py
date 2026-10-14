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

# Размер комнаты: от 3 до 8 игроков
MIN_PLAYERS = 3
MAX_PLAYERS = len(AVATARS)

ROOM_CODE_CHARS = string.ascii_uppercase + string.digits


# ==========================================================
# Генерация лабиринта (алгоритм Эллера) + Тайные комнаты
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

    # Создаем тайные проходы из тупиков в стены
    for _ in range(min(2, len(dead_ends))):
        if not dead_ends:
            break
        cx, cy = dead_ends.pop()
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nx, ny = cx + dx, cy + dy
            if 0 <= ny < GRID_H and 0 <= nx < GRID_W and maze[ny][nx] == 0:
                maze[ny][nx] = 1  # Открываем тайный проход
                break

    chests_count = min(3, len(dead_ends))
    chest_tiles = dead_ends[:chests_count]
    diamond_tiles = dead_ends[chests_count:]

    chests = [
        {"id": f"c{level_index}_{i}", "x": cx, "y": cy, "opened": False, "progress": 0}
        for i, (cx, cy) in enumerate(chest_tiles)
    ]

    diamond_piles = []
    for i, (dx, dy) in enumerate(diamond
