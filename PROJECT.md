# Bultathon: Aggie Movement Tracker (TAMU Datathon 2026)

**Event:** TAMU Datathon, Nov 7–8, 2026, MSC
**Main challenge:** Build-A-Dataset (#3), plus **Best Use of Databricks** (#8) stacked on top
**One-liner:** We recorded how real Aggies move. A live computer-vision coach gives you feedback, then shows how you compare with Aggies across campus.

---

## The challenge (Build-A-Dataset)
> Leave the screen and collect your own original dataset during the event by observing, measuring, counting, photographing or surveying something in the real world. Then turn it into an interactive app (a map, game or tool) that your data actually powers. A small, carefully collected dataset can beat a huge, low-quality one.

**Prizes:** 1st Amazon Fire TV Soundbars · 2nd Fire TV Sticks 4K · 3rd MSY voucher + tray of mac & cheese
**Guide:** a Google Doc (needs login). Open it from the challenge page and check the deliverables and judging criteria.

---

## Pipeline
```
1. COLLECT  →  2. ANALYZE  →  3. RECOMMEND  →  4. AGGIE TRENDS
```

### 1. Data collection (on campus)
- Webcam station at the **Rec, MSC, Evans, Zach** (different spots, different times of day)
- Ask passers-by: "Howdy! Want a free form check? Takes 30 seconds."
- Get a verbal OK. **Save body keypoints only, no video.**
- 5 reps per person, then 3 tap-questions: year, college, workouts per week
- Goal: **40+ real Aggies**, which gives thousands of frame-level rows
- Take photos of the team at the stations (no respondents' faces)

**Fields per rep (anonymous, all numeric or categorical):**
| Field | Example |
|---|---|
| participant_id | A017 (random) |
| location | Rec Center |
| time_block | Morning / Afternoon / Evening / Night |
| year, college | Junior, Engineering |
| workout_freq | 0–7 days per week |
| rep_number | 1–5 |
| knee_angle_min, hip_angle, back_angle | 92°, 85°, 40° |
| rep_time_sec | 2.4 |
| form_score | 0–100 |
| mistake | not_deep / knees_in / back_round / none |

Raw frame keypoints (33 MediaPipe points) are saved in a separate file.

### 2. Analysis (per person)
- Joint angles per rep: depth, hip hinge, back angle, knee tracking
- Rep speed and consistency
- Form score (0–100) and the main mistake
- Fatigue: how much form drops from rep 1 to rep 5

### 3. Recommendation (personal, powered by the dataset)
- "Your depth is 104°. Aim for under 90°."
- "Your knees cave in on reps 4–5, so your form fades with fatigue."
- "You're in the top 30% of Aggies we measured."
- "Aggies who work out 3+ times a week tend to hold form X% longer."

### 4. Aggie trends (dashboard)
- Form score by year, college and workout frequency
- Fatigue curve across all Aggies
- Most common mistakes on campus
- By location: Rec regulars vs. MSC passers-by
- Headline findings, for example "X% of Aggies don't hit full depth"

---

## Tech
- **MediaPipe Pose:** a pretrained deep-learning model, 33 keypoints, runs in the browser. No training needed.
- Feedback comes from joint-angle math plus rep detection (an angle crosses a threshold and comes back).
- Store results as CSV, then load into **Databricks** for cleaning and analysis (for challenge #8).
- Optional: clustering to find "movement types", or regression of fatigue against workout frequency.
- **Open decisions:** movement (leaning **squats**) and platform (leaning **browser**).

---

## Prior art: ClimbDB (TAMU Datathon 2023, WON "Build Your Own" 1st place)
https://devpost.com/software/climbdb
- Recorded 40+ climbing videos at Stone Co. (College Station) and hand-logged 90+ tabular rows
- Pose estimation, XGBoost (92.3% route success prediction), unsupervised clustering of poses
- Findings: "Climbing is for everyone" (experience beats body type), "Climbing makes you stronger"
- Their recommendation system was **unfinished** ("ran out of time")

**What this tells us:** real-world pose data wins this track. Judges may remember it, so we have to go beyond it.

| ClimbDB (2023) | Us |
|---|---|
| Offline video analysis | **Live, real-time feedback** |
| One gym | **Several campus locations** |
| Mostly their own team | **40+ random Aggies** |
| Recommendation system unfinished | **Working recommendations** |
| Dataset + notebooks | **Interactive app + Aggie trends dashboard** |

**Pitch:** "In 2023, ClimbDB won this track with offline pose data from one gym. We built it live, across campus, on 40+ real Aggies, with working recommendations."

---

## Competition and odds (rough guess)
- Live CV form checkers are common at hackathons in general (Posture, Fizzzio, PocketSpotter, FormFocus, SquatSpot...).
- At TAMU Datathon, the only similar past project found was ClimbDB (2023, which won).
- Build-A-Dataset is probably a smaller track; most teams will do surveys or counting.
- Rough estimate: **top 3 about 50–65%** and **1st about 25–35%** if executed well; much lower if the data or demo is messy.

## What raises the odds
1. **Collect data first.** 40+ Aggies by midday Saturday.
2. Show the method clearly: locations, times, consent, no video.
3. One surprising headline finding.
4. A reliable live demo: good lighting, a plain background, and a backup video.
5. An Aggie hook, for example "How strong is the 12th Man?"
6. Do the analysis in Databricks so the project also counts for challenge #8.

---

## Other challenges this year (for reference)
1. Rev's Casino: trick an LLM, fewest tokens (no code)
2. Dashboard Royale: casino slot-machine dashboard
3. **Build-A-Dataset** ← us
4. House Edge: predict slot payout probabilities
5. Heads Up: poker bot tournament (MacBook prize)
6. Hitachi Hack the Highway: AI agents for supply chain
7. H‑E‑B: details at their table in person
8. **Best Use of Databricks** ← stack

## Older ideas (parked)
- "Who would answer *Here* for you?" Muster survey (files: `SURVEY.md`, `app/`)
- "Is Howdy dying?" Howdy-back observation map
- `rl/treasure_hunt.py`: Q-learning practice
