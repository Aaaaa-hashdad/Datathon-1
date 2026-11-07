"""
Treasure Hunt: a beginner reinforcement learning problem (Q-learning).

A robot starts at S on a 5x5 grid and must reach the treasure T.
    S . . . .
    . # . X .
    . # . . .
    . . . # .
    X . . . T
  #  = wall (can't move there)
  X  = trap (big penalty, episode ends)
  T  = treasure (big reward, episode ends)

Rewards:
  +100 reach treasure
  -100 fall in a trap
  -1   every step (so the agent prefers SHORT paths)

Run:  python treasure_hunt.py
"""

import random
import numpy as np

# ---------------- ENVIRONMENT ----------------
GRID = [
    "S....",
    ".#.X.",
    ".#...",
    "...#.",
    "X...T",
]
ROWS, COLS = len(GRID), len(GRID[0])
ACTIONS = [(-1, 0), (1, 0), (0, -1), (0, 1)]  # up, down, left, right
ACTION_ARROWS = ["↑", "↓", "←", "→"]


def to_state(r, c):
    """Turn (row, col) into a single number 0..24 (index into Q-table)."""
    return r * COLS + c


def reset():
    return (0, 0)  # start at top-left


def step(pos, action):
    """Apply an action. Returns (new_pos, reward, done)."""
    dr, dc = ACTIONS[action]
    r, c = pos[0] + dr, pos[1] + dc
    # bumping into the edge or a wall = stay in place
    if not (0 <= r < ROWS and 0 <= c < COLS) or GRID[r][c] == "#":
        r, c = pos
    cell = GRID[r][c]
    if cell == "T":
        return (r, c), 100, True
    if cell == "X":
        return (r, c), -100, True
    return (r, c), -1, False


# ---------------- AGENT (Q-learning) ----------------
Q = np.zeros((ROWS * COLS, len(ACTIONS)))  # Q[state, action] = "how good is this move"

alpha = 0.1      # learning rate: how much to update each time
gamma = 0.95     # discount: how much future rewards matter
epsilon = 1.0    # exploration rate: start fully random...
eps_decay = 0.995
eps_min = 0.05   # ...and slowly become greedy

EPISODES = 2000
history = []

for episode in range(EPISODES):
    pos = reset()
    total, done, steps = 0, False, 0
    while not done and steps < 100:
        s = to_state(*pos)
        # explore vs exploit
        if random.random() < epsilon:
            a = random.randrange(len(ACTIONS))
        else:
            a = int(np.argmax(Q[s]))

        new_pos, reward, done = step(pos, a)
        s2 = to_state(*new_pos)

        # THE Q-LEARNING UPDATE (Bellman equation)
        target = reward + (0 if done else gamma * np.max(Q[s2]))
        Q[s, a] += alpha * (target - Q[s, a])

        pos, total, steps = new_pos, total + reward, steps + 1

    epsilon = max(eps_min, epsilon * eps_decay)
    history.append(total)

    if (episode + 1) % 200 == 0:
        avg = np.mean(history[-200:])
        print(f"Episode {episode + 1:4d} | avg reward (last 200): {avg:7.1f} | epsilon: {epsilon:.2f}")


# ---------------- RESULTS ----------------
print("\nLearned policy (best move in each cell):")
for r in range(ROWS):
    row = ""
    for c in range(COLS):
        cell = GRID[r][c]
        row += f" {cell} " if cell in "#XT" else f" {ACTION_ARROWS[int(np.argmax(Q[to_state(r, c)]))]} "
    print(row)

print("\nGreedy run from start:")
pos, path, done = reset(), [reset()], False
while not done and len(path) < 30:
    pos, reward, done = step(pos, int(np.argmax(Q[to_state(*pos)])))
    path.append(pos)
print(" -> ".join(f"{p}" for p in path))
print("Reached treasure!" if GRID[pos[0]][pos[1]] == "T" else "Did not reach treasure.")
print(f"Steps taken: {len(path) - 1}  (shortest possible is 8)")
