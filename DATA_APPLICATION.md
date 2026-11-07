
# Data application: squat processing

## Run
From phone-cam, run npm install and npm run server.
Open http://localhost:8080 and connect the phone using the existing QR flow.
In Squat coach, confirm consent, enter anonymous metadata, and start.
Stand upright, perform squats, return upright, then finish the session.

## Files
- public/analysis.mjs: rep detection, scoring, feedback, summaries and exports.
- public/workout.mjs: tracking-event integration, session controls and downloads.
- public/viewer.html: interactive coach panel.
- test/analysis.test.mjs: synthetic unit-test fixtures, not primary collected data.

Run tests from the repository root:
node --test phone-cam/test/analysis.test.mjs

## Processing rules
Observe a knee angle >=160 degrees before starting.
Enter a squat below 145 degrees and complete it at >=160 degrees.
Use the same leg throughout the rep.
Missing tracking or a gap over 750 ms invalidates partial reps.
Ignore non-increasing timestamps.
Accept reps with at least five samples and duration 0.6–15 seconds.

Depth = minimum observed knee angle.
Hip angle = observed hip angle at the minimum-knee-angle frame.
Depth subscore = max(0, 100 - 2 * max(0, depth - 100)).
Tempo subscore = min(100, seconds / 1.5 * 100).
Final score = 80% depth subscore + 20% tempo subscore.
Flag not_deep above 100 degrees; flag too_fast below 1.5 seconds.

These are prototype targets requiring calibration against manually reviewed
event recordings. They do not establish clinical safety, strength, knee cave,
spinal rounding or physical efficiency.

## Data and storage
Session summaries persist in browser localStorage.
Raw pose frames remain in memory for the latest live session only,
capped at 30,000 frames. Export before closing.
Images, hands and face landmarks are not included in these exports.
Body keypoints and collector metadata still require consent and publication review.

Rep CSV fields:
session_id, participant_id, location, time_block, year, college,
workout_freq, rep_number, knee_angle_min, hip_angle, rep_time_sec,
side, form_score, mistake, frame_count, rule_version.
Optional survey fields are blank unless supplied programmatically.

Angles are degrees, durations are seconds, frame timestamps are milliseconds.
Session JSON also contains collection time, source, metadata and all mistake flags.
Frame JSON is an array of {t, pose} with pose.angles containing
"L knee", "R knee", "L hip" and "R hip".
Import this frame format for offline processing; session summary JSON is
a separate output. Import each real recording once to avoid duplication.

Tempo consistency is population standard deviation of rep durations.
First-to-last score drop describes variation; it does not prove fatigue.
Peer comparisons weight sessions equally, exclude the current session,
and require five other sessions. Repeat participants are possible.
Results describe saved sessions, not campus prevalence.

No real workout dataset was present during implementation.
Document actual collection methods, dates, sampling, participant counts,
rejected recordings and limitations alongside the collected dataset.
CSV can be imported into Databricks; no Databricks connection is implemented.
