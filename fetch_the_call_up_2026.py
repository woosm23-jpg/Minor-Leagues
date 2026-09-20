#!/usr/bin/env python3
"""THE CALL-UP v47 real-world 2026 production snapshot collector.

Runs on GitHub Actions, where MLB Stats API access is available.
Collects MLB + AAA + AA + High-A + Single-A teams, rosters, stats, schedules,
affiliations, and MLB venue geometry. It resolves duplicate MiLB rehab/IL
roster appearances by MLBAM player id and emits the exact Master Snapshot v1
shape expected by THE CALL-UP v47.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

SEASON = int(os.environ.get("SEASON", "2026"))
BASE = "https://statsapi.mlb.com/api/v1"
OUT = Path(os.environ.get("TCU_OUT", "data/the_call_up_2026"))
UA = "THE-CALL-UP-v47-production-snapshot/2.0"
SPORT_LEVELS = {1: "MLB", 11: "AAA", 12: "AA", 13: "HIGH_A", 14: "A"}
LEVEL_RANK = {"MLB": 5, "AAA": 4, "AA": 3, "HIGH_A": 2, "A": 1}
MINOR_LEVELS = ("AAA", "AA", "HIGH_A", "A")

# MLB Stats API omits full five-point fieldInfo geometry for Sutter Health Park
# (Athletics interim home). MLB.com's official park guide publishes LF/CF/RF as
# 330/403/325 ft. The two gap values below are deterministic interpolation
# inputs for the simulation only; the published endpoints remain unchanged.
KNOWN_PARK_GEOMETRY_FALLBACKS = {
    "2529": {
        "name": "Sutter Health Park",
        "geometry": {"lfLine": 330, "lfGap": 385, "cf": 403, "rfGap": 384, "rfLine": 325},
        "sourceId": "mlb_sutter_health_park_guide",
    },
    "31": {
        "name": "PNC Park",
        "geometry": {"lfLine": 325, "lfGap": 389, "cf": 399, "rfGap": 375, "rfLine": 320},
        "sourceId": "mlb_pnc_park_ground_rules",
    },
}


def get_json(path: str, params: dict | None = None, retries: int = 5):
    url = f"{BASE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            last = exc
            if attempt + 1 < retries:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET failed after {retries} attempts: {url}: {last}")


def write_json(name: str, payload, *, pretty: bool = False):
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    if pretty:
        text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    else:
        text = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    path.write_text(text, encoding="utf-8")
    return {
        "file": str(path),
        "bytes": path.stat().st_size,
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    }


def text(value):
    return None if value is None else str(value)


def source_id(kind: str, sport_id: int | None = None):
    return f"mlb_stats_{kind}" if sport_id is None else f"mlb_stats_{kind}_sport_{sport_id}"


def team_row(raw: dict, sport_id: int):
    level = SPORT_LEVELS[sport_id]
    parent = raw.get("parentOrg") or raw.get("parentOrganization") or {}
    parent_id = raw.get("parentOrgId") or parent.get("id")
    if level == "MLB":
        parent_id = raw.get("id")
    return {
        "id": text(raw.get("id")),
        "name": raw.get("name") or f"Team {raw.get('id')}",
        "abbreviation": raw.get("abbreviation") or raw.get("teamCode") or "",
        "level": level,
        "parentOrganizationId": text(parent_id),
        "leagueId": text((raw.get("league") or {}).get("id")),
        "divisionId": text((raw.get("division") or {}).get("id")),
        "venueId": text((raw.get("venue") or {}).get("id")),
        "active": raw.get("active", True) is not False,
        "sourceId": source_id("teams", sport_id),
    }


def roster_row(entry: dict, team: dict, sport_id: int):
    p = entry.get("person") or {}
    pos = entry.get("position") or p.get("primaryPosition") or {}
    status = entry.get("status") or {}
    return {
        "id": text(p.get("id")),
        "fullName": p.get("fullName") or p.get("fullFMLName") or f"Player {p.get('id')}",
        "teamId": team["id"],
        "level": SPORT_LEVELS[sport_id],
        "status": status.get("description") or status.get("code") or "UNKNOWN",
        "position": pos.get("abbreviation") or "UNK",
        "birthDate": p.get("birthDate"),
        "age": p.get("currentAge"),
        "bats": (p.get("batSide") or {}).get("code"),
        "throws": (p.get("pitchHand") or {}).get("code"),
        "height": p.get("height"),
        "weight": p.get("weight"),
        "mlbDebutDate": p.get("mlbDebutDate"),
        "active": p.get("active", True) is not False,
        "sourceId": source_id("rosters", sport_id),
    }


def canonical_roster_score(row: dict):
    status = str(row.get("status") or "").lower()
    # Active assignment wins. Rehab assignment is explicitly temporary.
    if status == "active" or status.startswith("active "):
        status_score = 40
    elif "rehab" in status:
        status_score = 10
    elif "injured" in status or "disabled" in status:
        status_score = 20
    else:
        status_score = 30
    return (status_score, LEVEL_RANK.get(row.get("level"), 0), str(row.get("teamId") or ""))


def dedupe_rosters(rows: list[dict]):
    by_player: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        if row.get("id"):
            by_player[str(row["id"])].append(row)
    chosen = []
    duplicate_report = []
    for player_id, candidates in by_player.items():
        ranked = sorted(candidates, key=canonical_roster_score, reverse=True)
        winner = ranked[0]
        chosen.append(winner)
        if len(ranked) > 1:
            duplicate_report.append({
                "playerId": player_id,
                "fullName": winner.get("fullName"),
                "kept": {"teamId": winner.get("teamId"), "level": winner.get("level"), "status": winner.get("status")},
                "discarded": [
                    {"teamId": x.get("teamId"), "level": x.get("level"), "status": x.get("status")}
                    for x in ranked[1:]
                ],
            })
    chosen.sort(key=lambda r: (LEVEL_RANK.get(r["level"], 0) * -1, r["teamId"], r["id"]))
    return chosen, duplicate_report


def stat_rows(raw: dict, sport_id: int, group: str):
    level = SPORT_LEVELS[sport_id]
    out = []
    for block in raw.get("stats") or []:
        for split in block.get("splits") or []:
            person = split.get("player") or split.get("person") or {}
            if person.get("id") is None:
                continue
            out.append({
                "playerId": text(person.get("id")),
                "teamId": text((split.get("team") or {}).get("id")),
                "level": level,
                "season": int(split.get("season") or SEASON),
                "group": group,
                "gameType": split.get("gameType") or "R",
                "position": (split.get("position") or {}).get("abbreviation") or (split.get("position") or {}).get("code"),
                "values": dict(split.get("stat") or {}),
                "sourceId": source_id("stats", sport_id),
            })
    return out


def schedule_rows(raw: dict, sport_id: int):
    level = SPORT_LEVELS[sport_id]
    out = []
    for date_block in raw.get("dates") or []:
        for g in date_block.get("games") or []:
            home = ((g.get("teams") or {}).get("home") or {})
            away = ((g.get("teams") or {}).get("away") or {})
            out.append({
                "gamePk": text(g.get("gamePk")),
                "date": str(date_block.get("date") or g.get("officialDate") or "")[:10],
                "level": level,
                "gameType": g.get("gameType") or "R",
                "status": ((g.get("status") or {}).get("abstractGameState")
                           or (g.get("status") or {}).get("detailedState") or "SCHEDULED"),
                "awayTeamId": text((away.get("team") or {}).get("id")),
                "homeTeamId": text((home.get("team") or {}).get("id")),
                "awayScore": away.get("score"),
                "homeScore": home.get("score"),
                "venueId": text((g.get("venue") or {}).get("id")),
                "sourceId": source_id("schedule", sport_id),
            })
    return out


def park_number(value):
    if value is None or value == "":
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", str(value))
    if not m:
        return None
    n = float(m.group(0))
    return int(n) if n.is_integer() else n


def venue_row(raw: dict, team: dict):
    venue = (raw.get("venues") or [None])[0] or raw.get("venue") or raw
    if not venue or venue.get("id") is None:
        return None
    f = venue.get("fieldInfo") or {}
    geometry = {
        "lfLine": park_number(f.get("leftLine")),
        "lfGap": park_number(f.get("leftCenter")),
        "cf": park_number(f.get("center")),
        "rfGap": park_number(f.get("rightCenter")),
        "rfLine": park_number(f.get("rightLine")),
    }
    venue_id = text(venue.get("id"))
    source_id = "mlb_stats_venues"
    if any(v is None for v in geometry.values()):
        fallback = KNOWN_PARK_GEOMETRY_FALLBACKS.get(venue_id)
        if fallback:
            geometry = dict(fallback["geometry"])
            source_id = fallback["sourceId"]
            print(f"[TCU] venue geometry fallback: {fallback['name']} venue={venue_id} geometry={geometry}")
        else:
            # Preserve every API-supplied distance, and fill only missing points.
            # This prevents one incomplete MLB fieldInfo record from blocking the
            # production snapshot while keeping the approximation explicit.
            lf = geometry["lfLine"] if geometry["lfLine"] is not None else 330
            cf = geometry["cf"] if geometry["cf"] is not None else 400
            rf = geometry["rfLine"] if geometry["rfLine"] is not None else 330
            geometry = {
                "lfLine": lf,
                "lfGap": geometry["lfGap"] if geometry["lfGap"] is not None else round(lf * 0.30 + cf * 0.70),
                "cf": cf,
                "rfGap": geometry["rfGap"] if geometry["rfGap"] is not None else round(rf * 0.30 + cf * 0.70),
                "rfLine": rf,
            }
            source_id = "mlb_stats_venues_interpolated"
            print(f"[TCU] venue geometry interpolated: {venue.get('name')} venue={venue_id} geometry={geometry}")
    return {
        "venueId": venue_id,
        "teamId": team["id"],
        "name": venue.get("name") or team.get("name") or f"Venue {venue.get('id')}",
        "geometry": geometry,
        "wallHeights": {},
        "empiricalFactors": None,
        "carryDistanceFeet": 0,
        "sourceId": source_id,
    }


def collect_team_like(value, out=None):
    if out is None:
        out = []
    if isinstance(value, list):
        for item in value:
            collect_team_like(item, out)
    elif isinstance(value, dict):
        if value.get("id") is not None and value.get("name") and ((value.get("sport") or {}).get("id") is not None or value.get("sportId") is not None):
            out.append(value)
        for child in value.values():
            if isinstance(child, (dict, list)):
                collect_team_like(child, out)
    return out


def affiliation_rows_from_teams(teams):
    rows = []
    for team in teams:
        if team["level"] != "MLB" and team.get("parentOrganizationId"):
            rows.append({
                "organizationId": str(team["parentOrganizationId"]),
                "mlbTeamId": str(team["parentOrganizationId"]),
                "level": team["level"],
                "teamId": str(team["id"]),
                "effectiveSeason": SEASON,
                "sourceId": team.get("sourceId") or "mlb_stats_teams",
            })
    return rows


def resolve_missing_affiliations(teams, affiliations):
    mlb_ids = {t["id"] for t in teams if t["level"] == "MLB"}
    existing = {(a["organizationId"], a["level"]) for a in affiliations}
    team_by_id = {t["id"]: t for t in teams}
    for org_id in sorted(mlb_ids):
        missing = [lvl for lvl in MINOR_LEVELS if (org_id, lvl) not in existing]
        if not missing:
            continue
        raw = get_json("/teams/affiliates", {"teamIds": org_id, "season": SEASON})
        for raw_team in collect_team_like(raw):
            sport_id = ((raw_team.get("sport") or {}).get("id") or raw_team.get("sportId"))
            level = SPORT_LEVELS.get(int(sport_id)) if sport_id is not None else None
            team_id = text(raw_team.get("id"))
            if level not in MINOR_LEVELS or not team_id or team_id not in team_by_id:
                continue
            key = (org_id, level)
            if key in existing:
                continue
            affiliations.append({
                "organizationId": org_id,
                "mlbTeamId": org_id,
                "level": level,
                "teamId": team_id,
                "effectiveSeason": SEASON,
                "sourceId": "mlb_stats_teams",
            })
            existing.add(key)
    return affiliations


def unique_by(rows, key_fn):
    seen = set()
    out = []
    for row in rows:
        key = key_fn(row)
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


# JavaScript JSON.stringify-compatible enough for normalized Master Snapshot values.
def js_json(value):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            return "null"
        if value == 0:
            return "0"
        if value.is_integer() and abs(value) < 1e21:
            return str(int(value))
        # API payloads rarely require edge-case JS number formatting; 15 sig figs
        # matches all normalized values used by this snapshot.
        return format(value, ".15g").replace("e+", "e+")
    raise TypeError(f"unsupported scalar for stable hash: {type(value)}")


def stable(value):
    if isinstance(value, list):
        return "[" + ",".join(stable(x) for x in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(js_json(str(k)) + ":" + stable(value[k]) for k in sorted(value.keys())) + "}"
    return js_json(value)


def fnv1a32(text_value: str):
    h = 0x811C9DC5
    # JS charCodeAt hashes UTF-16 code units, not UTF-8 bytes.
    utf16 = text_value.encode("utf-16-le")
    for i in range(0, len(utf16), 2):
        code_unit = utf16[i] | (utf16[i + 1] << 8)
        h ^= code_unit
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"fnv1a32:{h:08x}"


def make_sources(retrieved_at: str):
    sport_ids = ",".join(map(str, SPORT_LEVELS.keys()))
    return [
        {"id": "mlb_stats_teams", "name": "MLB Stats API — teams/affiliates", "url": f"{BASE}/teams", "retrievedAt": retrieved_at, "notes": f"season={SEASON}; sportIds={sport_ids}"},
        {"id": "mlb_stats_rosters", "name": "MLB Stats API — team rosters", "url": f"{BASE}/teams/{{teamId}}/roster", "retrievedAt": retrieved_at, "notes": f"season={SEASON}; MLB=active, MiLB=fullRoster; duplicate rehab/IL assignments resolved by MLBAM id"},
        {"id": "mlb_stats_stats", "name": "MLB Stats API — standard player stats", "url": f"{BASE}/stats", "retrievedAt": retrieved_at, "notes": f"season={SEASON}; groups=hitting,pitching,fielding"},
        {"id": "mlb_stats_schedule", "name": "MLB Stats API — schedules", "url": f"{BASE}/schedule", "retrievedAt": retrieved_at, "notes": f"season={SEASON}; gameTypes=R"},
        {"id": "mlb_stats_venues", "name": "MLB Stats API — venue field geometry", "url": f"{BASE}/venues/{{venueId}}", "retrievedAt": retrieved_at, "notes": f"season={SEASON}; MLB home venues"},
        {"id": "mlb_sutter_health_park_guide", "name": "MLB.com — Sutter Health Park guide", "url": "https://www.mlb.com/news/featured/sutter-health-park-guide-capacity-seating-chart-parking-and-more", "retrievedAt": retrieved_at, "notes": "Published dimensions LF 330 ft / CF 403 ft / RF 325 ft; LCF/RCF are deterministic simulation interpolation values because Stats API fieldInfo is incomplete for venue 2529."},
        {"id": "mlb_pnc_park_ground_rules", "name": "MLB.com Pirates — PNC Park ground rules", "url": "https://www.mlb.com/pirates/ballpark/ground-rules", "retrievedAt": retrieved_at, "notes": "Published dimensions LF 325 ft / LCF 389 ft / CF 399 ft / RCF 375 ft / RF 320 ft."},
        {"id": "mlb_stats_venues_interpolated", "name": "MLB Stats API — incomplete venue geometry interpolation", "url": f"{BASE}/venues/{{venueId}}", "retrievedAt": retrieved_at, "notes": "Fallback only when fieldInfo omits one or more distances. API-supplied values are preserved; missing lines default to 330 ft, center to 400 ft, and missing gaps are a deterministic 30/70 line-to-center interpolation. Count is exposed in the production manifest."},
    ]


def runtime_roster_check(players: list[dict], teams: list[dict]):
    # Position-first classification mirrors the v47 production fix: position players
    # who threw a mop-up inning remain hitters instead of becoming pitchers.
    by_team = defaultdict(list)
    for p in players:
        if p.get("active", True) is not False:
            by_team[p["teamId"]].append(p)
    bad = {}
    for team in teams:
        roster = by_team.get(team["id"], [])
        pitchers = [p for p in roster if str(p.get("position") or "").upper() in {"P", "SP", "RP"}]
        hitters = [p for p in roster if p not in pitchers]
        if len(hitters) < 10 or len(pitchers) < 8:
            bad[team["id"]] = {"name": team["name"], "level": team["level"], "hitters": len(hitters), "pitchers": len(pitchers), "total": len(roster)}
    return bad


def schedule_coverage(schedule, teams):
    counts = Counter()
    for g in schedule:
        if g.get("gameType") == "S":
            continue
        counts[g["awayTeamId"]] += 1
        counts[g["homeTeamId"]] += 1
    return {t["id"]: counts[t["id"]] for t in teams}


def main():
    retrieved_at = datetime.now(timezone.utc).isoformat()
    snapshot_date = retrieved_at[:10]
    OUT.mkdir(parents=True, exist_ok=True)

    print(f"[TCU] season={SEASON} snapshotDate={snapshot_date}")
    teams = []
    raw_team_cache = {}
    for sport_id, level in SPORT_LEVELS.items():
        raw = get_json("/teams", {"sportId": sport_id, "season": SEASON, "hydrate": "parentOrg"})
        rows = [team_row(t, sport_id) for t in (raw.get("teams") or []) if t.get("active", True)]
        raw_team_cache[sport_id] = raw
        print(f"[TCU] teams {level}: {len(rows)}")
        teams.extend(rows)

    team_counts = Counter(t["level"] for t in teams if t.get("active", True))
    for level in SPORT_LEVELS.values():
        if team_counts[level] != 30:
            raise RuntimeError(f"{level}: expected 30 teams, got {team_counts[level]}")

    affiliations = resolve_missing_affiliations(teams, affiliation_rows_from_teams(teams))
    affiliations = unique_by(affiliations, lambda r: (r["organizationId"], r["level"]))
    mlb_ids = {t["id"] for t in teams if t["level"] == "MLB"}
    coverage = defaultdict(set)
    for row in affiliations:
        if row["organizationId"] not in mlb_ids:
            raise RuntimeError(f"invalid organization in affiliation: {row}")
        coverage[row["organizationId"]].add(row["level"])
    missing_aff = {org: sorted(set(MINOR_LEVELS) - levels) for org, levels in coverage.items() if set(MINOR_LEVELS) - levels}
    if len(coverage) != 30 or missing_aff:
        raise RuntimeError(f"affiliate coverage invalid: orgs={len(coverage)} missing={missing_aff}")

    print("[TCU] fetching rosters")
    raw_rosters = []
    for i, team in enumerate(teams, 1):
        sport_id = next(sid for sid, lvl in SPORT_LEVELS.items() if lvl == team["level"])
        roster_type = "active" if team["level"] == "MLB" else "fullRoster"
        raw = get_json(f"/teams/{team['id']}/roster", {"rosterType": roster_type, "season": SEASON, "hydrate": "person"})
        raw_rosters.extend(roster_row(entry, team, sport_id) for entry in (raw.get("roster") or []))
        if i % 20 == 0 or i == len(teams):
            print(f"  rosters {i}/{len(teams)} teams, rows={len(raw_rosters)}")
        time.sleep(0.03)

    players, duplicate_report = dedupe_rosters(raw_rosters)
    print(f"[TCU] roster rows raw={len(raw_rosters)} canonical={len(players)} duplicatesResolved={len(duplicate_report)}")

    print("[TCU] fetching stats")
    stats = []
    stat_counts = {}
    for sport_id, level in SPORT_LEVELS.items():
        for group in ("hitting", "pitching", "fielding"):
            raw = get_json("/stats", {
                "stats": "season", "group": group, "season": SEASON,
                "sportIds": sport_id, "playerPool": "ALL", "limit": 5000, "hydrate": "team",
            })
            rows = stat_rows(raw, sport_id, group)
            stats.extend(rows)
            stat_counts[f"{level}:{group}"] = len(rows)
            print(f"  stats {level}/{group}: {len(rows)}")
    stats = unique_by(stats, lambda r: (r["playerId"], r.get("teamId"), r["level"], r["group"], r.get("gameType"), r.get("position")))

    print("[TCU] fetching schedules")
    schedule = []
    for sport_id, level in SPORT_LEVELS.items():
        raw = get_json("/schedule", {"sportId": sport_id, "season": SEASON, "gameTypes": "R"})
        rows = schedule_rows(raw, sport_id)
        schedule.extend(rows)
        print(f"  schedule {level}: {len(rows)}")
    schedule = unique_by(schedule, lambda r: r["gamePk"])

    print("[TCU] fetching MLB venue geometry")
    parks = []
    for team in [t for t in teams if t["level"] == "MLB"]:
        if not team.get("venueId"):
            raise RuntimeError(f"MLB team missing venue: {team['name']}")
        raw = get_json(f"/venues/{team['venueId']}")
        park = venue_row(raw, team)
        if not park:
            raise RuntimeError(f"MLB venue record missing entirely: {team['name']} venue={team['venueId']}")
        parks.append(park)
    parks = unique_by(parks, lambda r: r["venueId"])
    if len(parks) != 30:
        raise RuntimeError(f"expected 30 MLB parks, got {len(parks)}")

    # Coverage gates matching the v47 runtime, before producing productionReady=true.
    roster_bad = runtime_roster_check(players, teams)
    if roster_bad:
        raise RuntimeError(f"runtime roster coverage invalid: {json.dumps(roster_bad, ensure_ascii=False)}")
    schedule_counts = schedule_coverage(schedule, teams)
    thin_schedule = {t["id"]: {"name": t["name"], "level": t["level"], "games": schedule_counts[t["id"]]} for t in teams if schedule_counts[t["id"]] < 100}
    if thin_schedule:
        raise RuntimeError(f"schedule coverage <100: {json.dumps(thin_schedule, ensure_ascii=False)}")
    for level in SPORT_LEVELS.values():
        for group in ("hitting", "pitching", "fielding"):
            if stat_counts.get(f"{level}:{group}", 0) == 0:
                raise RuntimeError(f"stats empty: {level}/{group}")

    sources = make_sources(retrieved_at)
    metadata = {
        "snapshotId": f"mlb-milb-{SEASON}-{snapshot_date}-v47-production",
        "snapshotDate": snapshot_date,
        "season": SEASON,
        "createdAt": retrieved_at,
        "kind": "REAL_WORLD",
        "productionReady": True,
        "notes": "THE CALL-UP v47 real production snapshot. MLB active rosters + MiLB full rosters; duplicate rehab/IL appearances resolved by MLBAM player id. Public MLB Stats API facts only.",
    }
    core = {
        "schemaVersion": 1,
        "metadata": metadata,
        "sources": sources,
        "teams": teams,
        "players": players,
        "affiliations": affiliations,
        "stats": stats,
        "schedule": schedule,
        "parks": parks,
    }
    content_hash = fnv1a32(stable(core))
    snapshot = {**core, "metadata": {**metadata, "contentHash": content_hash}}

    files = []
    files.append(write_json("duplicate_roster_resolution.json", duplicate_report, pretty=True))
    files.append(write_json("mlb-milb-2026-production.json", snapshot))

    level_player_counts = Counter(p["level"] for p in players)
    manifest = {
        "schema": "THE_CALL_UP_PRODUCTION_MANIFEST_V2",
        "season": SEASON,
        "snapshotDate": snapshot_date,
        "retrievedAtUtc": retrieved_at,
        "source": "MLB Stats API",
        "validation": "PASS",
        "contentHash": content_hash,
        "productionCoverage": {
            "teamsByLevel": dict(sorted(team_counts.items())),
            "playersByLevel": dict(sorted(level_player_counts.items())),
            "canonicalPlayers": len(players),
            "duplicateRosterAppearancesResolved": len(duplicate_report),
            "affiliateOrganizations": len(coverage),
            "affiliations": len(affiliations),
            "statsRows": len(stats),
            "statsByLevelGroup": dict(sorted(stat_counts.items())),
            "scheduleGames": len(schedule),
            "parks": len(parks),
            "parkSourceCounts": dict(sorted(Counter(p.get("sourceId") for p in parks).items())),
            "interpolatedParkGeometry": sum(1 for p in parks if p.get("sourceId") == "mlb_stats_venues_interpolated"),
            "minScheduleGamesPerTeam": min(schedule_counts.values()),
        },
        "files": files,
    }
    write_json("production_manifest.json", manifest, pretty=True)

    # Keep the older MiLB-facing manifest filename useful for inspection.
    write_json("manifest.json", manifest, pretty=True)
    print("[TCU] PRODUCTION VALIDATION PASS")
    print(json.dumps(manifest["productionCoverage"], indent=2, ensure_ascii=False, sort_keys=True))
    print(f"[TCU] contentHash={content_hash}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[TCU] FAILED: {exc}", file=sys.stderr)
        raise
