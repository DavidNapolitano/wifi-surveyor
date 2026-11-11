#!/usr/bin/env python3
"""Wi-Fi surveyor server: tails the scanner feed, keeps a live buffer, records to SQLite, serves the web UI.

Normally launched by WiFiSurveyor.app. Run directly (python3 server/surveyor.py) to review recorded data.
"""
import argparse
import csv
import io
import json
import os
import re
import signal
import sqlite3
import threading
import time
import traceback
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
WEB = Path(__file__).resolve().parent / "web"
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/live.js": ("live.js", "text/javascript; charset=utf-8"),
    "/channels.js": ("channels.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
}
MAX_SINCE = 20 * 365 * 86400
# SSIDs are attacker-controlled text: no inline scripts, no framing (clickjacking).
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
       " object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
LIVE_KEEP = 3600

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, created REAL);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS scans(
    id INTEGER PRIMARY KEY, ts REAL NOT NULL, iface TEXT,
    conn_ssid TEXT, conn_bssid TEXT, conn_rssi INTEGER, conn_noise INTEGER,
    conn_channel INTEGER, conn_band TEXT, tx_rate REAL, error TEXT, recording_id INTEGER, conn_phy TEXT,
    session_id INTEGER);
CREATE INDEX IF NOT EXISTS scans_ts ON scans(ts);
CREATE TABLE IF NOT EXISTS readings(
    scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE, ts REAL NOT NULL,
    ssid TEXT, bssid TEXT, rssi INTEGER, noise INTEGER, channel INTEGER, band TEXT, width INTEGER, phy TEXT,
    session_id INTEGER);
CREATE INDEX IF NOT EXISTS readings_ts ON readings(ts);
CREATE INDEX IF NOT EXISTS readings_scan ON readings(scan_id);
CREATE TABLE IF NOT EXISTS rooms(
    id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, name TEXT NOT NULL, created REAL, UNIQUE(session_id, name));
CREATE TABLE IF NOT EXISTS floorplans(
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, filename TEXT, mime TEXT NOT NULL, created REAL, session_id INTEGER);
CREATE TABLE IF NOT EXISTS captures(
    id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    start_ts REAL NOT NULL, end_ts REAL,
    floorplan_id INTEGER REFERENCES floorplans(id) ON DELETE SET NULL, x REAL, y REAL);
CREATE TABLE IF NOT EXISTS recordings(
    id INTEGER PRIMARY KEY, name TEXT, start_ts REAL NOT NULL, end_ts REAL, session_id INTEGER);
CREATE TABLE IF NOT EXISTS filters(
    id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
    action TEXT NOT NULL, UNIQUE(session_id, kind, value));
CREATE TABLE IF NOT EXISTS channel_changes(
    id INTEGER PRIMARY KEY, ts REAL NOT NULL, bssid TEXT, ssid TEXT, old_channel INTEGER, new_channel INTEGER,
    old_band TEXT, new_band TEXT, old_width INTEGER, new_width INTEGER);
CREATE TABLE IF NOT EXISTS ap_names(bssid TEXT PRIMARY KEY, name TEXT NOT NULL);
"""
# Columns added after the first release; ALTERed into older databases.
MIGRATIONS = [("scans", "recording_id", "INTEGER"), ("scans", "conn_phy", "TEXT"), ("readings", "phy", "TEXT"),
              ("scans", "session_id", "INTEGER"), ("readings", "session_id", "INTEGER"),
              ("recordings", "session_id", "INTEGER"), ("floorplans", "session_id", "INTEGER")]
# Display name: hidden networks have a BSSID but no name; without Location permission both are missing.
SSID_LABEL = ("CASE WHEN ssid IS NOT NULL AND ssid != '' THEN ssid"
              " WHEN bssid IS NOT NULL THEN '(hidden)' ELSE '(unknown)' END")
# Hidden APs are usually unrelated devices, so they are never combined into one "network".
NOT_HIDDEN = " AND NOT (COALESCE(ssid, '') = '' AND bssid IS NOT NULL)"


def norm_bssid(b):
    if not b:
        return None
    parts = b.lower().split(":")
    return ":".join(p.zfill(2) for p in parts) if len(parts) == 6 else b.lower()


def bssid_suffix(b):
    """Last five bytes: virtual APs on one router usually differ only in the first byte."""
    return b[3:] if b and len(b) == 17 else None


def ssid_label(ssid, bssid):
    return ssid if ssid else ("(hidden)" if bssid else "(unknown)")

# Scan ids that fall inside capture windows matching a WHERE clause on captures `c` (same session as the room).
CAPTURE_SCANS = (
    "SELECT s.id FROM scans s JOIN captures c "
    "ON s.ts >= c.start_ts AND s.ts <= COALESCE(c.end_ts, 1e18) "
    "JOIN rooms rr ON rr.id = c.room_id AND rr.session_id = s.session_id WHERE {}"
)


class Conflict(Exception):
    pass


class Store:
    def __init__(self, path):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        self.closed = False
        with self.lock:
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.executescript(SCHEMA)
            for table, col, decl in MIGRATIONS:
                if col not in self._cols(table):
                    self.db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
            self.db.commit()
            self._migrate_sessions()
            self.db.execute("PRAGMA foreign_keys=ON")
            self.db.execute("CREATE INDEX IF NOT EXISTS scans_rec ON scans(recording_id)")
            self.db.execute("CREATE INDEX IF NOT EXISTS scans_sess ON scans(session_id, ts)")
            self.db.execute("CREATE INDEX IF NOT EXISTS readings_sess ON readings(session_id, ts)")
            self.db.commit()
        self.close_dangling()
        self.recording_id = None
        self.session_id = self._initial_session()
        self.load_filters()
        self.load_ap_names()
        # BSSID suffix -> visible SSID, to name hidden virtual APs after their router's network.
        self.names = {}
        for r in self.q("SELECT bssid, MAX(ssid) ssid FROM readings WHERE ts >= ? AND ssid IS NOT NULL"
                        " AND ssid != '' AND bssid IS NOT NULL GROUP BY bssid", (time.time() - 30 * 86400,)):
            self.learn_name(r["ssid"], r["bssid"])

    def learn_name(self, ssid, bssid):
        s = bssid_suffix(bssid)
        if ssid and s:
            self.names[s] = ssid

    def _cols(self, table):
        return {r[1] for r in self.db.execute(f"PRAGMA table_info({table})")}

    def _migrate_sessions(self):
        """Pre-session databases: put everything into 'Session 1' and make room/rule names per-session."""
        if "session_id" in self._cols("rooms"):
            return
        # Foreign keys must be off, or dropping the old rooms table would cascade-delete every capture.
        self.db.execute("PRAGMA foreign_keys=OFF")
        sid = self.db.execute("INSERT INTO sessions(name, created) VALUES ('Session 1', ?)", (time.time(),)).lastrowid
        for t in ("scans", "readings", "recordings", "floorplans"):
            self.db.execute(f"UPDATE {t} SET session_id = ? WHERE session_id IS NULL", (sid,))
        lo, hi = self.db.execute("SELECT MIN(ts), MAX(ts) FROM scans WHERE recording_id IS NULL").fetchone()
        if lo is not None:
            rid = self.db.execute("INSERT INTO recordings(name, start_ts, end_ts, session_id) VALUES ('Imported', ?, ?, ?)",
                                  (lo, hi, sid)).lastrowid
            self.db.execute("UPDATE scans SET recording_id = ? WHERE recording_id IS NULL", (rid,))
        self.db.execute("CREATE TABLE rooms_v3(id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, name TEXT NOT NULL,"
                        " created REAL, UNIQUE(session_id, name))")
        self.db.execute("INSERT INTO rooms_v3(id, session_id, name, created) SELECT id, ?, name, created FROM rooms", (sid,))
        self.db.execute("DROP TABLE rooms")
        self.db.execute("ALTER TABLE rooms_v3 RENAME TO rooms")
        self.db.execute("CREATE TABLE filters_v3(id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, kind TEXT NOT NULL,"
                        " value TEXT NOT NULL, action TEXT NOT NULL, UNIQUE(session_id, kind, value))")
        self.db.execute("INSERT INTO filters_v3(id, session_id, kind, value, action)"
                        " SELECT id, ?, kind, value, action FROM filters", (sid,))
        self.db.execute("DROP TABLE filters")
        self.db.execute("ALTER TABLE filters_v3 RENAME TO filters")
        self.db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('session', ?)", (str(sid),))
        self.db.commit()

    def _initial_session(self):
        r = self.q("SELECT s.id FROM sessions s JOIN meta m ON m.key = 'session' AND CAST(m.value AS INTEGER) = s.id")
        if r:
            return r[0]["id"]
        r = self.q("SELECT id FROM sessions ORDER BY created DESC LIMIT 1")
        sid = r[0]["id"] if r else self.x("INSERT INTO sessions(name, created) VALUES ('Session 1', ?)",
                                          (time.time(),)).lastrowid
        self.x("INSERT OR REPLACE INTO meta(key, value) VALUES ('session', ?)", (str(sid),))
        return sid

    # ----- sessions -----
    def sessions(self):
        rows = self.q(
            """SELECT s.id, s.name, s.created,
                      (SELECT COUNT(*) FROM recordings r WHERE r.session_id = s.id) recordings,
                      (SELECT COUNT(*) FROM scans x WHERE x.session_id = s.id) scans,
                      (SELECT COUNT(*) FROM rooms m WHERE m.session_id = s.id) rooms,
                      (SELECT MIN(start_ts) FROM recordings r WHERE r.session_id = s.id) first_ts,
                      (SELECT MAX(COALESCE(end_ts, start_ts)) FROM recordings r WHERE r.session_id = s.id) last_ts
               FROM sessions s ORDER BY s.created DESC""")
        for r in rows:
            r["current"] = r["id"] == self.session_id
        return rows

    def current_session(self):
        r = self.q("SELECT id, name FROM sessions WHERE id = ?", (self.session_id,))
        return r[0] if r else None

    def set_session(self, sid):
        with self.lock:
            if self.recording_id:
                raise Conflict("stop recording before switching sessions")
            if not self.db.execute("SELECT 1 FROM sessions WHERE id = ?", (sid,)).fetchone():
                raise ValueError("unknown session")
            self.db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('session', ?)", (str(sid),))
            self.db.commit()
            self.session_id = sid
        self.load_filters()

    def create_session(self, name):
        if self.recording_id:
            raise Conflict("stop recording before starting a new session")
        try:
            sid = self.x("INSERT INTO sessions(name, created) VALUES (?, ?)", (name, time.time())).lastrowid
        except sqlite3.IntegrityError:
            raise Conflict(f"a session named '{name}' already exists")
        self.set_session(sid)
        return sid

    def rename_session(self, sid, name):
        try:
            self.x("UPDATE sessions SET name = ? WHERE id = ?", (name, sid))
        except sqlite3.IntegrityError:
            raise Conflict(f"a session named '{name}' already exists")

    def delete_session(self, sid):
        """Delete a session and everything in it."""
        with self.lock:
            if sid == self.session_id:
                raise Conflict("switch to another session before deleting this one")
            self.db.execute("DELETE FROM readings WHERE session_id = ?", (sid,))
            self.db.execute("DELETE FROM scans WHERE session_id = ?", (sid,))
            self.db.execute("DELETE FROM recordings WHERE session_id = ?", (sid,))
            self.db.execute("DELETE FROM rooms WHERE session_id = ?", (sid,))
            self.db.execute("DELETE FROM floorplans WHERE session_id = ?", (sid,))
            self.db.execute("DELETE FROM filters WHERE session_id = ?", (sid,))
            self.db.execute("DELETE FROM sessions WHERE id = ?", (sid,))
            self.db.commit()

    def alias(self, bssid):
        return self.names.get(bssid_suffix(bssid))

    def q(self, sql, params=()):
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, params)]

    def x(self, sql, params=()):
        with self.lock:
            cur = self.db.execute(sql, params)
            self.db.commit()
            return cur

    def close_dangling(self):
        """End recordings/segments left open by a crash."""
        t = time.time()
        self.x("UPDATE recordings SET end_ts = COALESCE((SELECT MAX(ts) FROM scans WHERE recording_id = recordings.id),"
               " start_ts) WHERE end_ts IS NULL")
        self.x("UPDATE captures SET end_ts = MIN(COALESCE(end_ts, 1e18), COALESCE((SELECT MAX(ts) FROM scans"
               " WHERE ts >= captures.start_ts), captures.start_ts)) WHERE end_ts IS NULL OR end_ts > ?", (t,))

    def shutdown(self):
        self.stop_recording()
        with self.lock:
            self.closed = True
            self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self.db.close()

    # ----- access point nicknames (global: a BSSID belongs to a physical device) -----
    def load_ap_names(self):
        self.ap_names = {r["bssid"]: r["name"] for r in self.q("SELECT bssid, name FROM ap_names")}

    def set_ap_name(self, bssids, name):
        with self.lock:
            if name:
                self.db.executemany("INSERT INTO ap_names(bssid, name) VALUES (?, ?)"
                                    " ON CONFLICT(bssid) DO UPDATE SET name = excluded.name", [(b, name) for b in bssids])
            else:
                self.db.executemany("DELETE FROM ap_names WHERE bssid = ?", [(b,) for b in bssids])
            self.db.commit()
        self.load_ap_names()

    # ----- include/exclude filters -----
    def load_filters(self):
        self.filters = self.q("SELECT id, kind, value, action FROM filters WHERE session_id = ? ORDER BY id",
                              (self.session_id,))

    def passes(self, ssid, bssid):
        s, b = ssid or "", (bssid or "").lower()

        def hit(r):
            return r["value"] == (s if r["kind"] == "ssid" else b)
        inc = [r for r in self.filters if r["action"] == "include"]
        if inc and not any(hit(r) for r in inc):
            return False
        return not any(hit(r) for r in self.filters if r["action"] == "exclude")

    def fsql(self):
        """SQL fragment (' AND ...', params) scoping readings to the current session and its filters."""
        def vals(kind, action):
            return [r["value"] for r in self.filters if r["kind"] == kind and r["action"] == action]
        exprs = {"ssid": "COALESCE(ssid, '')", "bssid": "LOWER(COALESCE(bssid, ''))"}
        parts, params = ["session_id = ?"], [self.session_id]
        ors = []
        for kind, expr in exprs.items():
            v = vals(kind, "include")
            if v:
                ors.append(f"{expr} IN ({','.join('?' * len(v))})")
                params += v
        if ors:
            parts.append("(" + " OR ".join(ors) + ")")
        for kind, expr in exprs.items():
            v = vals(kind, "exclude")
            if v:
                parts.append(f"{expr} NOT IN ({','.join('?' * len(v))})")
                params += v
        return "".join(f" AND {p}" for p in parts), params

    def add_filter(self, kind, value, action):
        self.x("INSERT INTO filters(session_id, kind, value, action) VALUES (?, ?, ?, ?)"
               " ON CONFLICT(session_id, kind, value) DO UPDATE SET action = excluded.action",
               (self.session_id, kind, value, action))
        self.load_filters()

    def delete_filter(self, fid):
        self.x("DELETE FROM filters WHERE id = ? AND session_id = ?", (fid, self.session_id))
        self.load_filters()

    # ----- recording -----
    def _start_recording_locked(self, name):
        if not self.recording_id:
            cur = self.db.execute("INSERT INTO recordings(name, start_ts, session_id) VALUES (?, ?, ?)",
                                  (name, time.time(), self.session_id))
            self.recording_id = cur.lastrowid

    def start_recording(self, name=None):
        with self.lock:
            self._start_recording_locked(name)
            self.db.commit()
            return self.recording_id

    def stop_recording(self):
        with self.lock:
            if self.closed:
                return
            t = time.time()
            self.db.execute("UPDATE captures SET end_ts = ? WHERE end_ts IS NULL OR end_ts > ?", (t, t))
            self.db.execute("UPDATE recordings SET end_ts = ? WHERE end_ts IS NULL", (t,))
            self.db.commit()
            self.recording_id = None

    def active_recording(self):
        if not self.recording_id:
            return None
        r = self.q("SELECT id, name, start_ts, (SELECT COUNT(*) FROM scans WHERE recording_id = recordings.id) samples"
                   " FROM recordings WHERE id = ?", (self.recording_id,))
        return r[0] if r else None

    def recordings(self):
        return self.q(
            """SELECT r.id, r.name, r.start_ts, r.end_ts,
                      (SELECT COUNT(*) FROM scans s WHERE s.recording_id = r.id) samples,
                      (SELECT GROUP_CONCAT(DISTINCT rm.name) FROM captures c JOIN rooms rm ON rm.id = c.room_id
                       WHERE rm.session_id = r.session_id
                         AND c.start_ts >= r.start_ts AND c.start_ts <= COALESCE(r.end_ts, 1e18)) rooms
               FROM recordings r WHERE r.session_id = ? ORDER BY r.start_ts DESC""", (self.session_id,))

    def delete_recording(self, rid):
        with self.lock:
            if rid == self.recording_id:
                raise Conflict("stop the recording before deleting it")
            row = self.db.execute("SELECT start_ts, end_ts FROM recordings WHERE id = ? AND session_id = ?",
                                  (rid, self.session_id)).fetchone()
            if row:
                self.db.execute("DELETE FROM scans WHERE recording_id = ?", (rid,))
                self.db.execute("DELETE FROM captures WHERE start_ts >= ? AND start_ts <= ?"
                                " AND room_id IN (SELECT id FROM rooms WHERE session_id = ?)",
                                (row["start_ts"], row["end_ts"] or 1e18, self.session_id))
                self.db.execute("DELETE FROM recordings WHERE id = ?", (rid,))
                self.db.commit()

    def ingest(self, rec):
        """Persist a scan, but only while recording."""
        c = rec.get("connected") or {}
        ts = rec["ts"]
        with self.lock:
            if self.closed or not self.recording_id:
                return
            cur = self.db.execute(
                "INSERT INTO scans(ts, iface, conn_ssid, conn_bssid, conn_rssi, conn_noise, conn_channel,"
                " conn_band, tx_rate, error, recording_id, conn_phy, session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (ts, rec.get("iface"), c.get("ssid"), c.get("bssid"), c.get("rssi"), c.get("noise"),
                 c.get("channel"), c.get("band"), c.get("tx_rate"), rec.get("error"), self.recording_id,
                 c.get("phy"), self.session_id),
            )
            sid = cur.lastrowid
            self.db.executemany(
                "INSERT INTO readings(scan_id, ts, ssid, bssid, rssi, noise, channel, band, width, phy, session_id)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [(sid, ts, n.get("ssid"), n.get("bssid"), n.get("rssi"), n.get("noise"), n.get("channel"),
                  n.get("band"), n.get("width"), n.get("phy"), self.session_id) for n in rec.get("networks") or []],
            )
            self.db.commit()

    def add_channel_changes(self, changes):
        with self.lock:
            if self.closed:
                return
            self.db.executemany(
                "INSERT INTO channel_changes(ts, bssid, ssid, old_channel, new_channel, old_band, new_band,"
                " old_width, new_width) VALUES (?,?,?,?,?,?,?,?,?)",
                [(c["ts"], c["bssid"], c["ssid"], c["old_channel"], c["new_channel"], c["old_band"],
                  c["new_band"], c["old_width"], c["new_width"]) for c in changes])
            self.db.commit()

    def first_ts(self):
        return self.q("SELECT MIN(ts) t FROM scans WHERE session_id = ?", (self.session_id,))[0]["t"]

    def ssids(self):
        f, fp = self.fsql()
        return self.q(
            f"SELECT {SSID_LABEL} ssid, MAX(rssi) best FROM readings WHERE 1{f}{NOT_HIDDEN}"
            " GROUP BY 1 ORDER BY best DESC LIMIT 200", fp)

    def _series_sql(self, group, t0, t1):
        f, fp = self.fsql()
        if group == "ssid":
            sql = (f"SELECT MAX(ts) ts, {SSID_LABEL} k, MAX(rssi) v, NULL label"
                   f" FROM readings WHERE ts >= ? AND ts <= ?{f}{NOT_HIDDEN} GROUP BY scan_id, {SSID_LABEL}")
        else:
            sql = (f"SELECT ts, COALESCE(bssid, '(redacted)') k, rssi v, {SSID_LABEL} label"
                   f" FROM readings WHERE ts >= ? AND ts <= ?{f}")
        return sql, [t0, t1, *fp]

    def timeseries(self, t0, t1, group, keys):
        """Recorded signal per SSID/BSSID, bucketed to ~600 points. keys=None picks the strongest 8."""
        bucket = max(1.0, (t1 - t0) / 600)
        inner, ip = self._series_sql(group, t0, t1)
        available = self.q(f"SELECT k, MAX(label) label, AVG(v) avg, COUNT(*) n FROM ({inner})"
                           " GROUP BY k ORDER BY avg DESC LIMIT 150", ip)
        if keys is None:
            keys = [r["k"] for r in available[:8]]
        series = {}
        if keys:
            ph = ",".join("?" * len(keys))
            rows = self.q(
                f"SELECT CAST(ts / ? AS INTEGER) b, k, AVG(v) v, MAX(label) label FROM ({inner})"
                f" WHERE k IN ({ph}) GROUP BY b, k ORDER BY b",
                (bucket, *ip, *keys),
            )
            for r in rows:
                s = series.setdefault(r["k"], {"key": r["k"], "label": r["label"], "points": []})
                s["points"].append([(r["b"] + 0.5) * bucket, r["v"]])
        out = list(series.values())
        conn = self.q(
            "SELECT CAST(ts / ? AS INTEGER) b, AVG(conn_rssi) v FROM scans"
            " WHERE session_id = ? AND ts >= ? AND ts <= ? AND conn_rssi IS NOT NULL GROUP BY b ORDER BY b",
            (bucket, self.session_id, t0, t1),
        )
        if conn:
            out.append({"key": "(connected)", "label": "connected link",
                        "points": [[(r["b"] + 0.5) * bucket, r["v"]] for r in conn]})
        now = time.time()
        segments = self.q(
            """SELECT c.start_ts, MIN(COALESCE(c.end_ts, ?), ?) end_ts, r.id room_id, r.name room
               FROM captures c JOIN rooms r ON r.id = c.room_id
               WHERE r.session_id = ? AND c.start_ts <= ? AND COALESCE(c.end_ts, ?) >= ? ORDER BY c.start_ts""",
            (now, now, self.session_id, t1, now, t0))
        return {"t0": t0, "t1": t1, "bucket": bucket, "series": out, "keys": keys, "available": available,
                "segments": segments}

    def stats(self, where, params):
        """Signal stats over scans inside the capture windows selected by `where` (internal SQL only)."""
        sub = CAPTURE_SCANS.format(where)
        p = tuple(params)
        f, fp = self.fsql()
        pf = (*p, *fp)
        head = self.q(
            f"SELECT COUNT(*) samples, COUNT(conn_rssi) conn_n, AVG(conn_rssi) conn_avg,"
            f" MIN(conn_rssi) conn_min, MAX(conn_rssi) conn_max FROM scans WHERE id IN ({sub})", p)[0]
        top = self.q(
            f"SELECT conn_ssid FROM scans WHERE id IN ({sub}) AND conn_ssid IS NOT NULL"
            f" GROUP BY conn_ssid ORDER BY COUNT(*) DESC LIMIT 1", p)
        # Per scan, an SSID's signal is its strongest BSSID (what a roaming client would use).
        ssids = self.q(
            f"""SELECT ssid, AVG(m) avg, MIN(m) min, MAX(m) max, COUNT(*) n FROM (
                    SELECT {SSID_LABEL} ssid, MAX(rssi) m FROM readings
                    WHERE scan_id IN ({sub}){f}{NOT_HIDDEN} GROUP BY scan_id, {SSID_LABEL})
                GROUP BY ssid ORDER BY avg DESC""", pf)
        bssids = self.q(
            f"""SELECT COALESCE(bssid, '(redacted)') bssid, {SSID_LABEL} ssid, channel,
                       MAX(band) band, AVG(rssi) avg, MIN(rssi) min, MAX(rssi) max, COUNT(*) n
                FROM readings WHERE scan_id IN ({sub}){f}
                GROUP BY COALESCE(bssid, '(redacted)'), {SSID_LABEL}, channel
                ORDER BY avg DESC LIMIT 60""", pf)
        # Per scan, a named AP's signal is its strongest BSSID; unnamed BSSIDs stand alone.
        aps = self.q(
            f"""SELECT ap, MAX(named) named, MAX(ssid) ssid, AVG(m) avg, MIN(m) min, MAX(m) max, COUNT(*) n FROM (
                    SELECT COALESCE(an.name, COALESCE(r.bssid, '(redacted)')) ap, an.name IS NOT NULL named,
                           MAX(CASE WHEN r.ssid IS NOT NULL AND r.ssid != '' THEN r.ssid
                                    WHEN r.bssid IS NOT NULL THEN '(hidden)' ELSE '(unknown)' END) ssid,
                           MAX(r.rssi) m
                    FROM (SELECT * FROM readings WHERE scan_id IN ({sub}){f}) r
                    LEFT JOIN ap_names an ON an.bssid = r.bssid
                    GROUP BY r.scan_id, COALESCE(an.name, COALESCE(r.bssid, '(redacted)')))
                GROUP BY ap ORDER BY avg DESC LIMIT 40""", pf)
        # Which AP the Mac was actually associated with (roaming behaviour per room).
        conn = self.q(
            f"""SELECT conn_bssid bssid, MAX(conn_ssid) ssid, MAX(conn_channel) channel, MAX(conn_band) band,
                       COUNT(*) n, AVG(conn_rssi) avg FROM scans
                WHERE id IN ({sub}) AND conn_bssid IS NOT NULL GROUP BY conn_bssid ORDER BY n DESC""", p)
        n = head["samples"]
        for r in ssids + bssids + conn + aps:
            r["seen"] = r["n"] / n if n else 0
        for r in bssids:
            r["alias"] = self.alias(r["bssid"]) if r["ssid"] == "(hidden)" else None
        head["conn_ssid"] = top[0]["conn_ssid"] if top else None
        head.update(ssids=ssids, bssids=bssids, conn=conn, aps=aps)
        return head

    def rooms(self):
        rooms = self.q("SELECT id, name, created FROM rooms WHERE session_id = ? ORDER BY name COLLATE NOCASE",
                       (self.session_id,))
        for r in rooms:
            r["captures"] = self.q(
                "SELECT id, start_ts, end_ts FROM captures WHERE room_id = ? ORDER BY start_ts",
                (r["id"],))
            r["stats"] = self.stats("c.room_id = ?", (r["id"],))
        return rooms

    def active_capture(self):
        r = self.q(
            """SELECT c.id, c.room_id, r.name room, c.start_ts, c.end_ts
               FROM captures c JOIN rooms r ON r.id = c.room_id
               WHERE r.session_id = ? AND (c.end_ts IS NULL OR c.end_ts > ?) ORDER BY c.id DESC LIMIT 1""",
            (self.session_id, time.time()))
        return r[0] if r else None

    def room_in_session(self, room_id):
        return bool(self.q("SELECT 1 FROM rooms WHERE id = ? AND session_id = ?", (room_id, self.session_id)))

    def start_capture(self, room_id, duration):
        """Attribute the recording from now on to a room; switches away from any current room."""
        with self.lock:
            t = time.time()
            started = not self.recording_id
            self._start_recording_locked(None)
            self.db.execute("UPDATE captures SET end_ts = ? WHERE end_ts IS NULL OR end_ts > ?", (t, t))
            cur = self.db.execute(
                "INSERT INTO captures(room_id, start_ts, end_ts) VALUES (?,?,?)",
                (room_id, t, t + duration if duration else None))
            self.db.commit()
            return {"id": cur.lastrowid, "recording_started": started}

    def stop_capture(self):
        t = time.time()
        self.x("UPDATE captures SET end_ts = ? WHERE end_ts IS NULL OR end_ts > ?", (t, t))

    def export_rows(self, since):
        return self.q(
            """SELECT r.ts, r.ssid, r.bssid, r.rssi, r.noise, r.channel, r.band, r.width, r.phy,
                      s.conn_ssid, s.conn_bssid, s.conn_rssi, s.recording_id, rm.name room, an.name ap_name
               FROM readings r JOIN scans s ON s.id = r.scan_id
               LEFT JOIN ap_names an ON an.bssid = r.bssid
               LEFT JOIN captures c ON r.ts >= c.start_ts AND r.ts <= COALESCE(c.end_ts, 1e18)
                    AND c.room_id IN (SELECT id FROM rooms WHERE session_id = r.session_id)
               LEFT JOIN rooms rm ON rm.id = c.room_id
               WHERE r.session_id = ? AND r.ts >= ? ORDER BY r.ts""",
            (self.session_id, time.time() - since))


def csv_safe(v):
    """Neutralise spreadsheet formulas (an SSID is attacker-controlled text)."""
    s = "" if v is None else str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


class Handler(BaseHTTPRequestHandler):
    server_version = "WiFiSurveyor/1"

    def log_request(self, code="-", size="-"):
        if isinstance(code, int) and code >= 400:
            super().log_request(code, size)

    def send_body(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CSP)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def json(self, obj, code=200):
        self.send_body(code, json.dumps(obj).encode(), "application/json")

    def fail(self, code, msg):
        self.json({"error": msg}, code)

    def read_body(self, limit):
        n = int(self.headers.get("Content-Length") or 0)
        if n < 0 or n > limit:
            raise ValueError("request body too large")
        return self.rfile.read(n)

    def read_json(self):
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            raise ValueError("expected application/json")
        data = json.loads(self.read_body(1 << 20) or b"{}")
        if not isinstance(data, dict):
            raise ValueError("expected a JSON object")
        return data

    def since(self, default):
        return min(MAX_SINCE, max(10.0, float(self.qs.get("since", default))))

    def keys(self):
        if "keys" not in self.qs:
            return None
        keys = json.loads(self.qs["keys"])
        if not isinstance(keys, list) or len(keys) > 40 or not all(isinstance(k, str) and len(k) <= 128 for k in keys):
            raise ValueError("bad keys")
        return keys

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        # Block DNS rebinding and cross-site requests: only our own origin may talk to us.
        if self.headers.get("Host") not in self.server.allowed_hosts:
            return self.fail(403, "bad host")
        if method != "GET" and self.headers.get("X-Requested-With") != "surveyor":
            return self.fail(403, "missing X-Requested-With header")
        u = urlparse(self.path)
        self.qs = {k: v[-1] for k, v in parse_qs(u.query).items()}
        p = u.path
        parts = [s for s in p.split("/") if s]
        st = self.server.store
        try:
            if method == "GET":
                if p in STATIC:
                    name, ctype = STATIC[p]
                    body = (WEB / name).read_bytes()
                    if name == "index.html":
                        # Versioned asset URLs so browsers never run a stale script after an update.
                        for asset in ("style.css", "app.js", "live.js", "channels.js"):
                            v = int((WEB / asset).stat().st_mtime)
                            body = body.replace(f'"/{asset}"'.encode(), f'"/{asset}?v={v}"'.encode())
                    return self.send_body(200, body, ctype)
                if p == "/api/status":
                    return self.json(self.status())
                if p == "/api/live":
                    since = min(LIVE_KEEP, self.since(300))
                    return self.json(live_view(self.server, since, self.qs.get("all") == "1",
                                               self.qs.get("points") != "0"))
                if p == "/api/channels":
                    view = live_view(self.server, min(LIVE_KEEP, self.since(60)), False, False)
                    view["changes"] = st.q("SELECT * FROM channel_changes ORDER BY ts DESC LIMIT 100")
                    return self.json(view)
                if p == "/api/ssids":
                    return self.json(st.ssids())
                if p == "/api/timeseries":
                    group = "bssid" if self.qs.get("group") == "bssid" else "ssid"
                    t0, t1 = self.window(900)
                    return self.json(st.timeseries(t0, t1, group, self.keys()))
                if p == "/api/recordings":
                    return self.json(st.recordings())
                if p == "/api/filters":
                    return self.json(st.filters)
                if p == "/api/apnames":
                    return self.json(st.ap_names)
                if p == "/api/rooms":
                    return self.json(st.rooms())
                if p == "/api/sessions":
                    return self.json(st.sessions())
                if p == "/api/export.csv":
                    return self.export()
            elif method == "POST":
                if p == "/api/rooms":
                    return self.add_room()
                if p == "/api/capture/start":
                    return self.start_capture()
                if p == "/api/capture/stop":
                    st.stop_capture()
                    return self.json({"ok": True})
                if p == "/api/record/start":
                    name = str(self.read_json().get("name") or "").strip()[:64] or None
                    return self.json({"id": st.start_recording(name)})
                if p == "/api/record/stop":
                    st.stop_recording()
                    return self.json({"ok": True})
                if p == "/api/filters":
                    return self.add_filter()
                if p == "/api/apnames":
                    return self.set_ap_name()
                if p == "/api/sessions":
                    return self.json({"id": st.create_session(self.name_arg("session"))})
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "activate":
                    st.set_session(int(parts[2]))
                    return self.json({"ok": True})
                if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "rename":
                    st.rename_session(int(parts[2]), self.name_arg("session"))
                    return self.json({"ok": True})
                if p == "/api/quit":
                    self.json({"ok": True})
                    return self.server.quit()
            elif method == "DELETE" and len(parts) == 3 and parts[0] == "api":
                ident = int(parts[2])
                if parts[1] == "rooms":
                    st.x("DELETE FROM rooms WHERE id = ? AND session_id = ?", (ident, st.session_id))
                    return self.json({"ok": True})
                if parts[1] == "captures":
                    st.x("DELETE FROM captures WHERE id = ? AND room_id IN (SELECT id FROM rooms WHERE session_id = ?)",
                         (ident, st.session_id))
                    return self.json({"ok": True})
                if parts[1] == "sessions":
                    st.delete_session(ident)
                    return self.json({"ok": True})
                if parts[1] == "recordings":
                    st.delete_recording(ident)
                    return self.json({"ok": True})
                if parts[1] == "filters":
                    st.delete_filter(ident)
                    return self.json({"ok": True})
            self.fail(404, "not found")
        except Conflict as e:
            self.fail(409, str(e))
        except (ValueError, TypeError) as e:
            self.fail(400, str(e))
        except Exception:
            traceback.print_exc()
            self.fail(500, "internal error")

    def status(self):
        st, state, live = self.server.store, self.server.state, self.server.live
        lat = live.latest()
        last = None
        if lat:
            c = lat.get("connected") or {}
            last = {"ts": lat["ts"], "error": lat.get("error"), **{k: c.get(k) for k in (
                "ssid", "bssid", "rssi", "noise", "channel", "band", "width", "tx_rate", "tx_power", "phy", "country")}}
        cap = st.active_capture()
        if cap:
            cap["stats"] = st.stats("c.id = ?", (cap["id"],))
        alive = bool(state["last_scan"] and time.time() - state["last_scan"] < state["interval"] * 3 + 15)
        return {"now": time.time(), "scanner": {**state, "alive": alive, "rate": live.rate()}, "last": last,
                "session": st.current_session(), "recording": st.active_recording(), "capture": cap}

    def name_arg(self, what):
        name = str(self.read_json().get("name") or "").strip()
        if not 1 <= len(name) <= 64:
            raise ValueError(f"{what} name must be 1-64 characters")
        return name

    def window(self, default):
        now = time.time()
        if "start" in self.qs:
            t0, t1 = float(self.qs["start"]), float(self.qs.get("end", now))
            if not t0 < t1:
                raise ValueError("bad time window")
            return t0, t1
        t0 = max(now - self.since(default), self.server.store.first_ts() or now - 60)
        return min(t0, now - 60), now

    def add_filter(self):
        b = self.read_json()
        kind, action = b.get("kind"), b.get("action")
        value = str(b.get("value") or "").strip()
        if kind not in ("ssid", "bssid") or action not in ("include", "exclude"):
            raise ValueError("kind must be ssid/bssid and action include/exclude")
        if kind == "bssid":
            value = norm_bssid(value) or ""
        # An empty SSID rule targets hidden networks.
        if len(value) > 128 or (kind == "bssid" and not value):
            raise ValueError("value must be 1-128 characters")
        self.server.store.add_filter(kind, value, action)
        self.json({"ok": True})

    def set_ap_name(self):
        b = self.read_json()
        name = str(b.get("name") or "").strip()
        raw = b.get("bssids")
        if not isinstance(raw, list) or not 1 <= len(raw) <= 64 or len(name) > 48:
            raise ValueError("need 1-64 bssids and a name of at most 48 characters")
        bssids = [norm_bssid(str(x)) for x in raw]
        if not all(x and re.fullmatch(r"[0-9a-f]{2}(:[0-9a-f]{2}){5}", x) for x in bssids):
            raise ValueError("invalid BSSID")
        self.server.store.set_ap_name(bssids, name)
        self.json({"ok": True})

    def add_room(self):
        name = self.name_arg("room")
        st = self.server.store
        try:
            cur = st.x("INSERT INTO rooms(session_id, name, created) VALUES (?, ?, ?)", (st.session_id, name, time.time()))
        except sqlite3.IntegrityError:
            raise Conflict(f"room '{name}' already exists in this session")
        self.json({"id": cur.lastrowid})

    def start_capture(self):
        st, b = self.server.store, self.read_json()
        room = int(b.get("room_id") or 0)
        if not st.room_in_session(room):
            raise ValueError("unknown room")
        duration = float(b.get("duration") or 0)
        if duration and not 5 <= duration <= 3600:
            raise ValueError("duration must be 5-3600 s")
        self.json(st.start_capture(room, duration))

    def export(self):
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["time", "epoch", "recording", "room", "ssid", "bssid", "ap_name", "rssi_dbm", "noise_dbm", "channel",
                    "band_ghz", "width_mhz", "phy", "connected_ssid", "connected_bssid", "connected_rssi_dbm"])
        for r in self.server.store.export_rows(self.since(MAX_SINCE)):
            w.writerow([time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r["ts"])), f"{r['ts']:.1f}",
                        r["recording_id"], csv_safe(r["room"]), csv_safe(r["ssid"]), r["bssid"], csv_safe(r["ap_name"]),
                        r["rssi"], r["noise"], r["channel"], r["band"], r["width"], r["phy"], csv_safe(r["conn_ssid"]),
                        r["conn_bssid"], r["conn_rssi"]])
        self.send_body(200, buf.getvalue().encode(), "text/csv; charset=utf-8",
                       {"Content-Disposition": 'attachment; filename="wifi-survey.csv"'})


class Live:
    """Last hour of scans in memory (recorded or not), plus per-BSSID channel tracking."""

    def __init__(self):
        self.lock = threading.Lock()
        self.scans = deque()
        self.channels = {}
        self.times = deque(maxlen=20)

    def rate(self):
        """Measured seconds per scan (CoreWLAN scans can take longer than the requested interval)."""
        with self.lock:
            t = list(self.times)
        return (t[-1] - t[0]) / (len(t) - 1) if len(t) > 1 else None

    def add(self, rec):
        changes = []
        with self.lock:
            self.scans.append(rec)
            self.times.append(rec["ts"])
            while self.scans[0]["ts"] < rec["ts"] - LIVE_KEEP:
                self.scans.popleft()
            for n in rec.get("networks") or []:
                b = n.get("bssid")
                if not b:
                    continue
                cur = (n.get("channel"), n.get("band"), n.get("width"))
                old = self.channels.get(b)
                if old is not None and old[:2] != cur[:2]:
                    changes.append({"ts": rec["ts"], "bssid": b, "ssid": n.get("ssid"),
                                    "old_channel": old[0], "new_channel": cur[0], "old_band": old[1],
                                    "new_band": cur[1], "old_width": old[2], "new_width": cur[2]})
                self.channels[b] = cur
        return changes

    def window(self, since):
        t = time.time() - since
        with self.lock:
            return [s for s in self.scans if s["ts"] >= t]

    def latest(self):
        with self.lock:
            return self.scans[-1] if self.scans else None


def thin(points, t0, t1, n=300):
    """Average points into ~n time buckets so long windows stay light."""
    if len(points) <= n * 1.5:
        return points, None
    b = (t1 - t0) / n
    out, cur, acc = [], None, []
    for t, v in points:
        k = int((t - t0) / b)
        if k != cur:
            if acc:
                out.append([t0 + (cur + 0.5) * b, sum(acc) / len(acc)])
            cur, acc = k, []
        if v is not None:
            acc.append(v)
    if acc:
        out.append([t0 + (cur + 0.5) * b, sum(acc) / len(acc)])
    return out, b


def live_view(srv, since, include_all, with_points):
    """Per-AP signal over the last `since` seconds from the in-memory buffer."""
    st, now = srv.store, time.time()
    scans = srv.live.window(since)
    with_nets = [s for s in scans if s.get("networks")]
    last_ts = with_nets[-1]["ts"] if with_nets else None
    aps, skip = {}, set()
    for sc in with_nets:
        for n in sc["networks"]:
            ssid, bssid = n.get("ssid"), n.get("bssid")
            key = bssid or f"(redacted) {ssid or '?'} ch{n.get('channel')}"
            if key in skip:
                continue
            a = aps.get(key)
            if a is None:
                included = st.passes(ssid, bssid)
                if not included and not include_all:
                    skip.add(key)
                    continue
                label = ssid_label(ssid, bssid)
                a = aps[key] = {"key": key, "bssid": bssid or "(redacted)", "ssid": label,
                                "alias": st.alias(bssid) if label == "(hidden)" else None,
                                "included": included, "points": []}
            a.update(channel=n.get("channel"), band=n.get("band"), width=n.get("width"), phy=n.get("phy"))
            rssi = n.get("rssi")
            # Without BSSIDs, radios on one channel share a key: keep the strongest per scan.
            if a["points"] and a["points"][-1][0] == sc["ts"]:
                prev = a["points"][-1][1]
                a["points"][-1][1] = rssi if prev is None else max(prev, rssi if rssi is not None else prev)
            else:
                a["points"].append([sc["ts"], rssi])
    bucket = None
    out = []
    for a in aps.values():
        vals = [v for _, v in a["points"] if v is not None]
        a.update(now=a["points"][-1][1] if a["points"][-1][0] == last_ts else None,
                 avg=sum(vals) / len(vals) if vals else None, min=min(vals, default=None),
                 max=max(vals, default=None), seen=len(a["points"]) / len(with_nets),
                 last_seen=a["points"][-1][0])
        if with_points:
            a["points"], b = thin(a["points"], now - since, now)
            bucket = b or bucket
        else:
            del a["points"]
        out.append(a)
    out.sort(key=lambda a: -(a["avg"] if a["avg"] is not None else -999))
    conn = (scans[-1].get("connected") or {}) if scans else {}
    conn_pts = [[s["ts"], s["connected"]["rssi"]] for s in scans
                if (s.get("connected") or {}).get("rssi") is not None]
    if with_points:
        conn_pts, b = thin(conn_pts, now - since, now)
        bucket = b or bucket
    return {"t0": now - since, "t1": now, "interval": srv.state["interval"], "bucket": bucket,
            "scans": len(with_nets), "aps": out,
            "connected": {"ssid": conn.get("ssid"), "bssid": conn.get("bssid"),
                          "points": conn_pts if with_points else None}}


def tail_feed(path, srv, stop):
    pos, buf = 0, b""
    while not stop.is_set():
        try:
            with open(path, "rb") as f:
                f.seek(pos)
                chunk = f.read()
                pos = f.tell()
        except FileNotFoundError:
            chunk = b""
        if chunk:
            *lines, buf = (buf + chunk).split(b"\n")
            for line in lines:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if rec.get("type") == "scan":
                    for n in rec.get("networks") or []:
                        n["bssid"] = norm_bssid(n.get("bssid"))
                        srv.store.learn_name(n.get("ssid"), n["bssid"])
                    if rec.get("connected"):
                        rec["connected"]["bssid"] = norm_bssid(rec["connected"].get("bssid"))
                    changes = srv.live.add(rec)
                    if changes:
                        srv.store.add_channel_changes(changes)
                    srv.store.ingest(rec)
                    srv.state["last_scan"] = rec["ts"]
                    srv.state["scan_error"] = rec.get("error")
                elif rec.get("type") == "status":
                    srv.state["auth"] = rec.get("auth")
        stop.wait(0.5)


def watch_parent(pid, shutdown, stop):
    while not stop.wait(2):
        if os.getppid() != pid:
            shutdown()
            return


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--interval", type=float, default=1.0, help="scanner interval, for display")
    ap.add_argument("--data", default=str(ROOT / "data"), help="data directory")
    ap.add_argument("--feed", help="scanner JSON-lines feed to tail (set by the app)")
    ap.add_argument("--parent-pid", type=int, default=0, help="exit when this process (the app) exits")
    a = ap.parse_args()

    # Recordings reveal where you are; keep them readable by this user only.
    os.umask(0o077)
    data = Path(a.data)
    data.mkdir(parents=True, exist_ok=True)
    data.chmod(0o700)
    store = Store(data / "survey.db")
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    srv.daemon_threads = True
    srv.store, srv.data, srv.live = store, data, Live()
    srv.state = {"feed": bool(a.feed), "interval": a.interval, "auth": None, "last_scan": None, "scan_error": None}
    srv.allowed_hosts = {f"127.0.0.1:{a.port}", f"localhost:{a.port}"}
    stop = threading.Event()

    def shutdown(*_):
        if not stop.is_set():
            stop.set()
            threading.Thread(target=srv.shutdown, daemon=True).start()

    def quit_all():
        def go():
            time.sleep(0.3)
            # Ask the app to quit; it stops scanning and then SIGTERMs us.
            if a.parent_pid and os.getppid() == a.parent_pid:
                os.kill(a.parent_pid, signal.SIGTERM)
            else:
                shutdown()
        threading.Thread(target=go, daemon=True).start()

    srv.quit = quit_all
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    if a.feed:
        threading.Thread(target=tail_feed, args=(Path(a.feed), srv, stop), daemon=True).start()
    if a.parent_pid:
        threading.Thread(target=watch_parent, args=(a.parent_pid, shutdown, stop), daemon=True).start()
    print(f"Wi-Fi surveyor running at http://127.0.0.1:{a.port}/" + ("" if a.feed else "  (review mode, no scanner)"))
    try:
        srv.serve_forever()
    finally:
        stop.set()
        store.shutdown()
        srv.server_close()
        print("Surveyor stopped; recording saved.")


if __name__ == "__main__":
    main()
