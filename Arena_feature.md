## 1. What we are building

A live quiz arena. Many users are in the same arena. Everyone sees the **same
question at the same time**, has a few seconds to answer, then everyone sees the
**same result**, then the next question, and so on — in a loop.

### How the game plays (the user-facing flow)

- **Joining:**
  - If **nobody** is in the arena → a joining user **starts immediately**.
  - If a game **is already running** → a joining user **waits** and is let in
    **when the next question appears**.
- **Timers** (everyone's timer is in sync):
  - **Question timer** — based on the question's **difficulty level** (harder
    questions get more time):
    - **Easy** → **30 seconds**
    - **Medium** → **60 seconds**
    - **Hard** → **90 seconds**
  - **Result timer** — a fixed **15 seconds**.
  - **Waiting timer** — equals **question timer + result timer**, i.e. it runs
    **until the next question appears**.
- **Answering:** each user **selects one option out of 4** for the question.
- **Result screen** — shown in **all 3 cases** (correct, wrong, not attempted).
  Every result screen shows the **correct answer with its explanation**. The only
  thing that changes is whether a **graph** appears:
  - **Correct answer** → result screen **with a graph**: the user appears on it,
    ranked by **speed** (faster answers show ahead of slower ones).
  - **Wrong answer** → result screen **without a graph**.
  - **Not attempted** → result screen **without a graph**.

### What must always hold (the architecture guarantees)

- If a user's internet drops and comes back, they return to **exactly** where the
  game is now.
- If the **server crashes**, games are not lost forever.
- It can run on **many servers** later without a rewrite.
---



