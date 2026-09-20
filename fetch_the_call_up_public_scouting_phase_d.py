#!/usr/bin/env python3
"""THE CALL-UP Phase D public scouting collector.

Collects publicly visible 2026 Updated FanGraphs The Board summary/tool grades,
matches them conservatively to Master Snapshot v2 players, and writes a staged
public-scouting patch. This file intentionally does NOT activate/overwrite the
Production snapshot; activation happens only after Phase D/E gates pass.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from bs4 import BeautifulSoup
except Exception as exc:  # pragma: no cover - workflow installs dependency
    BeautifulSoup = None
    _BS4_IMPORT_ERROR = exc
else:
    _BS4_IMPORT_ERROR = None

SEASON = int(os.environ.get("SEASON", "2026"))
BASE_GZ = Path(os.environ.get("TCU_BASE_SNAPSHOT_GZ", "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz"))
OUT_DIR = Path(os.environ.get("TCU_PHASE_D_OUT", "data/the_call_up_phase_d"))
BOARD_SLUG = os.environ.get("TCU_FG_BOARD_SLUG", f"{SEASON}-prospect-list")
FG_BASE = f"https://www.fangraphs.com/prospects/the-board/{BOARD_SLUG}"
REQUEST_DELAY = float(os.environ.get("TCU_PUBLIC_SCOUT_DELAY", "0.22"))

FG_ORGS = [
    "ari","ath","atl","bal","bos","chc","chw","cin","cle","col","det","hou","kcr","laa","lad",
    "mia","mil","min","nym","nyy","phi","pit","sdp","sea","sfg","stl","tbr","tex","tor","wsn"
]
FG_TO_SNAPSHOT_ORG = {
    "ARI":"AZ", "CHW":"CWS", "KCR":"KC", "SDP":"SD", "SFG":"SF", "TBR":"TB", "WSN":"WSH"
}
PITCHER_POS = {"P","SP","RHP","LHP","MIRP","SIRP","RP"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def norm_name(value: Any) -> str:
    text = unicodedata.normalize("NFKD", clean_text(value)).encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"\b(jr|sr|ii|iii|iv)\.?\b", " ", text)
    text = re.sub(r"[^a-z0-9]+", "", text)
    return text


def parse_number(value: Any, default=None):
    text = clean_text(value).replace(",", "")
    if not text:
        return default
    try:
        return float(text)
    except ValueError:
        return default


def parse_int(value: Any, default=None):
    n = parse_number(value, None)
    return default if n is None else int(round(n))


def parse_grade(value: Any):
    raw = clean_text(value)
    if not raw:
        return None
    m = re.fullmatch(r"(20|25|30|35|40|45|50|55|60|65|70|75|80)(\+)?", raw)
    if not m:
        return None
    grade = float(m.group(1)) + (2.5 if m.group(2) else 0.0)
    return {"grade": grade, "raw": raw}


def parse_present_future(value: Any):
    raw = clean_text(value)
    if not raw:
        return None
    if "/" in raw:
        a, b = raw.split("/", 1)
        pa, pb = parse_grade(a), parse_grade(b)
        if not pa and not pb:
            return None
        return {"present": pa["grade"] if pa else None, "future": pb["grade"] if pb else None, "raw": raw}
    grade = parse_grade(raw)
    return None if not grade else {"present": grade["grade"], "future": grade["grade"], "raw": raw}


def normalize_risk(value: Any):
    raw = clean_text(value).upper()
    if raw in {"MED", "MEDIUM"}:
        return "MEDIUM"
    if raw in {"LOW", "HIGH", "EXTREME"}:
        return raw
    return None


def normalize_level(value: Any):
    raw = clean_text(value).upper().replace(" ", "")
    return {"A+":"HIGH_A", "HIGH-A":"HIGH_A", "HIGH_A":"HIGH_A", "A":"A", "AA":"AA", "AAA":"AAA", "MLB":"MLB"}.get(raw, raw or None)


def canonical_header(value: Any) -> str:
    text = clean_text(value)
    text = re.sub(r"\s+", " ", text)
    return text


def fetch_html(url: str, retries: int = 4) -> str:
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; THE-CALL-UP/1.0; +https://github.com/woosm23-jpg/Minor-Leagues)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.8",
    }
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=45) as resp:
                raw = resp.read()
            text = raw.decode("utf-8", errors="replace")
            if "The Board" not in text:
                raise RuntimeError(f"unexpected FanGraphs response: {url}")
            return text
        except Exception as exc:
            last = exc
            if attempt + 1 < retries:
                time.sleep(1.0 + attempt * 1.7)
    raise RuntimeError(f"failed to fetch {url}: {last}")


def extract_table(html: str, required_headers: set[str]) -> list[dict[str, str]]:
    if BeautifulSoup is None:
        raise RuntimeError(f"beautifulsoup4 is required: {_BS4_IMPORT_ERROR}")
    soup = BeautifulSoup(html, "html.parser")
    candidates = []
    for table in soup.find_all("table"):
        header_row = None
        for tr in table.find_all("tr"):
            cells = tr.find_all(["th", "td"])
            labels = [canonical_header(c.get_text(" ", strip=True)) for c in cells]
            if required_headers.issubset(set(labels)):
                header_row = (tr, labels)
                break
        if not header_row:
            continue
        tr0, headers = header_row
        rows = []
        for tr in tr0.find_all_next("tr"):
            if tr.find_parent("table") is not table:
                break
            cells = tr.find_all("td")
            if not cells:
                continue
            vals = [clean_text(c.get_text(" ", strip=True)) for c in cells]
            if len(vals) < len(headers):
                vals += [""] * (len(headers) - len(vals))
            row = dict(zip(headers, vals[:len(headers)]))
            if clean_text(row.get("Name")) and clean_text(row.get("Name")) != "Name":
                rows.append(row)
        if rows:
            candidates.append(rows)
    if not candidates:
        return []
    # Some responsive FanGraphs markup duplicates the same table. Keep the
    # largest representation, then de-duplicate exact player rows.
    rows = max(candidates, key=len)
    out, seen = [], set()
    for row in rows:
        key = (norm_name(row.get("Name")), clean_text(row.get("Org")).upper(), clean_text(row.get("Pos")).upper())
        if not key[0] or key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def parse_update_stamp(html: str):
    if BeautifulSoup is None:
        return None
    text = BeautifulSoup(html, "html.parser").get_text(" ", strip=True)
    m = re.search(r"Updated:\s*([A-Za-z]+,\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s+[AP]M\s+ET)", text)
    return m.group(1) if m else None


def snapshot_org_map(base: dict) -> dict[str, str]:
    out = {}
    for team in base.get("teams") or []:
        if team.get("level") == "MLB":
            out[str(team.get("parentOrganizationId") or team.get("id"))] = str(team.get("abbreviation") or "").upper()
    return out


def position_compatible(source_pos: str, player: dict) -> bool:
    sp = clean_text(source_pos).upper()
    pp = clean_text(player.get("position")).upper()
    if sp in PITCHER_POS:
        return pp == "P"
    if pp == "P":
        return False
    positions = {clean_text(x.get("position")).upper() for x in (player.get("positions") or []) if isinstance(x, dict)}
    if sp in positions or sp == pp:
        return True
    if sp in {"LF","CF","RF"} and (pp in {"LF","CF","RF","OF"} or positions & {"LF","CF","RF","OF"}):
        return True
    if sp in {"2B","3B","SS"} and (pp in {"2B","3B","SS","IF"} or positions & {"2B","3B","SS","IF"}):
        return True
    return False


def candidate_score(row: dict, player: dict) -> float:
    score = 10.0
    age = parse_number(row.get("Age"), None)
    pa = parse_number(player.get("age"), None)
    if age is not None and pa is not None:
        diff = abs(age - pa)
        score += max(-2.0, 2.2 - diff * 1.2)
    if position_compatible(row.get("Pos"), player):
        score += 2.0
    row_level = normalize_level(row.get("Current Level"))
    player_level = normalize_level(player.get("assignedLevel") or player.get("level"))
    if row_level and row_level == player_level:
        score += 1.1
    return score


def match_source_rows(base: dict, source: dict[tuple[str, str], dict]) -> tuple[list[tuple[dict, dict, str, float]], list[dict], list[dict]]:
    org_map = snapshot_org_map(base)
    by_org_name = defaultdict(list)
    by_name = defaultdict(list)
    for p in base.get("players") or []:
        n = norm_name(p.get("fullName"))
        org = org_map.get(str(p.get("organizationId")), "")
        if n:
            by_org_name[(org, n)].append(p)
            by_name[n].append(p)

    matched, unmatched, ambiguous = [], [], []
    for (fg_org, n), row in source.items():
        snap_org = FG_TO_SNAPSHOT_ORG.get(fg_org, fg_org)
        candidates = list(by_org_name.get((snap_org, n), []))
        method = "ORG_NAME"
        if not candidates:
            globals_ = by_name.get(n, [])
            if len(globals_) == 1:
                candidates = list(globals_)
                method = "GLOBAL_NAME"
        if not candidates:
            unmatched.append(row)
            continue
        scored = sorted(((candidate_score(row, p), p) for p in candidates), key=lambda x: (-x[0], str(x[1].get("id"))))
        if len(scored) > 1 and abs(scored[0][0] - scored[1][0]) < 0.35:
            ambiguous.append({"row": row, "candidateIds": [str(x[1].get("id")) for x in scored[:4]], "scores": [round(x[0],3) for x in scored[:4]]})
            continue
        score, player = scored[0]
        matched.append((row, player, method, score))
    return matched, unmatched, ambiguous


def future_tool(raw: Any, confidence="GOOD"):
    pf = parse_present_future(raw)
    if not pf or pf.get("future") is None:
        return None
    return {"future": pf["future"], "present": pf.get("present"), "confidence": confidence, "raw": pf.get("raw")}


def build_public_scouting(row: dict, source_stamp: str | None, retrieved_at: str):
    fv = parse_grade(row.get("FV"))
    risk = normalize_risk(row.get("Risk"))
    kind = row.get("_kind")
    future_tools = {}
    if kind == "POSITION":
        mappings = {
            "contact": "Hit", "power": "Game Pwr", "rawPower": "Raw Pwr",
            "speed": "Spd", "defense": "Fld"
        }
    elif kind == "PITCHER":
        mappings = {
            "fastball":"FB", "slider":"SL", "curveball":"CB", "changeup":"CH", "command":"CMD"
        }
    else:
        mappings = {}
    for key, source_key in mappings.items():
        evidence = future_tool(row.get(source_key))
        if evidence:
            evidence["sourceTool"] = source_key
            future_tools[key] = evidence

    detail_count = len(future_tools)
    confidence = "GOOD" if detail_count else "FAIR"
    fg_org = clean_text(row.get("Org")).upper()
    source_url = f"{FG_BASE}/{'scouting-position' if kind == 'POSITION' else 'scouting-pitching' if kind == 'PITCHER' else 'summary'}?org={fg_org.lower()}"
    result = {
        "schemaVersion": 1,
        "confidence": confidence,
        "futureValue": None if not fv else {"grade": fv["grade"], "raw": fv["raw"], "confidence": confidence},
        "risk": risk,
        "futureTools": future_tools,
        "rank": {
            "top100": parse_int(row.get("Top 100"), None),
            "organization": parse_int(row.get("Org Rk"), None),
        },
        "eta": parse_int(row.get("ETA"), None),
        "sourceLevel": normalize_level(row.get("Current Level")),
        "source": {
            "provider": "FanGraphs",
            "dataset": "The Board 2026 Updated",
            "retrievedAt": retrieved_at,
            "sourceUpdatedAt": source_stamp,
            "url": source_url,
            "organization": fg_org,
        },
    }
    # Omit nulls only at the leaves that are optional; preserve schema shape.
    result["rank"] = {k:v for k,v in result["rank"].items() if v is not None}
    return result


def collect_pages(fetcher=fetch_html):
    summaries, position, pitching = {}, {}, {}
    org_counts = Counter()
    source_stamps = []
    for idx, org in enumerate(FG_ORGS):
        for kind, suffix, required, target in [
            ("SUMMARY", "summary", {"Name","Org","Pos","FV","Risk"}, summaries),
            ("POSITION", "scouting-position", {"Name","Org","Pos","Hit","Game Pwr","FV"}, position),
            ("PITCHER", "scouting-pitching", {"Name","Org","Pos","FB","CMD","FV"}, pitching),
        ]:
            url = f"{FG_BASE}/{suffix}?org={org}"
            html = fetcher(url)
            stamp = parse_update_stamp(html)
            if stamp:
                source_stamps.append(stamp)
            rows = extract_table(html, required)
            for row in rows:
                row["_kind"] = kind
                key = (clean_text(row.get("Org")).upper(), norm_name(row.get("Name")))
                if key[0] and key[1]:
                    target[key] = row
            org_counts[(org.upper(),kind)] = len(rows)
            time.sleep(REQUEST_DELAY)
        print(f"[Phase D] {idx+1:02d}/30 {org.upper()}: summary={org_counts[(org.upper(),'SUMMARY')]} position={org_counts[(org.upper(),'POSITION')]} pitching={org_counts[(org.upper(),'PITCHER')]}")
    return summaries, position, pitching, org_counts, source_stamps


def merge_source_rows(summaries, position, pitching):
    merged = {}
    for key, summary in summaries.items():
        row = dict(summary)
        detail = position.get(key) or pitching.get(key)
        if detail:
            # Summary contributes risk/current level/ETA; detail contributes tools.
            row.update({k:v for k,v in detail.items() if v not in (None, "")})
            for k in ("Risk","Current Level","ETA"):
                if summary.get(k) not in (None, ""):
                    row[k] = summary[k]
        merged[key] = row
    # Detail-only rows are still valid public scouting evidence.
    for source in (position, pitching):
        for key, detail in source.items():
            if key not in merged:
                merged[key] = dict(detail)
    return merged


def load_base(path=BASE_GZ):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        base = json.load(f)
    if int(base.get("schemaVersion") or 0) != 2:
        raise RuntimeError(f"expected Master Snapshot v2, got {base.get('schemaVersion')}")
    return base


def base_hash(base):
    return str((base.get("metadata") or {}).get("contentHash") or "")


def output_payload(base, merged, source_stamps):
    matched, unmatched, ambiguous = match_source_rows(base, merged)
    retrieved = utc_now()
    records = []
    ids = set()
    match_methods = Counter()
    for row, player, method, score in matched:
        pid = str(player.get("id"))
        if pid in ids:
            continue
        ids.add(pid)
        public = build_public_scouting(row, source_stamps[-1] if source_stamps else None, retrieved)
        public["provenance"] = {
            "matchMethod": method,
            "matchScore": round(score,3),
            "sourceName": clean_text(row.get("Name")),
            "sourcePosition": clean_text(row.get("Pos")),
        }
        records.append({"playerId": pid, "publicScouting": public})
        match_methods[method] += 1
    records.sort(key=lambda r: int(r["playerId"]) if r["playerId"].isdigit() else r["playerId"])

    future_tools = sum(len(r["publicScouting"].get("futureTools") or {}) for r in records)
    with_fv = sum(1 for r in records if r["publicScouting"].get("futureValue"))
    with_risk = sum(1 for r in records if r["publicScouting"].get("risk"))
    hitters = sum(1 for r in records if any(k in (r["publicScouting"].get("futureTools") or {}) for k in ["contact","power","speed","defense"]))
    pitchers = sum(1 for r in records if any(k in (r["publicScouting"].get("futureTools") or {}) for k in ["fastball","slider","curveball","changeup","command"]))
    coverage = {
        "sourcePlayers": len(merged), "matchedPlayers": len(records), "unmatchedSourcePlayers": len(unmatched),
        "ambiguousSourcePlayers": len(ambiguous), "futureValuePlayers": with_fv, "riskPlayers": with_risk,
        "futureToolObservations": future_tools, "positionToolPlayers": hitters, "pitcherToolPlayers": pitchers,
        "matchMethods": dict(match_methods),
    }
    payload = {
        "schema": "THE_CALL_UP_PUBLIC_SCOUTING_V1",
        "season": SEASON,
        "createdAt": retrieved,
        "baseSnapshotHash": base_hash(base),
        "source": {"provider":"FanGraphs","dataset":"The Board 2026 Updated","boardSlug":BOARD_SLUG},
        "coverage": coverage,
        "records": records,
        "unmatched": [{"name":clean_text(r.get("Name")),"org":clean_text(r.get("Org")),"pos":clean_text(r.get("Pos")),"fv":clean_text(r.get("FV"))} for r in unmatched[:300]],
        "ambiguous": ambiguous[:100],
    }
    return payload


def safety_gate(payload, org_counts):
    c = payload["coverage"]
    summary_orgs = sum(1 for org in FG_ORGS if org_counts[(org.upper(),"SUMMARY")] > 0)
    if summary_orgs < 28:
        raise RuntimeError(f"public scouting summary coverage too small: {summary_orgs}/30 organizations")
    if c["sourcePlayers"] < 650:
        raise RuntimeError(f"public scouting source coverage too small: {c['sourcePlayers']}")
    if c["matchedPlayers"] < 450:
        raise RuntimeError(f"public scouting matched coverage too small: {c['matchedPlayers']}")
    if c["futureValuePlayers"] < 400:
        raise RuntimeError(f"public scouting FV coverage too small: {c['futureValuePlayers']}")
    if c["futureToolObservations"] < 900:
        raise RuntimeError(f"public scouting tool coverage too small: {c['futureToolObservations']}")
    if c["positionToolPlayers"] < 180 or c["pitcherToolPlayers"] < 180:
        raise RuntimeError(f"public scouting detail coverage too small: hitters={c['positionToolPlayers']} pitchers={c['pitcherToolPlayers']}")
    if c["ambiguousSourcePlayers"] > 40:
        raise RuntimeError(f"too many ambiguous public-scouting matches: {c['ambiguousSourcePlayers']}")


def write_outputs(payload):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()
    data_path = OUT_DIR / f"public-scouting-{SEASON}.json.gz"
    with gzip.open(data_path, "wb", compresslevel=9) as f:
        f.write(raw)
    manifest = {
        "schema":"THE_CALL_UP_PHASE_D_PUBLIC_SCOUTING_MANIFEST_V1",
        "season":SEASON,
        "createdAt":payload["createdAt"],
        "baseSnapshotHash":payload["baseSnapshotHash"],
        "sha256":digest,
        "coverage":payload["coverage"],
        "productionReady":False,
    }
    manifest_path = OUT_DIR / "public_scouting_manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return data_path, manifest_path


def fixture_table(headers, rows):
    th = "".join(f"<th>{x}</th>" for x in headers)
    trs = []
    for row in rows:
        trs.append("<tr>"+"".join(f"<td>{row.get(h,'')}</td>" for h in headers)+"</tr>")
    return "<html><body><h1>The Board</h1><table><tr>"+th+"</tr>"+"".join(trs)+"</table><div>Updated: Wednesday, May 20, 2026 7:31 AM ET</div></body></html>"


def self_test():
    summary_h = ["Top 100","Org Rk","Name","Org","Pos","Current Level","ETA","FV","Risk","Age"]
    position_h = ["Name","Pos","Org","Top 100","Org Rk","Age","Hit","Game Pwr","Raw Pwr","Spd","Fld","FV"]
    pitching_h = ["Name","Pos","Org","Top 100","Org Rk","Age","FB","SL","CB","CH","CMD","FV"]
    summary = fixture_table(summary_h, [
        {"Top 100":"44","Org Rk":"2","Name":"Ralphy Velazquez","Org":"CLE","Pos":"1B","Current Level":"AAA","ETA":"2027","FV":"50","Risk":"High","Age":"19.8"},
        {"Top 100":"51","Org Rk":"4","Name":"Parker Messick","Org":"CLE","Pos":"SP","Current Level":"MLB","ETA":"2026","FV":"50","Risk":"Low","Age":"24.4"},
    ])
    pos = fixture_table(position_h, [{"Name":"Ralphy Velazquez","Pos":"1B","Org":"CLE","Top 100":"44","Org Rk":"2","Age":"19.8","Hit":"35/50","Game Pwr":"40/55","Raw Pwr":"55/60","Spd":"30/30","Fld":"45/50","FV":"50"}])
    pit = fixture_table(pitching_h, [{"Name":"Parker Messick","Pos":"SP","Org":"CLE","Top 100":"51","Org Rk":"4","Age":"24.4","FB":"50/50","SL":"50/50","CB":"50/50","CH":"60/60","CMD":"55/60","FV":"50"}])
    s = extract_table(summary, {"Name","Org","Pos","FV","Risk"})
    h = extract_table(pos, {"Name","Org","Pos","Hit","Game Pwr","FV"})
    p = extract_table(pit, {"Name","Org","Pos","FB","CMD","FV"})
    assert len(s)==2 and len(h)==1 and len(p)==1
    assert parse_present_future("45/60")["future"] == 60
    assert parse_grade("45+")["grade"] == 47.5
    base = {
        "schemaVersion":2,"metadata":{"contentHash":"fnv1a32:test"},
        "teams":[{"id":"114","parentOrganizationId":"114","level":"MLB","abbreviation":"CLE"}],
        "players":[
            {"id":"1","fullName":"Ralphy Velazquez","organizationId":"114","assignedLevel":"AAA","position":"1B","age":20,"positions":[{"position":"1B"}]},
            {"id":"2","fullName":"Parker Messick","organizationId":"114","assignedLevel":"MLB","position":"P","age":24,"positions":[{"position":"P"}]},
        ]
    }
    sm = {(r["Org"],norm_name(r["Name"])):r for r in s}
    hm = {(r["Org"],norm_name(r["Name"])):dict(r,_kind="POSITION") for r in h}
    pm = {(r["Org"],norm_name(r["Name"])):dict(r,_kind="PITCHER") for r in p}
    for r in sm.values(): r["_kind"]="SUMMARY"
    merged = merge_source_rows(sm,hm,pm)
    payload = output_payload(base, merged, ["Wednesday, May 20, 2026 7:31 AM ET"])
    assert payload["coverage"]["matchedPlayers"] == 2
    by = {r["playerId"]:r["publicScouting"] for r in payload["records"]}
    assert by["1"]["futureTools"]["power"]["future"] == 55
    assert by["1"]["risk"] == "HIGH"
    assert by["2"]["futureTools"]["command"]["future"] == 60
    print("PHASE_D_PUBLIC_SCOUTING_SELF_TEST_PASS")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        self_test(); return
    base = load_base()
    summaries, position, pitching, org_counts, source_stamps = collect_pages()
    merged = merge_source_rows(summaries, position, pitching)
    payload = output_payload(base, merged, source_stamps)
    safety_gate(payload, org_counts)
    write_outputs(payload)


if __name__ == "__main__":
    main()
