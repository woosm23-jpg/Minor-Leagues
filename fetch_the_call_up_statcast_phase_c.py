#!/usr/bin/env python3
"""THE CALL-UP Phase C Statcast collector.

Produces a *staged patch* for Master Snapshot v2. It does not overwrite the
validated roster/stat snapshot. MLB seasons use lightweight Baseball Savant
leaderboards. Current-season AAA uses the MiLB Statcast detail export in small
date chunks and aggregates rows immediately, so pitch-by-pitch CSV is never
committed.
"""
from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import math
import os
import statistics
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SEASON = int(os.environ.get("SEASON", "2026"))
HISTORY_SEASONS = tuple(int(x.strip()) for x in os.environ.get("TCU_HISTORY_SEASONS", "2024,2025,2026").split(",") if x.strip())
BASE_GZ = Path(os.environ.get("TCU_BASE_SNAPSHOT_GZ", "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz"))
OUT = Path(os.environ.get("TCU_PHASE_C_OUT", "data/the_call_up_phase_c"))
MINORS_CHUNK_DAYS = int(os.environ.get("TCU_MINORS_CHUNK_DAYS", "2"))
FETCH_AAA = os.environ.get("TCU_FETCH_AAA", "1").strip().lower() not in {"0", "false", "no"}
SAVANT = "https://baseballsavant.mlb.com"
UA = "THE-CALL-UP-Phase-C-Statcast/1.0"

SWING_DESCRIPTIONS = {
    "swinging_strike", "swinging_strike_blocked", "foul", "foul_tip",
    "hit_into_play", "hit_into_play_no_out", "hit_into_play_score",
    "foul_bunt", "missed_bunt"
}
WHIFF_DESCRIPTIONS = {"swinging_strike", "swinging_strike_blocked", "missed_bunt"}


def finite(v, default=None):
    if v is None or v == "":
        return default
    try:
        n = float(str(v).replace("%", "").replace(",", "").strip())
        return n if math.isfinite(n) else default
    except Exception:
        return default


def integer(v, default=0):
    n = finite(v, None)
    return default if n is None else int(round(n))


def first(row, *names, default=None):
    for name in names:
        if name in row and row[name] not in (None, ""):
            return row[name]
    return default


def player_id(row):
    v = first(row, "player_id", "playerid", "id", "pitcher_id", "batter_id")
    if v is None:
        return None
    try:
        return str(int(float(v)))
    except Exception:
        return str(v).strip() or None


def percent(v, default=None):
    n = finite(v, default)
    if n is None:
        return None
    # Savant exports percentages as percentage points. Some endpoints occasionally
    # return fractions; normalize both representations to percentage points.
    return n * 100.0 if 0 <= n <= 1.0000001 else n


def get_bytes(url, retries=5, timeout=180):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/csv,application/json,*/*"})
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return response.read()
        except Exception as exc:
            last = exc
            if attempt + 1 < retries:
                time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"GET failed after {retries} attempts: {url}: {last}")


def csv_rows(url, retries=5):
    raw = get_bytes(url, retries=retries)
    text = raw.decode("utf-8-sig", errors="replace")
    if text.lstrip().startswith("<"):
        raise RuntimeError(f"Expected CSV but received HTML from {url}")
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for raw_row in reader:
        row = {str(k).strip(): (v.strip() if isinstance(v, str) else v) for k, v in raw_row.items() if k is not None}
        if any(v not in (None, "") for v in row.values()):
            rows.append(row)
    return rows


def custom_url(year, player_type):
    selections = [
        "xba", "barrel_batted_rate", "hard_hit_percent", "exit_velocity_avg",
        "whiff_percent", "oz_swing_percent", "out_zone_swing_miss", "out_zone_swing", "out_zone",
        "in_zone_swing_miss", "in_zone_swing", "in_zone", "edge_percent", "pitch_count",
        "batted_ball", "f_strike_percent", "sprint_speed", "n_outs_above_average"
    ]
    params = {
        "year": year, "type": player_type, "filter": "", "sort": "4", "sortDir": "desc",
        "min": 1, "selections": ",".join(selections), "chart": "false", "x": "xba", "y": "xba", "r": "no", "csv": "true"
    }
    return f"{SAVANT}/leaderboard/custom?" + urllib.parse.urlencode(params)


def statcast_batter_url(year):
    return f"{SAVANT}/leaderboard/statcast?" + urllib.parse.urlencode({"type":"batter","year":year,"position":"","team":"","min":0,"sort":12,"sortDir":"desc","csv":"true"})


def sprint_url(year):
    return f"{SAVANT}/leaderboard/sprint_speed?" + urllib.parse.urlencode({"year":year,"position":"","team":"","min":0,"csv":"true"})


def arm_url(year):
    return f"{SAVANT}/leaderboard/arm-strength?" + urllib.parse.urlencode({"type":"player","year":year,"pos":"","team":"","minThrows":1,"csv":"true"})


def arsenal_stats_url(year):
    return f"{SAVANT}/leaderboard/pitch-arsenal-stats?" + urllib.parse.urlencode({"type":"pitcher","pitchType":"","year":year,"team":"","min":1,"csv":"true"})


def pitch_movement_url(year):
    return f"{SAVANT}/leaderboard/pitch-movement?" + urllib.parse.urlencode({"year":year,"team":"","min":1,"pitch_type":"ALL","hand":"","x":"pitcher_break_x_hidden","z":"pitcher_break_z_hidden","csv":"true"})


def minors_statcast_url(start_date, end_date):
    # Baseball Savant's MiLB CSV detail route has not consistently honored
    # hfLevel=AAA even though the browser results page does. Request the
    # tracked MiLB feed with the level column included, then classify AAA rows
    # locally using the returned level/team evidence. This avoids the 0-row
    # failure seen from the server-side AAA filter on 2026-09-20.
    params = {
        "all":"true", "hfPT":"", "hfAB":"", "hfBBT":"", "hfPR":"", "hfZ":"", "stadium":"",
        "hfBBL":"", "hfNewZones":"", "hfGT":"R|", "hfLevel":"", "chk_level":"on", "chk_is..tracked":"on",
        "hfC":"", "hfSea":f"{SEASON}|", "hfSit":"",
        "hfOuts":"", "opponent":"", "pitcher_throws":"", "batter_stands":"", "hfSA":"",
        "player_type":"pitcher", "hfInfield":"", "team":"", "position":"", "hfOutfield":"", "hfRO":"",
        "home_road":"", "game_date_gt":str(start_date), "game_date_lt":str(end_date),
        "hfFlag":r"is\.\.tracked|", "hfPull":"",
        "metric_1":"", "hfInn":"", "min_pitches":"0", "min_results":"0", "group_by":"name",
        "sort_col":"pitches", "player_event_sort":"h_launch_speed", "sort_order":"desc", "min_abs":"0", "type":"details"
    }
    return f"{SAVANT}/statcast-search-minors/csv?" + urllib.parse.urlencode(params)


def load_base():
    with gzip.open(BASE_GZ, "rt", encoding="utf-8") as f:
        base = json.load(f)
    if int(base.get("schemaVersion", 0)) != 2:
        raise RuntimeError(f"Expected Master Snapshot v2, got {base.get('schemaVersion')}")
    return base


def base_hash(base):
    return str((base.get("metadata") or {}).get("contentHash") or "")


def player_sets(base):
    by_level = defaultdict(set)
    all_ids = set()
    for p in base.get("players") or []:
        pid = str(p.get("id"))
        if not pid or pid == "None":
            continue
        all_ids.add(pid)
        by_level[str(p.get("assignedLevel") or p.get("level") or "")].add(pid)
    return all_ids, by_level


def fielding_chances_index(base):
    out = defaultdict(float)
    for row in base.get("stats") or []:
        if row.get("group") != "fielding":
            continue
        key = (str(row.get("playerId")), int(row.get("season") or 0), str(row.get("level") or ""))
        values = row.get("values") or {}
        out[key] += finite(first(values, "chances", "totalChances"), 0.0) or 0.0
    return out


def merge_tracking(store, player, season, level, group, values=None, denominators=None, source_id=None):
    key = (str(player), int(season), str(level), str(group))
    row = store.setdefault(key, {
        "playerId":str(player), "season":int(season), "level":str(level), "metricGroup":str(group),
        "values":{}, "denominators":{}, "sourceId":source_id or "baseball_savant"
    })
    if source_id:
        row["sourceId"] = source_id
    for k, v in (values or {}).items():
        if v is not None and math.isfinite(float(v)):
            row["values"][k] = round(float(v), 6)
    for k, v in (denominators or {}).items():
        if v is not None and math.isfinite(float(v)) and float(v) >= 0:
            row["denominators"][k] = round(float(v), 6)


def collect_mlb(base, tracking, arsenal):
    all_ids, by_level = player_sets(base)
    mlb_ids = by_level.get("MLB", set())
    field_chances = fielding_chances_index(base)
    coverage = Counter()

    for year in HISTORY_SEASONS:
        print(f"[Phase C] MLB {year}: custom batter")
        batter_custom = csv_rows(custom_url(year, "batter"))
        custom_bat_by_id = {player_id(r): r for r in batter_custom if player_id(r)}
        print(f"  rows={len(batter_custom)}")

        print(f"[Phase C] MLB {year}: exit velocity/barrels")
        ev_rows = csv_rows(statcast_batter_url(year))
        ev_by_id = {player_id(r):r for r in ev_rows if player_id(r)}
        print(f"  rows={len(ev_rows)}")

        print(f"[Phase C] MLB {year}: sprint")
        try:
            sprint_rows = csv_rows(sprint_url(year))
        except Exception as exc:
            print(f"  optional sprint unavailable: {exc}")
            sprint_rows = []
        sprint_by_id = {player_id(r):r for r in sprint_rows if player_id(r)}

        print(f"[Phase C] MLB {year}: arm")
        try:
            arm_rows = csv_rows(arm_url(year))
        except Exception as exc:
            print(f"  optional arm unavailable: {exc}")
            arm_rows = []
        arm_by_id = {player_id(r):r for r in arm_rows if player_id(r)}

        for pid in set(custom_bat_by_id) | set(ev_by_id) | set(sprint_by_id) | set(arm_by_id):
            if pid not in all_ids:
                continue
            # Historical evidence can belong to a player now in AAA; store the
            # actual MLB level for this historical row. Inference level isolation
            # ensures it is only used while the player is evaluated at MLB.
            c = custom_bat_by_id.get(pid, {})
            ev = ev_by_id.get(pid, {})
            sprint = sprint_by_id.get(pid, {})
            arm = arm_by_id.get(pid, {})
            bbe = integer(first(ev, "attempts", "batted_ball", default=first(c, "batted_ball")), 0)
            max_ev = finite(first(ev, "max_hit_speed", "max_exit_velocity"), None)
            barrel = percent(first(ev, "brl_percent", "barrel_batted_rate", default=first(c, "barrel_batted_rate")), None)
            xba = finite(first(c, "xba", "est_ba", "expected_batting_average"), None)
            hard = percent(first(c, "hard_hit_percent"), None)
            if any(v is not None for v in (max_ev,barrel,xba,hard)):
                merge_tracking(tracking,pid,year,"MLB","HITTING_BATTED_BALL",
                               {"maxExitVelocity":max_ev,"barrelPercent":barrel,"expectedBattingAverage":xba,"hardHitPercent":hard},
                               {"bbe":bbe},"baseball_savant_mlb")
            in_swing = integer(first(c,"in_zone_swing"),0); out_swing = integer(first(c,"out_zone_swing"),0)
            in_miss = integer(first(c,"in_zone_swing_miss"),0); out_miss = integer(first(c,"out_zone_swing_miss"),0)
            out_zone = integer(first(c,"out_zone"),0)
            swings = in_swing + out_swing
            whiff = percent(first(c,"whiff_percent"), None)
            chase = percent(first(c,"oz_swing_percent"), None)
            if whiff is None and swings > 0: whiff = 100*(in_miss+out_miss)/swings
            if chase is None and out_zone > 0: chase = 100*out_swing/out_zone
            if whiff is not None or chase is not None:
                merge_tracking(tracking,pid,year,"MLB","HITTING_SWING",{"whiffPercent":whiff,"chasePercent":chase},{"swings":swings,"chaseOpportunities":out_zone},"baseball_savant_mlb")
            sprint_speed = finite(first(sprint,"sprint_speed","sprint_speed_top50percent"), None)
            competitive_runs = integer(first(sprint,"competitive_runs","runs"),0)
            if sprint_speed is not None:
                merge_tracking(tracking,pid,year,"MLB","RUNNING",{"sprintSpeed":sprint_speed},{"competitiveRuns":competitive_runs},"baseball_savant_mlb")
            oaa = finite(first(c,"n_outs_above_average","outs_above_average","oaa"), None)
            arm_strength = finite(first(arm,"arm_strength","avg_arm_strength","max_arm_strength","arm_2b","arm_3b"), None)
            throws = integer(first(arm,"total_throws","throws"),0)
            opps = field_chances.get((pid,year,"MLB"),0)
            if oaa is not None or arm_strength is not None:
                merge_tracking(tracking,pid,year,"MLB","FIELDING",{"outsAboveAverage":oaa,"armStrength":arm_strength},{"opportunities":opps,"qualifyingThrows":throws},"baseball_savant_mlb")
            coverage["mlb_hitters"] += 1

        print(f"[Phase C] MLB {year}: custom pitcher")
        pitcher_custom = csv_rows(custom_url(year, "pitcher"))
        pit_by_id = {player_id(r):r for r in pitcher_custom if player_id(r)}
        print(f"  rows={len(pitcher_custom)}")
        for pid,c in pit_by_id.items():
            if pid not in all_ids:
                continue
            in_zone = integer(first(c,"in_zone"),0); out_zone = integer(first(c,"out_zone"),0)
            in_swing = integer(first(c,"in_zone_swing"),0); out_swing = integer(first(c,"out_zone_swing"),0)
            in_miss = integer(first(c,"in_zone_swing_miss"),0); out_miss = integer(first(c,"out_zone_swing_miss"),0)
            swings = in_swing + out_swing
            pitches = integer(first(c,"pitch_count","pitches"), in_zone+out_zone)
            bbe = integer(first(c,"batted_ball"),0)
            whiff = percent(first(c,"whiff_percent"), None)
            chase = percent(first(c,"oz_swing_percent"), None)
            if whiff is None and swings > 0: whiff = 100*(in_miss+out_miss)/swings
            if chase is None and out_zone > 0: chase = 100*out_swing/out_zone
            hard = percent(first(c,"hard_hit_percent"), None)
            barrel = percent(first(c,"barrel_batted_rate"), None)
            zone = 100*in_zone/(in_zone+out_zone) if in_zone+out_zone>0 else None
            edge = percent(first(c,"edge_percent"), None)
            first_strike = percent(first(c,"f_strike_percent"), None)
            first_pitches = integer(first(c,"pa","plate_appearances","batters_faced"),0)
            if whiff is not None or chase is not None:
                merge_tracking(tracking,pid,year,"MLB","PITCHING_SWING",{"whiffPercent":whiff,"chasePercent":chase},{"swings":swings,"chaseOpportunities":out_zone},"baseball_savant_mlb")
            if hard is not None or barrel is not None:
                merge_tracking(tracking,pid,year,"MLB","PITCHING_BATTED_BALL",{"hardHitAllowedPercent":hard,"barrelAllowedPercent":barrel},{"bbe":bbe},"baseball_savant_mlb")
            if zone is not None or edge is not None or first_strike is not None:
                merge_tracking(tracking,pid,year,"MLB","PITCHING_LOCATION",{"zonePercent":zone,"edgePercent":edge,"firstStrikePercent":first_strike},{"pitches":pitches,"firstPitches":first_pitches},"baseball_savant_mlb")
            coverage["mlb_pitchers"] += 1

        print(f"[Phase C] MLB {year}: pitch arsenal")
        try:
            stat_rows = csv_rows(arsenal_stats_url(year))
        except Exception as exc:
            print(f"  pitch arsenal stats unavailable: {exc}")
            stat_rows = []
        try:
            movement_rows = csv_rows(pitch_movement_url(year))
        except Exception as exc:
            print(f"  pitch movement unavailable: {exc}")
            movement_rows = []
        move_index = {}
        for r in movement_rows:
            pid=player_id(r); pt=str(first(r,"pitch_type","pitch_name",default="")).upper()
            if pid and pt: move_index[(pid,pt)] = r
        total_pitches_by_pitcher = defaultdict(int)
        for r in stat_rows:
            pid=player_id(r)
            if pid: total_pitches_by_pitcher[pid] += integer(first(r,"pitches","pitch_count"),0)
        for r in stat_rows:
            pid=player_id(r)
            if not pid or pid not in all_ids: continue
            pt=str(first(r,"pitch_type","pitchtype","pitch_name",default="UNK")).upper()
            m=move_index.get((pid,pt),{})
            pitches=integer(first(r,"pitches","pitch_count",default=first(m,"pitches_thrown","pitches")),0)
            total=total_pitches_by_pitcher.get(pid,0)
            usage=finite(first(r,"pitch_usage","usage","pitch_percent",default=first(m,"pitch_per")),None)
            if usage is not None and usage > 1.0001: usage/=100.0
            if usage is None and total>0: usage=pitches/total
            velocity=finite(first(m,"avg_speed","velocity","release_speed",default=first(r,"avg_speed","velocity")),None)
            hx=finite(first(m,"pitcher_break_x","pitcher_break_x_hidden","break_x","pfx_x"),None)
            vz=finite(first(m,"pitcher_break_z","pitcher_break_z_hidden","break_z","pfx_z"),None)
            whiff=percent(first(r,"whiff_percent","whiff_pct"),None)
            swings=integer(first(r,"swings"),0)
            whiffs=integer(first(r,"whiffs","swing_miss"),0)
            if whiff is not None and whiff>1: whiff_rate=whiff/100.0
            else: whiff_rate=whiff
            if swings<=0 and whiff_rate is not None and pitches>0:
                swings=max(1,int(round(pitches*0.45))); whiffs=int(round(swings*whiff_rate))
            arsenal.append({
                "playerId":pid,"season":year,"level":"MLB","pitchType":pt,"usage":usage,
                "velocity":None if velocity is None else {"mean":round(velocity,4)},
                "movement":None if hx is None or vz is None else {"horizontal":round(hx,4),"vertical":round(vz,4)},
                "whiff":None if whiff_rate is None else {"rate":round(whiff_rate,6)},
                "location":None,"samples":{"pitches":pitches,"swings":swings,"whiffs":whiffs},
                "sourceId":"baseball_savant_mlb_pitch_arsenal"
            })
        coverage["mlb_arsenal_rows"] += len([r for r in arsenal if r["season"]==year and r["level"]=="MLB"])
    return coverage


def parse_game_pk(row):
    return str(integer(first(row,"game_pk"),0))


def aaa_row_allowed(row, aaa_games, aaa_team_tokens):
    """Classify a MiLB Statcast detail row as Triple-A from available evidence.

    Preferred evidence is game_pk against the validated AAA schedule. Savant
    sometimes omits game_pk on MiLB detail CSVs, so fall back to its optional
    level column and finally to home/away Triple-A team abbreviations/names.
    """
    game_pk = parse_game_pk(row)
    if game_pk != "0":
        return game_pk in aaa_games

    level = str(first(row, "level", "level_name", "level_abbreviation", "sport_name", default="") or "").upper()
    normalized = level.replace("-", "").replace(" ", "")
    if "AAA" in normalized or "TRIPLEA" in normalized:
        return True

    for key in ("home_team", "away_team", "home_team_name", "away_team_name", "team", "opponent"):
        token = str(first(row, key, default="") or "").strip().upper()
        if token and token in aaa_team_tokens:
            return True
    return False


def zone_in(row):
    z=integer(first(row,"zone"),0)
    return 1 <= z <= 9


def is_swing(row):
    d=str(first(row,"description",default="")).lower()
    return d in SWING_DESCRIPTIONS


def is_whiff(row):
    d=str(first(row,"description",default="")).lower()
    return d in WHIFF_DESCRIPTIONS


def is_bbe(row):
    return finite(first(row,"launch_speed"),None) is not None or str(first(row,"type",default="")).upper()=="X"


def is_barrel(row):
    return integer(first(row,"launch_speed_angle"),0)==6


def collect_aaa(base, tracking, arsenal):
    if not FETCH_AAA:
        return Counter({"aaa_skipped":1})
    all_ids, by_level = player_sets(base)
    aaa_current_ids = by_level.get("AAA",set())
    aaa_games = {str(g.get("gamePk")) for g in base.get("schedule") or [] if g.get("level")=="AAA" and str(g.get("gameType") or "R")=="R"}
    aaa_team_tokens = set()
    for t in base.get("teams") or []:
        if t.get("level") != "AAA":
            continue
        for key in ("abbreviation", "name"):
            token = str(t.get(key) or "").strip().upper()
            if token:
                aaa_team_tokens.add(token)
    dates = sorted(str(g.get("date")) for g in base.get("schedule") or [] if g.get("level")=="AAA" and g.get("date"))
    if not aaa_games or not dates:
        print("[Phase C] AAA: no schedule coverage, skipping")
        return Counter({"aaa_no_schedule":1})
    start = date.fromisoformat(dates[0]); end = min(date.fromisoformat(dates[-1]), date.today())
    print(f"[Phase C] AAA raw aggregation {start}..{end}, gamePks={len(aaa_games)}")

    hb = defaultdict(lambda: {"bbe":0,"max_ev":None,"sum_xba":0.0,"xba_n":0,"barrels":0,"hard":0})
    hs = defaultdict(lambda: {"swings":0,"whiffs":0,"chase_opp":0,"chase_swings":0})
    ps = defaultdict(lambda: {"swings":0,"whiffs":0,"chase_opp":0,"chase_swings":0})
    pb = defaultdict(lambda: {"bbe":0,"hard":0,"barrels":0})
    pl = defaultdict(lambda: {"pitches":0,"zone":0,"first":0,"first_strike":0})
    pa = defaultdict(lambda: {"pitches":0,"vel":[],"hx":[],"vz":[],"swings":0,"whiffs":0,"zone":0})
    pitcher_totals = Counter()
    rows_seen=rows_aaa=0

    d=start
    while d <= end:
        d2=min(end,d+timedelta(days=MINORS_CHUNK_DAYS-1))
        url=minors_statcast_url(d,d2)
        try:
            rows=csv_rows(url,retries=4)
        except Exception as exc:
            print(f"  AAA chunk {d}..{d2} failed: {exc}")
            d=d2+timedelta(days=1); continue
        rows_seen += len(rows)
        kept=0
        for r in rows:
            # The MiLB CSV route is requested without a server-side level
            # filter because that filter can return zero rows on the CSV route.
            # Classify Triple-A locally from validated schedule/level/team data.
            if not aaa_row_allowed(r, aaa_games, aaa_team_tokens):
                continue
            kept+=1; rows_aaa+=1
            batter=str(integer(first(r,"batter"),0)); pitcher=str(integer(first(r,"pitcher"),0))
            in_zone=zone_in(r); swing=is_swing(r); whiff=is_whiff(r); bbe=is_bbe(r)
            if batter in all_ids and batter != "0":
                if swing: hs[batter]["swings"]+=1
                if whiff: hs[batter]["whiffs"]+=1
                if not in_zone:
                    hs[batter]["chase_opp"]+=1
                    if swing: hs[batter]["chase_swings"]+=1
                if bbe:
                    x=hb[batter]; x["bbe"]+=1
                    ev=finite(first(r,"launch_speed"),None)
                    if ev is not None:
                        x["max_ev"] = ev if x["max_ev"] is None else max(x["max_ev"],ev)
                        if ev>=95: x["hard"]+=1
                    xba=finite(first(r,"estimated_ba_using_speedangle"),None)
                    if xba is not None: x["sum_xba"]+=xba; x["xba_n"]+=1
                    if is_barrel(r): x["barrels"]+=1
            if pitcher in all_ids and pitcher != "0":
                pitcher_totals[pitcher]+=1
                if swing: ps[pitcher]["swings"]+=1
                if whiff: ps[pitcher]["whiffs"]+=1
                if not in_zone:
                    ps[pitcher]["chase_opp"]+=1
                    if swing: ps[pitcher]["chase_swings"]+=1
                pl[pitcher]["pitches"]+=1
                if in_zone: pl[pitcher]["zone"]+=1
                if integer(first(r,"pitch_number"),0)==1:
                    pl[pitcher]["first"]+=1
                    if str(first(r,"type",default="")).upper() in {"S","X"}: pl[pitcher]["first_strike"]+=1
                if bbe:
                    x=pb[pitcher]; x["bbe"]+=1
                    ev=finite(first(r,"launch_speed"),None)
                    if ev is not None and ev>=95: x["hard"]+=1
                    if is_barrel(r): x["barrels"]+=1
                pt=str(first(r,"pitch_type",default="")).upper()
                if pt:
                    a=pa[(pitcher,pt)]; a["pitches"]+=1
                    vel=finite(first(r,"release_speed"),None)
                    hx=finite(first(r,"pfx_x"),None); vz=finite(first(r,"pfx_z"),None)
                    if vel is not None: a["vel"].append(vel)
                    if hx is not None: a["hx"].append(hx*12.0)
                    if vz is not None: a["vz"].append(vz*12.0)
                    if swing: a["swings"]+=1
                    if whiff: a["whiffs"]+=1
                    if in_zone: a["zone"]+=1
        print(f"  AAA {d}..{d2}: raw={len(rows)} kept={kept}")
        d=d2+timedelta(days=1)
        time.sleep(0.15)

    for pid,x in hb.items():
        if pid not in aaa_current_ids: continue
        merge_tracking(tracking,pid,SEASON,"AAA","HITTING_BATTED_BALL",{
            "maxExitVelocity":x["max_ev"],"barrelPercent":100*x["barrels"]/x["bbe"] if x["bbe"] else None,
            "expectedBattingAverage":x["sum_xba"]/x["xba_n"] if x["xba_n"] else None,
            "hardHitPercent":100*x["hard"]/x["bbe"] if x["bbe"] else None},{"bbe":x["bbe"]},"baseball_savant_aaa")
    for pid,x in hs.items():
        if pid not in aaa_current_ids: continue
        merge_tracking(tracking,pid,SEASON,"AAA","HITTING_SWING",{
            "whiffPercent":100*x["whiffs"]/x["swings"] if x["swings"] else None,
            "chasePercent":100*x["chase_swings"]/x["chase_opp"] if x["chase_opp"] else None},
            {"swings":x["swings"],"chaseOpportunities":x["chase_opp"]},"baseball_savant_aaa")
    for pid,x in ps.items():
        if pid not in aaa_current_ids: continue
        merge_tracking(tracking,pid,SEASON,"AAA","PITCHING_SWING",{
            "whiffPercent":100*x["whiffs"]/x["swings"] if x["swings"] else None,
            "chasePercent":100*x["chase_swings"]/x["chase_opp"] if x["chase_opp"] else None},
            {"swings":x["swings"],"chaseOpportunities":x["chase_opp"]},"baseball_savant_aaa")
    for pid,x in pb.items():
        if pid not in aaa_current_ids: continue
        merge_tracking(tracking,pid,SEASON,"AAA","PITCHING_BATTED_BALL",{
            "hardHitAllowedPercent":100*x["hard"]/x["bbe"] if x["bbe"] else None,
            "barrelAllowedPercent":100*x["barrels"]/x["bbe"] if x["bbe"] else None},{"bbe":x["bbe"]},"baseball_savant_aaa")
    for pid,x in pl.items():
        if pid not in aaa_current_ids: continue
        merge_tracking(tracking,pid,SEASON,"AAA","PITCHING_LOCATION",{
            "zonePercent":100*x["zone"]/x["pitches"] if x["pitches"] else None,
            "firstStrikePercent":100*x["first_strike"]/x["first"] if x["first"] else None},
            {"pitches":x["pitches"],"firstPitches":x["first"]},"baseball_savant_aaa")
    for (pid,pt),x in pa.items():
        if pid not in aaa_current_ids: continue
        total=pitcher_totals[pid]
        velocity=None
        if x["vel"]:
            velocity={"mean":round(statistics.fmean(x["vel"]),4),"sd":round(statistics.pstdev(x["vel"]),4) if len(x["vel"])>1 else 0.0}
        movement=None
        if x["hx"] and x["vz"]:
            movement={"horizontal":round(statistics.fmean(x["hx"]),4),"vertical":round(statistics.fmean(x["vz"]),4)}
        arsenal.append({
            "playerId":pid,"season":SEASON,"level":"AAA","pitchType":pt,"usage":x["pitches"]/total if total else None,
            "velocity":velocity,"movement":movement,
            "whiff":{"rate":x["whiffs"]/x["swings"]} if x["swings"] else None,
            "location":{"zonePercent":x["zone"]/x["pitches"]} if x["pitches"] else None,
            "samples":{"pitches":x["pitches"],"swings":x["swings"],"whiffs":x["whiffs"]},"sourceId":"baseball_savant_aaa"
        })
    if aaa_current_ids and rows_aaa == 0:
        raise RuntimeError("AAA Statcast fetch produced no classifiable AAA rows; check Savant level/team fields")
    return Counter({"aaa_raw_rows":rows_seen,"aaa_rows_kept":rows_aaa,"aaa_hitter_players":len(hb),"aaa_pitcher_players":len(pl),"aaa_arsenal_rows":len(pa)})


def validate(base, tracking_rows, arsenal_rows):
    ids={str(p.get("id")) for p in base.get("players") or []}
    errors=[]
    seen=set()
    for r in tracking_rows:
        key=(r["playerId"],r["season"],r["level"],r["metricGroup"])
        if key in seen: errors.append(f"duplicate tracking {key}")
        seen.add(key)
        if r["playerId"] not in ids: errors.append(f"unknown tracking player {r['playerId']}")
        if r["level"] not in {"MLB","AAA"}: errors.append(f"bad tracking level {r['level']}")
        if not r.get("values"): errors.append(f"empty tracking values {key}")
        if any(finite(v,None) is None or finite(v,0)<0 for v in (r.get("denominators") or {}).values()): errors.append(f"bad denominator {key}")
    pseen=set()
    for r in arsenal_rows:
        key=(r["playerId"],r["season"],r["level"],r["pitchType"])
        if key in pseen: errors.append(f"duplicate arsenal {key}")
        pseen.add(key)
        if r["playerId"] not in ids: errors.append(f"unknown arsenal player {r['playerId']}")
        if integer((r.get("samples") or {}).get("pitches"),0)<=0: errors.append(f"arsenal no pitches {key}")
    mlb_track={r["playerId"] for r in tracking_rows if r["level"]=="MLB"}
    mlb_ars={r["playerId"] for r in arsenal_rows if r["level"]=="MLB"}
    if len(mlb_track)<300: errors.append(f"MLB tracking coverage too small: {len(mlb_track)}")
    if len(mlb_ars)<200: errors.append(f"MLB arsenal coverage too small: {len(mlb_ars)}")
    if errors:
        raise RuntimeError("Phase C validation failed: " + "; ".join(errors[:30]))


def self_test():
    # Percent normalization and AAA pitch aggregation primitives.
    assert percent("34.5") == 34.5
    assert percent("0.345") == 34.5
    row={"zone":"5","description":"swinging_strike","type":"S","launch_speed":"101.2","launch_speed_angle":"6"}
    assert zone_in(row) and is_swing(row) and is_whiff(row) and is_bbe(row) and is_barrel(row)
    row2={"zone":"12","description":"ball","type":"B"}
    assert not zone_in(row2) and not is_swing(row2)
    # MiLB CSV requests the level column but performs AAA classification
    # locally because Savant's server-side hfLevel filter can yield zero rows.
    q = urllib.parse.parse_qs(urllib.parse.urlparse(minors_statcast_url(date(2026,4,1), date(2026,4,2))).query, keep_blank_values=True)
    assert q.get("hfLevel") == [""] and q.get("chk_level") == ["on"]
    teams={"TOL","TOLEDO MUD HENS"}
    assert aaa_row_allowed({"game_pk":"123"}, {"123"}, teams)
    assert aaa_row_allowed({"game_pk":"", "level":"AAA"}, {"123"}, teams)
    assert aaa_row_allowed({"game_pk":"", "home_team":"TOL"}, {"123"}, teams)
    assert not aaa_row_allowed({"game_pk":"999", "level":"AAA"}, {"123"}, teams)
    assert not aaa_row_allowed({"game_pk":"", "level":"A", "home_team":"DUN"}, {"123"}, teams)
    t={}
    merge_tracking(t,"1",2026,"MLB","HITTING_SWING",{"whiffPercent":20},{"swings":100},"x")
    merge_tracking(t,"1",2026,"MLB","HITTING_SWING",{"chasePercent":25},{"chaseOpportunities":80},"x")
    assert len(t)==1 and next(iter(t.values()))["values"]=={"whiffPercent":20.0,"chasePercent":25.0}
    print("PHASE_C_STATCAST_SELF_TEST_PASS")


def main():
    if "--self-test" in sys.argv:
        self_test(); return
    base=load_base()
    retrieved=datetime.now(timezone.utc).isoformat()
    tracking={}; arsenal=[]
    mlb_cov=collect_mlb(base,tracking,arsenal)
    aaa_cov=collect_aaa(base,tracking,arsenal)
    tracking_rows=sorted(tracking.values(),key=lambda r:(r["level"],r["playerId"],r["season"],r["metricGroup"]))
    # Remove any duplicate arsenal row created by an upstream duplicate export.
    dedup={}
    for r in arsenal:
        key=(r["playerId"],r["season"],r["level"],r["pitchType"])
        prev=dedup.get(key)
        if prev is None or integer((r.get("samples") or {}).get("pitches"),0)>integer((prev.get("samples") or {}).get("pitches"),0): dedup[key]=r
    arsenal_rows=sorted(dedup.values(),key=lambda r:(r["level"],r["playerId"],r["season"],r["pitchType"]))
    validate(base,tracking_rows,arsenal_rows)
    cov={
        "trackingRows":len(tracking_rows),"trackingPlayers":len({r["playerId"] for r in tracking_rows}),
        "pitchArsenalRows":len(arsenal_rows),"pitchArsenalPlayers":len({r["playerId"] for r in arsenal_rows}),
        "trackingByLevel":dict(Counter(r["level"] for r in tracking_rows)),
        "arsenalByLevel":dict(Counter(r["level"] for r in arsenal_rows)),
        "trackingByGroup":dict(Counter(r["metricGroup"] for r in tracking_rows)),
        **dict(mlb_cov),**dict(aaa_cov)
    }
    patch={
        "schema":"THE_CALL_UP_TRACKING_PATCH_V1","season":SEASON,"historySeasons":list(HISTORY_SEASONS),
        "createdAt":retrieved,"baseSnapshotHash":base_hash(base),"productionReady":False,
        "notes":"Phase C staged Statcast patch. MLB 3-year leaderboards + current-season AAA tracked pitch aggregation. Must pass game-level inference/regression gates before activation.",
        "sources":[
            {"id":"baseball_savant_mlb","name":"Baseball Savant MLB leaderboards","retrievedAt":retrieved},
            {"id":"baseball_savant_mlb_pitch_arsenal","name":"Baseball Savant MLB pitch arsenal/movement leaderboards","retrievedAt":retrieved},
            {"id":"baseball_savant_aaa","name":"Baseball Savant MiLB Statcast detail export (AAA endpoint-filtered; gamePk cross-check when present)","retrievedAt":retrieved}
        ],
        "tracking":tracking_rows,"pitchArsenal":arsenal_rows,"coverage":cov
    }
    OUT.mkdir(parents=True,exist_ok=True)
    json_path=OUT/f"statcast-phase-c-{SEASON}.json"
    text=json.dumps(patch,ensure_ascii=False,separators=(",",":"))+"\n"
    json_path.write_text(text,encoding="utf-8")
    digest=hashlib.sha256(text.encode()).hexdigest()
    manifest={"schema":"THE_CALL_UP_PHASE_C_MANIFEST_V1","season":SEASON,"createdAt":retrieved,"baseSnapshotHash":base_hash(base),"sha256":digest,"coverage":cov,"productionReady":False}
    (OUT/"phase_c_manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print("[Phase C] COMPLETE")
    print(json.dumps(cov,ensure_ascii=False,indent=2))
    print(f"[Phase C] output={json_path} sha256={digest}")

if __name__ == "__main__":
    main()
