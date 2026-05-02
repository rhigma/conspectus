import mysql from 'mysql2/promise';

let pool;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host:     process.env.DB_HOST,
      port:     parseInt(process.env.DB_PORT) || 3306,
      database: process.env.DB_NAME,
      user:     process.env.DB_USER,
      password: process.env.DB_PASS,
      waitForConnections: true,
      connectionLimit: 10,
      charset: 'utf8mb4',
    });
  }
  return pool;
}

export async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

export async function initSchema() {
  const db = getPool();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS email_accounts (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      label       VARCHAR(100) NOT NULL,
      email       VARCHAR(255) NOT NULL UNIQUE,
      host        VARCHAR(255) NOT NULL,
      port        INT NOT NULL DEFAULT 993,
      username    VARCHAR(255) NOT NULL,
      password    VARCHAR(500) NOT NULL,
      tls         TINYINT NOT NULL DEFAULT 1,
      color       VARCHAR(20) NOT NULL DEFAULT '#d4a853',
      active      TINYINT NOT NULL DEFAULT 1,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS delegations_personen (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      rolle       VARCHAR(100) NOT NULL,
      email       VARCHAR(255),
      aktiv       TINYINT NOT NULL DEFAULT 1,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS vorgaenge (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      titel             VARCHAR(500) NOT NULL,
      typ               ENUM('personal','behoerde','veranstaltung','planung','sonstiges')
                        NOT NULL DEFAULT 'sonstiges',
      status            ENUM('offen','in_bearbeitung','wartet','abgeschlossen')
                        NOT NULL DEFAULT 'offen',
      prioritaet        TINYINT NOT NULL DEFAULT 2,
      deadline          DATE,
      beschreibung      TEXT,
      ki_zusammenfassung TEXT,
      nc_ordner         VARCHAR(500),
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FULLTEXT idx_ft (titel, beschreibung)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS emails (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      account_id      INT NOT NULL,
      vorgang_id      INT,
      uid             VARCHAR(255) NOT NULL,
      message_id      VARCHAR(500),
      from_name       VARCHAR(500),
      from_email      VARCHAR(500),
      subject         VARCHAR(1000),
      body_text       MEDIUMTEXT,
      date            DATETIME,
      unread          TINYINT NOT NULL DEFAULT 1,
      flagged         TINYINT NOT NULL DEFAULT 0,
      erledigt        TINYINT NOT NULL DEFAULT 0,
      anhang_pfade    JSON,
      ki_einordnung   TEXT,
      synced_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_account_uid (account_id, uid),
      FULLTEXT idx_ft (subject, body_text),
      FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (vorgang_id) REFERENCES vorgaenge(id) ON DELETE SET NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  // Migration für bestehende Instanzen
  await db.execute(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS erledigt TINYINT NOT NULL DEFAULT 0`);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS vorgang_eintraege (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      vorgang_id  INT NOT NULL,
      typ         ENUM('email','notiz','datei','termin','delegation','ki_analyse')
                  NOT NULL DEFAULT 'notiz',
      titel       VARCHAR(500),
      inhalt      MEDIUMTEXT,
      datei_pfad  VARCHAR(1000),
      ref_id      INT,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FULLTEXT idx_ft (titel, inhalt),
      FOREIGN KEY (vorgang_id) REFERENCES vorgaenge(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS delegationen (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      vorgang_id  INT NOT NULL,
      person_id   INT,
      an_name     VARCHAR(255) NOT NULL,
      an_rolle    VARCHAR(100) NOT NULL DEFAULT 'sonstiges',
      aufgabe     TEXT NOT NULL,
      deadline    DATE,
      status      ENUM('offen','erledigt','ueberfaellig') NOT NULL DEFAULT 'offen',
      notiz       TEXT,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (vorgang_id) REFERENCES vorgaenge(id) ON DELETE CASCADE,
      FOREIGN KEY (person_id) REFERENCES delegations_personen(id) ON DELETE SET NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      vorgang_id  INT,
      calendar_id INT,
      uid         VARCHAR(500) NOT NULL,
      title       VARCHAR(1000),
      start_time  DATETIME,
      end_time    DATETIME,
      location    VARCHAR(500),
      description TEXT,
      all_day     TINYINT NOT NULL DEFAULT 0,
      synced_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_cal_uid (calendar_id, uid),
      FOREIGN KEY (vorgang_id) REFERENCES vorgaenge(id) ON DELETE SET NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS calendars (
      id        INT AUTO_INCREMENT PRIMARY KEY,
      label     VARCHAR(255) NOT NULL,
      url       VARCHAR(1000) NOT NULL,
      username  VARCHAR(255) NOT NULL,
      password  VARCHAR(500) NOT NULL,
      color     VARCHAR(20) NOT NULL DEFAULT '#8fb87a',
      active    TINYINT NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      role        ENUM('user','assistant') NOT NULL,
      content     MEDIUMTEXT NOT NULL,
      model       VARCHAR(100),
      tokens_in   INT,
      tokens_out  INT,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS sync_log (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      type        VARCHAR(50) NOT NULL,
      status      ENUM('ok','error') NOT NULL,
      message     TEXT,
      duration_ms INT,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(100) PRIMARY KEY,
      value TEXT
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS todos (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      vorgang_id  INT NOT NULL,
      titel       VARCHAR(500) NOT NULL,
      beschreibung TEXT,
      faellig_am  DATETIME,
      wichtig     TINYINT NOT NULL DEFAULT 1,
      dringend    TINYINT NOT NULL DEFAULT 0,
      erledigt    TINYINT NOT NULL DEFAULT 0,
      erledigt_am DATETIME,
      event_uid   VARCHAR(255),
      calendar_id INT,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vorgang_id) REFERENCES vorgaenge(id) ON DELETE CASCADE,
      FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE SET NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  // Stammdaten eintragen wenn noch nicht vorhanden
  const personen = await query('SELECT COUNT(*) as n FROM delegations_personen');
  if (personen[0].n === 0) {
    await db.execute(`
      -- Personen werden über Einstellungen → Delegations-Personen konfiguriert
      -- Beispiel: INSERT INTO delegations_personen (name, rolle) VALUES ('Name', 'sekretariat')
    `);
  }

  console.log('[DB] Schema bereit');
}
