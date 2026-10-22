# Running Chipo

## Turso

When `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are set in `.env`, the app uses Turso/libSQL. Keep the token private and do not commit `.env`.

1. Create a database in Turso and copy its database URL and auth token into `.env`:

   ```dotenv
   TURSO_DATABASE_URL=libsql://your-database-name-your-org.turso.io
   TURSO_AUTH_TOKEN=your-database-auth-token
   JWT_SECRET=your-long-random-secret
   GEMINI_API_KEY=your-gemini-api-key
   ```

2. Install dependencies and apply the schema:

   ```powershell
   npm install
   node migrate.js
   ```

   This applies `schema.turso.sql` to the configured Turso database. It creates/updates the schema only; it does not copy existing FAQs, staff, or tickets from XAMPP.
3. Start the app and open `http://localhost:3000`:

   ```powershell
   npm start
   ```

4. Create the first administrator account:

   ```powershell
   node create-staff.js admin "choose-a-password-at-least-8-characters"
   ```

For a Turso deployment, set the same Turso variables, `JWT_SECRET`, and `GEMINI_API_KEY` in the hosting service's environment settings. Run `node migrate.js` once against that database before starting the app.

## Local MySQL with XAMPP

If Turso variables are not set, the app continues to use XAMPP's MariaDB configuration. Start MariaDB from the XAMPP Control Panel, then create the app database and let the app create its tables.

## First-time setup

1. Open the XAMPP Control Panel and click **Start** beside **MySQL**. Apache is only needed if you want to use phpMyAdmin through `http://localhost/phpmyadmin`.
2. In phpMyAdmin, select **New**, enter `chipo` as the database name, choose `utf8mb4_unicode_ci` if offered, and click **Create**. Do not create tables by hand.
3. In a terminal, change to this project folder and run:

   ```powershell
   npm install
   node migrate.js
   ```

   This creates the app's tables in `chipo`. With a default XAMPP install, the app connects as `root` with no password on port `3306`.
4. Start the app:

   ```powershell
   node server.js
   ```

5. Open `http://localhost:3000` for chat or `http://localhost:3000/admin.html` for the staff dashboard.

To use a MariaDB password or a non-default connection, set these in `.env`: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, and `MYSQL_DATABASE`.

Create the first administrator account from another terminal in the same folder:

```powershell
node create-staff.js admin "choose-a-password-at-least-8-characters"
```

`JWT_SECRET` must also be configured in `.env` to log in to the admin dashboard.

## Student portal

The student portal lives at `http://localhost:3000/portal`. Students sign in with their student number and password, and Chipo stays available to them on the portal page as well as on the public site.

New students can create their own account with **Create an account** on the sign-in screen (`POST /student/register`). Self-registration is on by default for the demo — set `ALLOW_STUDENT_SIGNUP=false` in `.env` to close it, which makes the route return 403. Accounts can also be provisioned from the project terminal:

```powershell
node create-student.js BIT23220920 "choose-a-password-at-least-8-characters" "John Sichula" "BSc Computer Science" "School of Technology and Social Sciences" "Year 2"
```

The portal's announcements and timetable links are seeded automatically the first time the app starts against an empty database.

### Chipo and portal access

Chipo can read a student's portal records only **inside the student portal, while that student is signed in**. The split is enforced on the server by the chat endpoint, not by the page:

- `POST /portal/ask` - the student portal. Requires a valid student session; Chipo reads that student's records (profile, account status, fees and payments, course registration, results, exemptions, appeals, class passes, graduation clearance, deferment and the published notices) and answers account questions in full.
- `POST /ask` - the public website. No session is honoured here at all, so a token left in the browser by an earlier portal visit gives no access. General university questions, published notices and the general rules of each service are answered as normal, and a question about somebody's own account ("what's my balance", "show me my results") is refused with a pointer to the portal.

The chat widget shows the current state as a badge in its header ("Portal access: signed in" / "Portal access: locked"). The portal page declares itself with `window.chipo.setScope('portal')`, which is what makes the widget call the portal endpoint; everywhere else the scope is `site` and the session is never sent. The access rules live in `portalAccess.js`, the records are read through `studentPortal.getContextPayload()`, and the session is resolved in `server.js`.

### Chipo understands typos

Students type fast, often on a phone, and a misspelt question has to be answered rather than turned away. The rules in `portalAccess.js` match a word within a letter or two of the real one, so "admisn reqirements" is still a question about admissions, "defrment" is still a deferment, and "whats my fe balnce" is still a question about the student's own balance.

The matching is deliberately narrow, so it does not turn into a guessing machine:

| What is compared | How close is close enough |
| --- | --- |
| Plain words (`fee`, `course`) | Exact |
| Plurals and word forms (`admission` / `admissions`) | Exact |
| Words of 5-8 letters | One letter out |
| Words of 9 letters or more | Two letters out |
| Long words with a missing vowel (`admisn`) | The vowels are taken out and the consonants compared, but only for words of 8 letters or more, and only when the word starts the same way |

A question is only in scope because of a typo if the misspelt word is close to a university word, so "whats the captial of frence" is still out of bounds while "admisn reqirements" is not. The same matching is used for the personal-record rules, for the ticket department routing, and for spotting a ticket request ("i need a suport ticket about my fees").

Two things keep a typo from causing a needless ticket:

- The prompt tells the model to read past a spelling mistake and never comment on it.
- When a question only matched after allowing for a typo, the document-relevance score is not used to decide whether to hand over to a department - the answer itself decides that. A question Chipo really cannot answer is still handed over, and it is still routed to the right department.

### Chipo's boundary, and handing over to a department

**Outside the university.** Chipo is a University of Lusaka assistant, so a question that has nothing to do with the university is turned aside, before the model is called:

> That one is outside my boundary, I'm afraid - I am the University of Lusaka student assistant, so I only really know about UNILUS. That covers admissions, fees, courses, results, examinations, the student portal and the services we run. Ask me about any of those and I will do my very best.

The check is in `portalAccess.isInScope()`: a wide list of university words, plus a short list of clear giveaways from another world (bitcoin, weather, poetry, world cup) so that "what is my bitcoin balance" is not mistaken for a question about a fee balance. A file the user attached is always in scope - they handed it over on purpose.

**Just conversation.** Greetings and simple questions are never out of bounds. "Hey", "how are you", "thanks", "bye", "what can you do?", "what do you know about the school?" are answered the way a friendly person would answer them - a short, warm reply and an invitation to ask the real question. `portalAccess.isConversational()` recognises them, and a chat message is never treated as a question worth handing over to a department, so saying hello never opens a ticket.

**Inside the university.** Chipo answers as best it can, and it answers for the person it is talking to: a signed-in student gets their own records and figures, anyone else gets general guidance about how the university works. When the material genuinely does not cover the question, Chipo says so plainly and hands over:

- **Inside the portal** the student's name, email address and phone number are already on the portal record, so Chipo opens the ticket itself, routes it to the right department and gives the student the reference. Nothing is asked of the student a second time.
- **Anywhere else** the student is asked for a name and one way to be contacted, and the ticket is created when they submit that.

Either way the best answer Chipo had is kept and shown above the hand-over note, so the student is never left with nothing.

Provisioning a student with an email address and a phone number is what makes the portal hand-over automatic:

```
node create-student.js BIT23220920 student1234 "John Sichula" "BSc Computer Science" "School of Technology and Social Sciences" "Year 2" john.sichula@student.unilus.edu.zm "+260 977 000 000"
```

After updating an existing installation, run `node migrate.js` again to add the ticket contact fields before starting the app.

### Which department gets the ticket

A hand-over is decided by what Chipo could answer, not by the document score alone:

- If the answer is missing the point - the model says it does not have the information, or it only points the student at an office - the question is handed over.
- If the answer gives the details first and only suggests an office afterwards, it is not a hand-over. Chipo answered, so the student keeps the answer.
- A question the student asks for a person to handle ("I need to speak to someone about my hostel application") never reaches the model at all. It goes straight to a ticket.

`ticketRouting.js` then decides where the ticket lands:

| The question | The department |
| --- | --- |
| Fees, payments, balances, refunds | Accounts |
| Wi-Fi, logins, computers, software | IT Department |
| Borrowing a book, replacing an ID card | Library |
| Applying, admission letters, enrolling | Admissions |
| Programmes, timetables, exams, deferments | Academic Office |
| Transcripts, results, certificates, graduation | Registry |
| Hostels, accommodation, discipline, wellbeing | Student Affairs |
| Masters, PhD, research, thesis | Postgraduate Office |

A question about the university itself - how many campuses, how many programmes, which faculties - goes to Admissions, because those are the questions the Admissions Office answers. A word is only counted once when it decides the department, so "application" in Admissions does not outvote "hostel application" in Student Affairs.

The keyword lists live in `DEFAULT_ROUTING_TERMS` in `ticketRouting.js` and in the `routing_keywords` column of the `departments` table, so they can be changed without touching the code.

### Open admin sign-up (known risk)

`POST /admin/signup` is still open: anyone who can reach the server can create a staff account. It was left as it is on purpose, so it is written down here instead.

- Before the app is put on a public address, put it behind a reverse proxy that blocks `/admin/signup`, or set an admin password on the server itself.
- The route is in `server.js`; removing it costs nothing, and every staff account can also be created from the terminal with `node create-staff.js`.

### Chipo and file attachments

The chat widget has a paperclip button, so a user can hand Chipo a document and ask questions about it. The file is uploaded once to `POST /attachments`, read on the server, and kept in memory for 30 minutes; the next question carries the returned id, so the content never travels back and forth inside the chat request.

| File | What happens |
| --- | --- |
| `.pdf` | Text is extracted with `pdf-parse` |
| `.docx` | The Word document is read with a small zip reader in `fileReader.js` |
| `.pptx` | One line per slide |
| `.xlsx` | One block per sheet, rows separated by ` | ` |
| `.txt` `.md` `.csv` `.tsv` `.json` `.xml` `.html` `.log` `.rtf` | Read as plain text |
| `.png` `.jpg` `.jpeg` `.webp` `.gif` `.bmp` | Handed to the model as pixels, so Chipo can look at the image |

Files are capped at 8 MB and the extracted text at 120,000 characters. Anything else is refused with a message that says what is supported.

The file content is put in front of the model as the primary source for the question, with an instruction to answer from it and never invent contents that are not there. Two details worth knowing:

- An attached file is the user's own document, so a question that looks like an account question ("what is my balance?") is answered from the file instead of being refused. It still never opens the portal records — the public website passes no student session.
- On the public website, student numbers are withheld from the answer unless they appear in the file the user attached themselves.

Nothing is written to disk and nothing survives a restart, which is what you want for student documents. `fileReader.js` does the reading, `attachments.js` is the short-lived shelf, and `server.js` owns the route.

When Chipo cannot answer confidently, it asks the student for a name and an email address and/or phone number before creating and routing the ticket. Ticket routing uses the current question first, then recent student questions in the same conversation, configured department routing keywords, and the FAQ department when the query itself does not identify a team. Unmatched tickets go to Student Affairs when that department is available; they are not arbitrarily assigned to the first department. Tickets remain stored with their department assignment and are visible to its staff account; creating a staff login does not create or move tickets. Create department logins from the administrator's **Staff accounts** tab or the project terminal. The department name must match a department in the dashboard:

```powershell
node create-staff.js it.staff "choose-a-password-at-least-8-characters" IT
node create-staff.js finance.staff "choose-another-password" Finance
```

Department staff see and update tickets assigned to their department only. The administrator login (created without a department argument) can manage departments and view all tickets.

## Troubleshooting

- If `node migrate.js` reports `ECONNREFUSED`, confirm **MySQL** is running in the XAMPP Control Panel and that `MYSQL_PORT` matches its configured port.
- If it reports `Unknown database 'chipo'`, create the `chipo` database in phpMyAdmin first.
- If it reports `Access denied`, set the correct `MYSQL_USER` and `MYSQL_PASSWORD` in `.env`.
- The project can also run with Docker Compose, which now uses MariaDB. XAMPP is not used by the Compose setup.
