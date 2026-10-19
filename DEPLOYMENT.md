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

After updating an existing installation, run `node migrate.js` again to add the ticket contact fields before starting the app.

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
