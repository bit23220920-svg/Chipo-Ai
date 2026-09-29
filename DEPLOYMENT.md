# Running Chipo with XAMPP

This project uses XAMPP's MariaDB database. Start MariaDB from the XAMPP Control Panel, then create the app database and let the app create its tables.

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

To use a MariaDB password or a non-default connection, set these in `.env`: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, and `MYSQL_DATABASE`. Do not share or commit `.env`.

Create the first administrator account from another terminal in the same folder:

```powershell
node create-staff.js admin "choose-a-password-at-least-8-characters"
```

`JWT_SECRET` must also be configured in `.env` to log in to the admin dashboard.

Use the administrator's **Departments** tab to create departments. Then create one login per department from the project terminal. The department name must match what was created in the dashboard:

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
