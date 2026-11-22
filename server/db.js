import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });

/** Random id for share links: /p/<token>, /s/<token>. */
export const newToken = () => crypto.randomBytes(12).toString('base64url');

export const db = new DatabaseSync(path.join(dataDir, 'discotracker.sqlite'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS login_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    used       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email, created_at);

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS songs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    format     TEXT NOT NULL,
    data       BLOB NOT NULL,
    size       INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_songs_user ON songs(user_id, updated_at);

  CREATE TABLE IF NOT EXISTS playlists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       TEXT NOT NULL UNIQUE,           -- used in the share link /p/<token>
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    visibility  TEXT NOT NULL DEFAULT 'private', -- 'private' (owner + invited emails) | 'link' (anyone with the link) | 'public' (listed: profile page and search)
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id, updated_at);

  CREATE TABLE IF NOT EXISTS playlist_items (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    song_id     INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, song_id)
  );

  CREATE TABLE IF NOT EXISTS playlist_shares (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    notified_at INTEGER,
    PRIMARY KEY (playlist_id, email)
  );
  CREATE INDEX IF NOT EXISTS idx_playlist_shares_email ON playlist_shares(email);
`);

// ---------------------------------------------------------------------------
// Migrations, run once each (PRAGMA user_version counts them).

const MIGRATIONS = [
  // 1: handles and profiles, public (listed) songs and playlists.
  () => {
    const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    const add = (t, col, def) => { if (!cols(t).has(col)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${def}`); };
    add('users', 'handle', 'TEXT');
    add('users', 'display_name', "TEXT NOT NULL DEFAULT ''");
    add('users', 'bio', "TEXT NOT NULL DEFAULT ''");
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle) WHERE handle IS NOT NULL');

    add('songs', 'token', 'TEXT');
    add('songs', 'description', "TEXT NOT NULL DEFAULT ''");
    add('songs', 'visibility', "TEXT NOT NULL DEFAULT 'private'"); // 'private' | 'link' | 'public'
    add('songs', 'plays', 'INTEGER NOT NULL DEFAULT 0');
    add('songs', 'published_at', 'INTEGER');
    const setToken = db.prepare('UPDATE songs SET token = ? WHERE id = ?');
    for (const { id } of db.prepare('SELECT id FROM songs WHERE token IS NULL').all()) setToken.run(newToken(), id);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_token ON songs(token)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_songs_public ON songs(visibility, published_at)');

    add('playlists', 'plays', 'INTEGER NOT NULL DEFAULT 0');
    add('playlists', 'published_at', 'INTEGER');
    // "public" used to mean "anyone with the link". That is now "link"; "public" means listed.
    db.exec("UPDATE playlists SET visibility = 'link' WHERE visibility = 'public'");
    db.exec('CREATE INDEX IF NOT EXISTS idx_playlists_public ON playlists(visibility, published_at)');
  },
];

{
  const v = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[i]();
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function cleanup() {
  const now = Date.now();
  db.prepare('DELETE FROM login_codes WHERE expires_at < ?').run(now - 24 * 3600e3);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}
