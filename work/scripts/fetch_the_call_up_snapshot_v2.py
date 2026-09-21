#!/usr/bin/env python3
"""THE CALL-UP Master Snapshot v2 production collector.

Phase A data-integrity collector:
- canonical one-player records across MLB/MiLB roster appearances
- MLB active + 40-man + full-roster evidence, including IL/optioned when exposed
- MiLB full-roster assignment/status evidence
- 2024/2025/2026 standard stats without discarding team/level segments
- position experience derived from fielding rows
- v2 availability/ownership fields while retaining v47-v50 compatibility aliases

The network calls are intended for GitHub Actions / an environment with access to
statsapi.mlb.com. Run --self-test for an offline canonical-roster sanity check.
"""
from __future__ import annotations

import json
import os
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

# Reuse the proven v47 transport/team/schedule/park/affiliation helpers.
import fetch_the_call_up_2026 as legacy

SEASON = int(os.environ.get("SEASON", "2026"))
HISTORY_SEASONS = tuple(int(x) for x in os.environ.get("TCU_HISTORY_SEASONS", "2024,2025,2026").split(",") if x.strip())
OUT = Path(os.environ.get("TCU_OUT", "data/the_call_up_snapshot_v2"))
MLB_ROSTER_TYPES = ("active", "40Man", "fullRoster")
MINOR_ROSTER_TYPES = ("fullRoster",)

ACTIVE = "ACTIVE"
INJURED_SHORT = "INJURED_SHORT"
INJURED_60 = "INJURED_60"
INJURED_FULL_SEASON = "INJURED_FULL_SEASON"
REHAB = "REHAB"
DEVELOPMENT_LIST = "DEVELOPMENT_LIST"
RESTRICTED = "RESTRICTED"
TEMP_INACTIVE = "TEMP_INACTIVE"
ADMIN_LEAVE = "ADMIN_LEAVE"
NOT_REPORTED = "NOT_REPORTED"
UNKNOWN = "UNKNOWN"


def canonical_availability(status: str | None) -> str:
    raw = str(status or "").strip().upper().replace("–", "-").replace("—", "-")
    if not raw:
        return UNKNOWN
    if "REHAB" in raw:
        return REHAB
    if "DEVELOPMENT LIST" in raw:
        return DEVELOPMENT_LIST
    if "RESTRICTED" in raw:
        return RESTRICTED
    if "ADMINISTRATIVE LEAVE" in raw or "ADMIN LEAVE" in raw:
        return ADMIN_LEAVE
    if "NOT YET REPORTED" in raw or "NOT REPORTED" in raw:
        return NOT_REPORTED
    if any(x in raw for x in ("TEMPORARY INACTIVE", "BEREAVEMENT", "PATERNITY", "FAMILY MEDICAL", "SUSPENDED", "TAXI SQUAD", "MILITARY LEAVE", "VOLUNTARILY RETIRED")):
        return TEMP_INACTIVE
    injured = "INJUR" in raw or "DISABL" in raw
    if injured and "FULL SEASON" in raw:
        return INJURED_FULL_SEASON
    if injured and "60" in raw and "DAY" in raw:
        return INJURED_60
    if injured:
        return INJURED_SHORT
    if any(x in raw for x in ("ACTIVE", "OPTIONED", "MINORS", "ASSIGNED")):
        return ACTIVE
    return UNKNOWN


def roster_observation(entry: dict, team: dict, sport_id: int, roster_type: str) -> dict:
    row = legacy.roster_row(entry, team, sport_id)
    row["rosterType"] = roster_type
    row["organizationId"] = str(team["id"] if team["level"] == "MLB" else team.get("parentOrganizationId") or "") or None
    row["availability"] = canonical_availability(row.get("status"))
    return row


def assignment_score(row: dict) -> tuple:
    level = row.get("level")
    status = row.get("availability")
    roster_type = row.get("rosterType")
    # Actual current assignment beats bookkeeping appearances on MLB 40-man.
    if level == "MLB" and roster_type == "active" and status == ACTIVE:
        bucket = 100
    elif level != "MLB" and status == ACTIVE:
        bucket = 90
    elif status == REHAB and level != "MLB":
        bucket = 85
    elif status in {DEVELOPMENT_LIST, RESTRICTED, TEMP_INACTIVE, ADMIN_LEAVE, NOT_REPORTED} and level != "MLB":
        bucket = 75
    elif status in {INJURED_SHORT, INJURED_60, INJURED_FULL_SEASON}:
        bucket = 70
    elif roster_type == "fullRoster" and level != "MLB":
        bucket = 60
    elif roster_type == "40Man":
        bucket = 40
    else:
        bucket = 30
    return (bucket, legacy.LEVEL_RANK.get(level, 0), str(row.get("teamId") or ""))


def canonicalize_roster(observations: list[dict], team_by_id: dict[str, dict]) -> tuple[list[dict], list[dict]]:
    by_player: dict[str, list[dict]] = defaultdict(list)
    for row in observations:
        if row.get("id"):
            by_player[str(row["id"])].append(row)

    players, report = [], []
    for player_id, rows in by_player.items():
        selected = sorted(rows, key=assignment_score, reverse=True)[0]
        mlb_rows = [r for r in rows if r.get("level") == "MLB"]
        active_mlb = [r for r in mlb_rows if r.get("rosterType") == "active" and r.get("availability") == ACTIVE]
        injury_rows = [r for r in rows if r.get("availability") in {INJURED_SHORT, INJURED_60, INJURED_FULL_SEASON}]
        rehab_rows = [r for r in rows if r.get("availability") == REHAB]
        minor_active = [r for r in rows if r.get("level") != "MLB" and r.get("availability") == ACTIVE]

        org_candidates = [r.get("organizationId") for r in rows if r.get("organizationId")]
        organization_id = next((x for x in org_candidates if x), None)
        if active_mlb:
            availability = ACTIVE
        elif rehab_rows:
            availability = REHAB
        elif minor_active:
            availability = ACTIVE
        elif injury_rows:
            # Prefer the longest explicit IL designation when duplicate evidence differs.
            order = {INJURED_FULL_SEASON: 3, INJURED_60: 2, INJURED_SHORT: 1}
            availability = max((r["availability"] for r in injury_rows), key=lambda x: order[x])
        else:
            availability = selected.get("availability") or UNKNOWN

        injury_list_type = None
        if injury_rows:
            injury_list_type = sorted(injury_rows, key=assignment_score, reverse=True)[0].get("status")

        evidence = [{
            "teamId": r.get("teamId"), "level": r.get("level"), "status": r.get("status"),
            "availability": r.get("availability"), "rosterType": r.get("rosterType")
        } for r in sorted(rows, key=assignment_score, reverse=True)]

        player = {
            "id": player_id,
            "fullName": selected.get("fullName") or f"Player {player_id}",
            "organizationId": organization_id,
            "assignedTeamId": selected.get("teamId"),
            "assignedLevel": selected.get("level"),
            "rosterStatus": selected.get("status") or "UNKNOWN",
            "availability": availability,
            "on40Man": any(r.get("level") == "MLB" and r.get("rosterType") in {"active", "40Man"} for r in rows),
            "mlbActive": bool(active_mlb),
            "injuryListType": injury_list_type,
            "eligibleReturnDate": None,
            "rookieEligibility": None,
            "position": selected.get("position") or "UNK",
            "positions": [{"position": selected.get("position") or "UNK", "games": None, "innings": None, "starts": None, "seasons": []}],
            "birthDate": selected.get("birthDate"), "age": selected.get("age"), "bats": selected.get("bats"), "throws": selected.get("throws"),
            "height": selected.get("height"), "weight": selected.get("weight"), "mlbDebutDate": selected.get("mlbDebutDate"),
            "active": any(r.get("active", True) is not False for r in rows), "publicScouting": None,
            "rosterEvidence": evidence, "sourceId": "mlb_stats_rosters_v2",
            # Compatibility aliases for the staged v50 runtime.
            "teamId": selected.get("teamId"), "level": selected.get("level"), "status": selected.get("status") or "UNKNOWN",
        }
        players.append(player)
        if len(rows) > 1:
            report.append({"playerId": player_id, "fullName": player["fullName"], "canonical": {
                "organizationId": organization_id, "assignedTeamId": player["assignedTeamId"], "assignedLevel": player["assignedLevel"],
                "availability": availability, "on40Man": player["on40Man"], "mlbActive": player["mlbActive"]
            }, "evidence": evidence})

    players.sort(key=lambda r: (-legacy.LEVEL_RANK.get(r["assignedLevel"], 0), str(r.get("assignedTeamId") or ""), r["id"]))
    return players, report


def stat_sample(group: str, values: dict) -> dict:
    if group == "hitting":
        return {"plateAppearances": values.get("plateAppearances", values.get("atBats", 0))}
    if group == "pitching":
        return {"battersFaced": values.get("battersFaced", 0), "inningsPitched": values.get("inningsPitched")}
    if group == "fielding":
        return {"chances": values.get("chances", 0), "games": values.get("gamesPlayed", values.get("games", 0))}
    return {}


def stat_rows_v2(raw: dict, sport_id: int, group: str, season: int, fallback_team_id: str | None = None) -> list[dict]:
    rows = []
    for block in raw.get("stats") or []:
        for split in block.get("splits") or []:
            person = split.get("player") or split.get("person") or {}
            if person.get("id") is None:
                continue
            values = dict(split.get("stat") or {})
            rows.append({
                "playerId": str(person.get("id")), "teamId": legacy.text((split.get("team") or {}).get("id") or fallback_team_id),
                "level": legacy.SPORT_LEVELS[sport_id], "season": int(split.get("season") or season), "group": group,
                "gameType": split.get("gameType") or "R", "position": (split.get("position") or {}).get("abbreviation") or (split.get("position") or {}).get("code"),
                "splitContext": {"type": "TOTAL"}, "values": values, "sample": stat_sample(group, values),
                "sourceId": f"mlb_stats_stats_{season}_sport_{sport_id}",
            })
    return rows


def innings_float(value) -> float:
    if value is None or value == "":
        return 0.0
    text = str(value)
    if "." not in text:
        try: return float(text)
        except ValueError: return 0.0
    whole, frac = text.split(".", 1)
    try: return float(whole) + min(2, max(0, int(frac[:1] or "0"))) / 3.0
    except ValueError: return 0.0


def apply_position_experience(players: list[dict], stats: list[dict]) -> None:
    by_player: dict[str, dict[str, dict]] = defaultdict(lambda: defaultdict(lambda: {"games": 0.0, "starts": 0.0, "innings": 0.0, "seasons": set()}))
    for row in stats:
        if row.get("group") != "fielding" or not row.get("position"):
            continue
        pos = str(row["position"]).upper()
        v = row.get("values") or {}
        bucket = by_player[str(row["playerId"])][pos]
        bucket["games"] += float(v.get("gamesPlayed", v.get("games", 0)) or 0)
        bucket["starts"] += float(v.get("gamesStarted", v.get("starts", 0)) or 0)
        bucket["innings"] += innings_float(v.get("innings"))
        bucket["seasons"].add(int(row["season"]))
    for player in players:
        rows = []
        for pos, b in by_player.get(str(player["id"]), {}).items():
            rows.append({"position": pos, "games": int(b["games"]), "starts": int(b["starts"]), "innings": round(b["innings"], 1), "seasons": sorted(b["seasons"], reverse=True)})
        rows.sort(key=lambda r: (-r["innings"], -r["games"], r["position"]))
        if not rows:
            rows = player["positions"]
        player["positions"] = rows
        if rows and player.get("position") in {None, "UNK"}:
            player["position"] = rows[0]["position"]


def source_catalog(retrieved_at: str) -> list[dict]:
    return [
        {"id": "mlb_stats_teams", "name": "MLB Stats API — teams/affiliates", "url": f"{legacy.BASE}/teams", "retrievedAt": retrieved_at, "notes": f"season={SEASON}; current organizations"},
        {"id": "mlb_stats_rosters_v2", "name": "MLB Stats API — roster ownership and availability", "url": f"{legacy.BASE}/teams/{{teamId}}/roster", "retrievedAt": retrieved_at, "notes": "MLB active+40Man+fullRoster; MiLB fullRoster; canonicalized by MLBAM id"},
        {"id": "mlb_stats_stats_history_v2", "name": "MLB Stats API — standard player stats history", "url": f"{legacy.BASE}/stats", "retrievedAt": retrieved_at, "notes": f"seasons={','.join(map(str,HISTORY_SEASONS))}; teamId-filtered collection preserves same-level trades plus multi-level segments"},
        {"id": "mlb_stats_schedule", "name": "MLB Stats API — schedules", "url": f"{legacy.BASE}/schedule", "retrievedAt": retrieved_at, "notes": f"season={SEASON}; gameTypes=R"},
        {"id": "mlb_stats_venues", "name": "MLB Stats API — venue field geometry", "url": f"{legacy.BASE}/venues/{{venueId}}", "retrievedAt": retrieved_at, "notes": f"season={SEASON}; MLB home venues"},
    ]


def self_test() -> None:
    teams = {
        "117": {"id": "117", "level": "MLB", "parentOrganizationId": "117"},
        "543": {"id": "543", "level": "AAA", "parentOrganizationId": "117"},
    }
    base = {"id": "1", "fullName": "Test Player", "position": "SS", "birthDate": "2000-01-01", "age": 26, "bats": "R", "throws": "R", "height": "6'0\"", "weight": 190, "mlbDebutDate": "2025-01-01", "active": True}
    obs = [
        {**base, "teamId": "117", "level": "MLB", "status": "40 Man", "rosterType": "40Man", "organizationId": "117", "availability": UNKNOWN},
        {**base, "teamId": "543", "level": "AAA", "status": "Active", "rosterType": "fullRoster", "organizationId": "117", "availability": ACTIVE},
    ]
    players, _ = canonicalize_roster(obs, teams)
    p = players[0]
    assert p["organizationId"] == "117" and p["assignedTeamId"] == "543" and p["on40Man"] and not p["mlbActive"] and p["availability"] == ACTIVE
    rehab = [
        {**base, "teamId": "117", "level": "MLB", "status": "Injured 60-Day", "rosterType": "fullRoster", "organizationId": "117", "availability": INJURED_60},
        {**base, "teamId": "543", "level": "AAA", "status": "Rehab Assignment", "rosterType": "fullRoster", "organizationId": "117", "availability": REHAB},
    ]
    p2 = canonicalize_roster(rehab, teams)[0][0]
    assert p2["assignedTeamId"] == "543" and p2["availability"] == REHAB and p2["injuryListType"] == "Injured 60-Day"

    # Team-filtered stat calls must keep same-level trade segments distinct even
    # when the response omits split.team and we have to use the requested teamId.
    stat_raw = {"stats": [{"splits": [{"season": "2026", "player": {"id": 1}, "stat": {"plateAppearances": 50, "hits": 12}}]}]}
    a = stat_rows_v2(stat_raw, 11, "hitting", 2026, fallback_team_id="100")
    b = stat_rows_v2(stat_raw, 11, "hitting", 2026, fallback_team_id="200")
    assert a[0]["teamId"] == "100" and b[0]["teamId"] == "200" and a[0]["level"] == b[0]["level"] == "AAA"
    print("SNAPSHOT_V2_SELF_TEST_PASS")


def main() -> None:
    if "--self-test" in sys.argv:
        self_test(); return

    retrieved_at = datetime.now(timezone.utc).isoformat()
    snapshot_date = retrieved_at[:10]
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"[TCU v2] season={SEASON} history={HISTORY_SEASONS} snapshotDate={snapshot_date}")

    teams = []
    for sport_id, level in legacy.SPORT_LEVELS.items():
        raw = legacy.get_json("/teams", {"sportId": sport_id, "season": SEASON, "hydrate": "parentOrg"})
        rows = [legacy.team_row(t, sport_id) for t in (raw.get("teams") or []) if t.get("active", True)]
        teams.extend(rows); print(f"[TCU v2] teams {level}: {len(rows)}")
    team_by_id = {str(t["id"]): t for t in teams}

    affiliations = legacy.resolve_missing_affiliations(teams, legacy.affiliation_rows_from_teams(teams))
    affiliations = legacy.unique_by(affiliations, lambda r: (r["organizationId"], r["level"]))

    observations = []
    for i, team in enumerate(teams, 1):
        sport_id = next(sid for sid, lvl in legacy.SPORT_LEVELS.items() if lvl == team["level"])
        roster_types = MLB_ROSTER_TYPES if team["level"] == "MLB" else MINOR_ROSTER_TYPES
        for roster_type in roster_types:
            try:
                raw = legacy.get_json(f"/teams/{team['id']}/roster", {"rosterType": roster_type, "season": SEASON, "hydrate": "person"})
            except Exception as exc:
                # fullRoster/40Man behavior can vary; active is mandatory for MLB,
                # fullRoster is mandatory for MiLB. Optional evidence failures are logged.
                mandatory = (team["level"] == "MLB" and roster_type == "active") or (team["level"] != "MLB" and roster_type == "fullRoster")
                if mandatory: raise
                print(f"[TCU v2] optional roster source unavailable team={team['id']} type={roster_type}: {exc}")
                continue
            observations.extend(roster_observation(entry, team, sport_id, roster_type) for entry in (raw.get("roster") or []))
            time.sleep(0.02)
        if i % 20 == 0 or i == len(teams): print(f"  roster teams {i}/{len(teams)} observations={len(observations)}")

    players, duplicate_report = canonicalize_roster(observations, team_by_id)
    player_ids = {str(p["id"]) for p in players}
    print(f"[TCU v2] canonical players={len(players)} multi-source={len(duplicate_report)}")

    # Preserve same-level team segments. A sport-wide season query can collapse a
    # traded player's two clubs into one aggregate row, so Phase A collects the
    # same stat endpoint with teamId filters for every team that existed in that
    # season. Multi-level segments remain naturally separate by sportId.
    stats = []
    stat_sleep = float(os.environ.get("TCU_STATS_SLEEP", "0.015"))
    for stat_season in HISTORY_SEASONS:
        for sport_id, level in legacy.SPORT_LEVELS.items():
            team_raw = legacy.get_json("/teams", {"sportId": sport_id, "season": stat_season})
            historical_team_ids = [str(t["id"]) for t in (team_raw.get("teams") or []) if t.get("id") is not None]
            level_count = 0
            for team_index, team_id in enumerate(historical_team_ids, 1):
                for group in ("hitting", "pitching", "fielding"):
                    raw = legacy.get_json("/stats", {
                        "stats": "season", "group": group, "season": stat_season, "sportIds": sport_id,
                        "teamId": team_id, "playerPool": "ALL", "limit": 5000, "hydrate": "team"
                    })
                    rows = [r for r in stat_rows_v2(raw, sport_id, group, stat_season, fallback_team_id=team_id) if r["playerId"] in player_ids]
                    stats.extend(rows); level_count += len(rows)
                    if stat_sleep > 0: time.sleep(stat_sleep)
                if team_index % 25 == 0 or team_index == len(historical_team_ids):
                    print(f"  stats {stat_season} {level}: teams {team_index}/{len(historical_team_ids)} rows={level_count}")
    stats = legacy.unique_by(stats, lambda r: (r["playerId"], r["season"], r.get("teamId"), r["level"], r["group"], r.get("gameType"), r.get("position"), json.dumps(r.get("splitContext"), sort_keys=True)))
    apply_position_experience(players, stats)

    schedule = []
    for sport_id, level in legacy.SPORT_LEVELS.items():
        raw = legacy.get_json("/schedule", {"sportId": sport_id, "season": SEASON, "gameTypes": "R"})
        schedule.extend(legacy.schedule_rows(raw, sport_id))
    schedule = legacy.unique_by(schedule, lambda r: r["gamePk"])

    parks = []
    for team in [t for t in teams if t["level"] == "MLB"]:
        raw = legacy.get_json(f"/venues/{team['venueId']}")
        park = legacy.venue_row(raw, team)
        if park: parks.append(park)
    parks = legacy.unique_by(parks, lambda r: r["venueId"])

    metadata = {
        "snapshotId": f"mlb-milb-{SEASON}-{snapshot_date}-v2-production", "snapshotDate": snapshot_date, "season": SEASON,
        "createdAt": retrieved_at, "kind": "REAL_WORLD", "productionReady": True,
        "notes": "Master Snapshot v2 Phase A: canonical ownership/availability + 3-year standard evidence; tracking/pitch arsenal intentionally empty until Phase C."
    }
    core = {
        "schemaVersion": 2, "metadata": metadata, "sources": source_catalog(retrieved_at), "teams": teams, "players": players,
        "affiliations": affiliations, "stats": stats, "schedule": schedule, "parks": parks,
        "tracking": [], "pitchArsenal": [], "availabilityEvents": []
    }
    content_hash = legacy.fnv1a32(legacy.stable(core))
    snapshot = {**core, "metadata": {**metadata, "contentHash": content_hash}}

    OUT.mkdir(parents=True, exist_ok=True)
    snapshot_path = OUT / f"mlb-milb-{SEASON}-production-v2.json"
    snapshot_path.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    (OUT / "roster_canonicalization_v2.json").write_text(json.dumps(duplicate_report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    availability_counts = Counter(p["availability"] for p in players)
    manifest = {
        "schema": "THE_CALL_UP_PRODUCTION_MANIFEST_V3", "snapshotSchema": 2, "season": SEASON, "historySeasons": list(HISTORY_SEASONS),
        "snapshotDate": snapshot_date, "retrievedAtUtc": retrieved_at, "contentHash": content_hash,
        "coverage": {"teams": len(teams), "players": len(players), "statsRows": len(stats), "scheduleGames": len(schedule), "parks": len(parks),
                     "availability": dict(sorted(availability_counts.items())), "on40Man": sum(1 for p in players if p["on40Man"]),
                     "mlbActive": sum(1 for p in players if p["mlbActive"]), "multiSourcePlayers": len(duplicate_report)}
    }
    (OUT / "production_manifest_v2.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("[TCU v2] COMPLETE")
    print(json.dumps(manifest["coverage"], indent=2, ensure_ascii=False))
    print(f"[TCU v2] output={snapshot_path} hash={content_hash}")


if __name__ == "__main__":
    main()
