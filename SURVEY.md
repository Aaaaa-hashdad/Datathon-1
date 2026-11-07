# "Who Would Answer Here?" — Survey form

Build this as a **Google Form** (anonymous: don't collect emails). Link it to a Google Sheet.
The app finds columns by **keywords in the question titles**, so keep the bold words in each title.

| # | Question title (keep the bold keyword) | Type | Options |
|---|---|---|---|
| 1 | **Location** (surveyor fills) | Dropdown | MSC, Evans Library, Zach, Rec Center, Commons, Mays, Kyle Field, Bus Stop, Other |
| 2 | **Year** | Multiple choice | Freshman, Sophomore, Junior, Senior, Grad |
| 3 | **College** | Multiple choice | Engineering, Mays Business, Arts & Sciences, AgriLife, Education, Health, Arch / PVFA, Other |
| 4 | Are you a **transfer** student? | Multiple choice | Yes, No |
| 5 | Are you a **first**-generation college student? | Multiple choice | Yes, No |
| 6 | Are you from **Texas**? | Multiple choice | Yes, No |
| 7 | If your name were called at Muster, how many people at A&M would answer "**Here**" for you? | Multiple choice | 0, 1, 2, 3, 4, 5+ |
| 8 | How much do you feel you **belong** at A&M? | Linear scale 1–5 | 1 = Not at all, 5 = Completely |
| 9 | How **lonely** do you feel at A&M? | Linear scale 1–5 | 1 = Never, 5 = Very often |
| 10 | How did you **meet** your closest Aggie friend? | Multiple choice | Fish Camp, Class, Dorm, Student org, Faith group, Roommate, Haven't yet |
| 11 | Have you ever thought about **leaving** A&M? | Multiple choice | Yes, No, Prefer not to say |
| 12 | What has been the **hardest** part of A&M? | Multiple choice | Grades, Money, Loneliness, Family, Health, Homesickness, None |
| 13 | When it got hard, what **kept** you here? | Multiple choice | Friends, Family, Faith, A professor, Traditions, No choice, Myself, N/A |

Google Forms adds **Timestamp** automatically.

## Connect live data to the app
Google Sheet → File → Share → **Publish to web** → pick the responses sheet → **CSV** → copy link →
paste it in the app's "Load data" box. The app refreshes every 30 s, so new responses show up live during the demo.

## Collection rules (put these on Devpost)
1. Survey at every location, across morning / afternoon / evening.
2. Ask passers-by, not only friends.
3. Anonymous. No names or emails. Every question allows skipping.
4. Target 50+ responses, at least 5 per location.
5. Hand out a card with the QR code **and** Texas A&M Counseling & Psychological Services (CAPS) info.
