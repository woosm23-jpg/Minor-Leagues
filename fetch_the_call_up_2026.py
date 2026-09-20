#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, os, sys, time, urllib.parse, urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

SEASON = int(os.environ.get('SEASON', '2026'))
BASE = 'https://statsapi.mlb.com/api/v1'
OUT = Path(os.environ.get('TCU_OUT', 'data/the_call_up_2026'))
UA = 'THE-CALL-UP-v47-production-snapshot/1.0'
LEVELS = {11:'AAA', 12:'AA', 13:'HIGH_A', 14:'A'}

def get_json(path, params=None, retries=4):
    url = BASE + path
    if params:
        url += '?' + urllib.parse.urlencode(params, doseq=True)
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent':UA,'Accept':'application/json'})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:
            last = e
            if attempt + 1 < retries:
                time.sleep(1.5*(attempt+1))
    raise RuntimeError(f'GET failed: {url}: {last}')

def write_json(name, payload):
    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / name
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',',':')) + '\n'
    p.write_text(text, encoding='utf-8')
    return {'file':str(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(text.encode()).hexdigest()}

def team_row(t, sid, level):
    return {
        'id':t.get('id'),'name':t.get('name'),'abbreviation':t.get('abbreviation'),
        'sportId':sid,'level':level,'parentOrgId':t.get('parentOrgId'),'parentOrgName':t.get('parentOrgName'),
        'leagueId':(t.get('league') or {}).get('id'),'leagueName':(t.get('league') or {}).get('name'),
        'divisionId':(t.get('division') or {}).get('id'),'divisionName':(t.get('division') or {}).get('name'),
        'venueId':(t.get('venue') or {}).get('id'),'venueName':(t.get('venue') or {}).get('name'),
        'active':t.get('active',True),'season':SEASON,
    }

def person_row(e, team):
    p=e.get('person') or {}; pos=p.get('primaryPosition') or e.get('position') or {}
    return {
        'playerId':p.get('id'),'fullName':p.get('fullName'),'birthDate':p.get('birthDate'),'currentAge':p.get('currentAge'),
        'mlbDebutDate':p.get('mlbDebutDate'),'active':p.get('active',True),'jerseyNumber':e.get('jerseyNumber'),
        'rosterStatus':(e.get('status') or {}).get('description'),'positionCode':pos.get('code'),'positionName':pos.get('name'),
        'positionAbbreviation':pos.get('abbreviation'),'batSide':(p.get('batSide') or {}).get('code'),
        'pitchHand':(p.get('pitchHand') or {}).get('code'),'teamId':team['id'],'teamName':team['name'],
        'level':team['level'],'sportId':team['sportId'],'parentOrgId':team['parentOrgId'],'parentOrgName':team['parentOrgName'],
        'season':SEASON,
    }

def stat_rows(raw, sid, level, group):
    out=[]
    for b in raw.get('stats') or []:
        for s in b.get('splits') or []:
            out.append({'playerId':(s.get('player') or {}).get('id'),'playerName':(s.get('player') or {}).get('fullName'),
                        'teamId':(s.get('team') or {}).get('id'),'teamName':(s.get('team') or {}).get('name'),
                        'position':(s.get('position') or {}).get('abbreviation'),'level':level,'sportId':sid,'group':group,
                        'gameType':s.get('gameType') or 'R','season':SEASON,'stat':s.get('stat') or {}})
    return out

def schedule_rows(raw, sid, level):
    out=[]
    for d in raw.get('dates') or []:
        for g in d.get('games') or []:
            home=((g.get('teams') or {}).get('home') or {}); away=((g.get('teams') or {}).get('away') or {})
            out.append({'gamePk':g.get('gamePk'),'date':g.get('officialDate') or (g.get('gameDate') or '')[:10],
                        'gameDate':g.get('gameDate'),'gameType':g.get('gameType'),'status':(g.get('status') or {}).get('detailedState'),
                        'homeTeamId':(home.get('team') or {}).get('id'),'homeTeamName':(home.get('team') or {}).get('name'),'homeScore':home.get('score'),
                        'awayTeamId':(away.get('team') or {}).get('id'),'awayTeamName':(away.get('team') or {}).get('name'),'awayScore':away.get('score'),
                        'venueId':(g.get('venue') or {}).get('id'),'venueName':(g.get('venue') or {}).get('name'),
                        'sportId':sid,'level':level,'season':SEASON})
    return out

def main():
    retrieved=datetime.now(timezone.utc).isoformat(); OUT.mkdir(parents=True,exist_ok=True)
    mlb_raw=get_json('/teams',{'sportId':1,'season':SEASON})
    mlb=[{'id':t.get('id'),'name':t.get('name'),'abbreviation':t.get('abbreviation')} for t in mlb_raw.get('teams',[]) if t.get('active',True)]
    mlb_ids={t['id'] for t in mlb}; assert len(mlb_ids)==30, f'MLB org count={len(mlb_ids)}'

    teams=[]
    for sid,level in LEVELS.items():
        raw=get_json('/teams',{'sportId':sid,'season':SEASON,'hydrate':'parentOrg'})
        rows=[team_row(t,sid,level) for t in raw.get('teams',[]) if t.get('active',True)]
        print(level,len(rows)); teams.extend(rows)

    missing=[t for t in teams if not t.get('parentOrgId')]
    if missing:
        amap={}
        for org in mlb:
            raw=get_json('/teams/affiliates',{'teamIds':org['id'],'season':SEASON})
            for t in raw.get('teams',[]): amap[t.get('id')]=(org['id'],org['name'])
        for t in missing:
            if t['id'] in amap: t['parentOrgId'],t['parentOrgName']=amap[t['id']]

    rosters=[]
    for i,t in enumerate(teams,1):
        raw=get_json(f"/teams/{t['id']}/roster",{'rosterType':'fullRoster','season':SEASON,'hydrate':'person'})
        rosters += [person_row(e,t) for e in raw.get('roster',[])]
        if i%20==0 or i==len(teams): print('rosters',i,'/',len(teams),len(rosters))
        time.sleep(0.03)

    stats=[]; stat_counts={}
    for sid,level in LEVELS.items():
        for group in ('hitting','pitching','fielding'):
            raw=get_json('/stats',{'stats':'season','group':group,'season':SEASON,'sportIds':sid,'playerPool':'ALL','limit':5000,'hydrate':'team'})
            rows=stat_rows(raw,sid,level,group); stats+=rows; stat_counts[f'{level}:{group}']=len(rows)
            print(level,group,len(rows))

    schedule=[]
    for sid,level in LEVELS.items():
        raw=get_json('/schedule',{'sportId':sid,'season':SEASON,'gameTypes':'R'})
        rows=schedule_rows(raw,sid,level); schedule+=rows; print(level,'games',len(rows))

    seen=set(); ded=[]
    for r in rosters:
        k=(r.get('playerId'),r.get('teamId'))
        if k not in seen: seen.add(k); ded.append(r)
    rosters=ded

    counts=Counter(t['level'] for t in teams)
    for level in LEVELS.values():
        assert counts[level]==30, f'{level} teams={counts[level]}'
    bad=[t for t in teams if t.get('parentOrgId') not in mlb_ids]
    assert not bad, f'bad parentOrg teams={len(bad)}'
    cov=defaultdict(set)
    for t in teams: cov[t['parentOrgId']].add(t['level'])
    assert len(cov)==30, f'affiliate orgs={len(cov)}'
    expected=set(LEVELS.values())
    missing_cov={org:sorted(expected-found) for org,found in cov.items() if found!=expected}
    assert not missing_cov, f'missing affiliate levels={missing_cov}'
    roster_counts=Counter(r['teamId'] for r in rosters if r.get('playerId'))
    thin={t['id']:roster_counts[t['id']] for t in teams if roster_counts[t['id']]<10}
    assert not thin, f'thin rosters={thin}'
    for level in LEVELS.values():
        assert any(g['level']==level for g in schedule), f'empty schedule {level}'
        for group in ('hitting','pitching','fielding'):
            assert stat_counts.get(f'{level}:{group}',0)>0, f'empty stats {level}/{group}'

    affiliations=[{'organizationId':t['parentOrgId'],'organizationName':t['parentOrgName'],'teamId':t['id'],'teamName':t['name'],'level':t['level'],'season':SEASON} for t in teams]
    files=[]
    for name,payload in [('mlb_organizations.json',mlb),('teams.json',teams),('affiliations.json',affiliations),('rosters.json',rosters),('stats.json',stats),('schedule.json',schedule)]:
        files.append(write_json(name,payload))
    payload={'schema':'THE_CALL_UP_MILB_SOURCE_V1','season':SEASON,'retrievedAtUtc':retrieved,'source':'MLB Stats API','sourceBaseUrl':BASE,
             'levels':LEVELS,'mlbOrganizations':mlb,'teams':teams,'affiliations':affiliations,'rosters':rosters,'stats':stats,'schedule':schedule}
    files.append(write_json('the_call_up_milb_2026.json',payload))
    manifest={'schema':'THE_CALL_UP_MILB_MANIFEST_V1','season':SEASON,'retrievedAtUtc':retrieved,'source':'MLB Stats API',
              'productionCoverage':{'mlbOrganizations':len(mlb_ids),'teamsByLevel':dict(sorted(counts.items())),'affiliateOrganizations':len(cov),
                                    'rosterRows':len(rosters),'uniquePlayers':len({r['playerId'] for r in rosters if r.get('playerId')}),
                                    'statsRows':len(stats),'statsByLevelGroup':dict(sorted(stat_counts.items())),'scheduleGames':len(schedule)},
              'files':files,'validation':'PASS'}
    write_json('manifest.json',manifest)
    print(json.dumps(manifest['productionCoverage'],indent=2,sort_keys=True))

if __name__=='__main__':
    try: main()
    except Exception as e:
        print('[TCU] FAILED:',e,file=sys.stderr); raise
